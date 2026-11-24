// Panneau Agents : un groupe par agent activé dans Orca (ses profils, lancer, modifier), puis les fournisseurs et les formulaires.
// Aucun CSS ni DOM : Orca dessine les composants. Le worker reste le seul écrivain du store.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  env,
  host,
  IconButton,
  Image,
  List,
  ListItem,
  on,
  plugin,
  read,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  update,
  type PanelContext
} from 'orca'
import { agentById, type AgentSpec } from './agents'
import { byName, copy } from './panel-copy'
import { slotShortcut, slotsOf } from './slots'
import { themedIcon } from './icons'
import type { Inventory } from './inventory'
import { openProfileForm, profileForm, renderProfileForm } from './profile-form'
import { openProviderForm, providerForm, renderProviderForm } from './provider-form'
import type { Profile, Provider, Store } from './store'

type WorkspaceContext = { workspaceId?: string } | null

/** Dernier store annoncé par le worker ; null tant qu'il n'a pas répondu. */
const store = atom<Store | null>(null)
/** Pourquoi `store.get` a échoué, le cas échéant. */
const loadError = atom<string | null>(null)
/** Agents que l'utilisateur a activés dans Orca ; null tant que le worker n'a pas répondu. */
const inventory = atom<Inventory | null>(null)
/** Pourquoi la dernière lecture de l'inventaire a échoué, le cas échéant. */
const inventoryError = atom<string | null>(null)
/** Chemins des images proposées pour l'avatar (`avatars/…` puis `agent-icons/…`) ; vide tant que le worker n'a pas répondu. */
const avatars = atom<string[]>([])
/** Workspace au focus : `undefined` tant que l'hôte n'a pas répondu, `null` quand aucun n'est ouvert. */
const workspaceId = atom<string | null | undefined>(undefined)
/** Vrai tant qu'une demande ⟳ attend la sonde du worker : le bouton est alors grisé. */
const refreshing = atom(false)
/** Raison du dernier lancement refusé ; reste affichée jusqu'au prochain lancement ou changement du store. */
const launchFailure = atom<string | null>(null)
/** Agents dont le groupe est replié ; gardé d'une session d'Orca à l'autre, le même pour tous les workspaces. */
const collapsedAgents = atom<string[]>('collapsedAgents', [], { persist: 'plugin' })

function toggleGroup(agentId: string): void {
  update(collapsedAgents, (ids) => (ids.includes(agentId) ? ids.filter((id) => id !== agentId) : [...ids, agentId]))
}

/** + d'un groupe replié : le groupe se déplie, sinon le profil créé resterait caché une fois enregistré. */
function newProfile(agentId: string): void {
  update(collapsedAgents, (ids) => ids.filter((id) => id !== agentId))
  openProfileForm(agentId, null)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function applyContext(context: WorkspaceContext): void {
  set(workspaceId, context?.workspaceId ?? null)
}

async function readContext(): Promise<void> {
  try {
    applyContext(await host.call('workspace.readContext'))
  } catch {
    applyContext(null)
  }
}

async function loadStore(): Promise<void> {
  set(loadError, null)
  try {
    set(store, await plugin.request('store.get'))
  } catch (error) {
    set(loadError, messageOf(error))
  }
}

/** Un inventaire reçu, quelle qu'en soit la voie, efface l'échec de détection précédent. */
function applyInventory(next: Inventory): void {
  set(inventory, next)
  set(inventoryError, null)
}

async function loadInventory(request: 'agents.list' | 'agents.refresh'): Promise<void> {
  set(inventoryError, null)
  try {
    applyInventory(await plugin.request(request))
  } catch (error) {
    set(inventoryError, messageOf(error))
  }
}

async function refreshInventory(): Promise<void> {
  set(refreshing, true)
  try {
    await loadInventory('agents.refresh')
  } finally {
    set(refreshing, false)
  }
}

function applyStore(next: Store): void {
  set(store, next)
  set(launchFailure, null)
}

async function runLaunch(request: Promise<{ ok: true } | { ok: false; reason: string }>): Promise<void> {
  set(launchFailure, null)
  try {
    const result = await request
    if (!result.ok) set(launchFailure, result.reason)
  } catch (error) {
    set(launchFailure, messageOf(error))
  }
}

const launch = (profile: Profile): Promise<void> => runLaunch(plugin.request('profile.launch', { profileId: profile.id }))

/** Tourne une fois avant le premier rendu ; ce qui est poussé dans `subscriptions` s'arrête avec le panneau. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('store.changed', applyStore))
  ctx.subscriptions.push(plugin.on('agents.changed', applyInventory))
  ctx.subscriptions.push(on('workspace.changed', (payload) => applyContext(payload.context)))
  // D'abord : le worker n'a pas de locale, il parle la dernière annoncée (validations, refus du hook, relance).
  // Un échec est sans gravité : le worker garde la dernière langue reçue (l'anglais par défaut), et ses autres
  // réponses échoueraient visiblement s'il était injoignable.
  void plugin.request('locale.set', { locale: env.locale }).catch(() => undefined)
  void readContext()
  void loadStore()
  void loadInventory('agents.list')
  void plugin
    .request('avatars.list')
    .then((answer) => set(avatars, answer.files))
    .catch(() => set(avatars, []))
}

function providerName(current: Store, profile: Profile): string {
  const m = copy()
  return current.providers.find((p) => p.id === profile.providerId)?.name ?? m.unknownProvider
}

/**
 * Largeur de l'emplacement de tête d'un profil, en pixels : avatar et monogramme y tiennent, les noms des profils
 * s'alignent. L'icône d'agent de l'en-tête en prend la moitié (réglé à l'œil par Romain le 15/11).
 */
const LEAD_SLOT_WIDTH = 28
/** Diamètre de la pastille du monogramme : un peu moins que l'emplacement, pour qu'elle n'en touche pas les bords. */
const MONOGRAM_SIZE = LEAD_SLOT_WIDTH - 3

/**
 * Sans avatar, la pastille porte l'initiale du nom ; un nom vide (impossible après validation) n'en dessine pas.
 * Elle est posée sur la surface `card`, l'inverse du fond `muted` du groupe : un Badge prend cette même teinte
 * et disparaîtrait dans le groupe (constaté sur le thème sombre d'Orca le 15/11).
 */
function renderMonogram(name: string) {
  const initial = Array.from(name.trim())[0]
  return initial ? (
    <Box width={MONOGRAM_SIZE} height={MONOGRAM_SIZE} radius="full" background="card" align="center" justify="center">
      <Text size="xs" weight="medium">
        {initial.toUpperCase()}
      </Text>
    </Box>
  ) : null
}

function renderProfileSummary(current: Store, profile: Profile) {
  const summary = [profile.effort, profile.providerId === null ? null : providerName(current, profile)].filter((part) => part !== null).join(' · ')
  return summary === '' ? null : (
    <Text muted size="xs" truncate>
      {summary}
    </Text>
  )
}

function renderProfileRow(current: Store, spec: AgentSpec, profile: Profile, canLaunch: boolean, slot: number | undefined) {
  const m = copy()
  return (
    <Row key={profile.id} justify="between" align="center" gap="sm">
      <Box key={`text-${profile.id}`} grow minWidth={0}>
        <List key={`launch-list-${profile.id}`} label={m.launch(profile.name)}>
          <ListItem key={`launch-${profile.id}`} disabled={!canLaunch} onPress={() => launch(profile)}>
            <Box key={`press-${profile.id}`} direction="row" align="center" gap="sm" minWidth={0}>
              <Box key={`lead-${profile.id}`} width={LEAD_SLOT_WIDTH} shrink={false} align="center" justify="center">
                {profile.avatar ? (
                  <Image src={themedIcon(profile.avatar, env.theme.colorScheme)} alt="" size="xs" rounded />
                ) : (
                  renderMonogram(profile.name)
                )}
              </Box>
              <Box key={`lines-${profile.id}`} grow minWidth={0}>
                <Row align="center" gap="xs">
                  <Text weight="semibold" truncate>
                    {profile.name}
                  </Text>
                  {current.lastProfileId === profile.id ? <Badge tone="accent">{m.lastBadge}</Badge> : null}
                </Row>
                {renderProfileSummary(current, profile)}
              </Box>
            </Box>
          </ListItem>
        </List>
      </Box>
      <Box key={`actions-${profile.id}`} direction="row" align="center" gap="xs" shrink={false}>
        {slot === undefined ? null : (
          <Text muted size="xs">
            {slotShortcut(slot)}
          </Text>
        )}
        <IconButton
          icon="edit"
          label={m.edit(profile.name)}
          variant="ghost"
          tone="neutral"
          size="sm"
          onPress={() => openProfileForm(spec.id, profile)}
        />
      </Box>
    </Row>
  )
}

/**
 * Un groupe : l'en-tête de l'agent (chevron, icône, nom, nouveau profil), puis ses profils par ordre alphabétique,
 * sauf s'il est replié : l'en-tête dit alors combien de profils il cache.
 * Le cadre prend la surface `muted` du thème d'Orca (thèmes personnalisés compris) pour se détacher du fond du volet ;
 * `card` s'y confond sur le thème sombre.
 */
function renderAgentGroup(current: Store, spec: AgentSpec, canLaunch: boolean, collapsed: boolean, slots: Map<string, number>) {
  const m = copy()
  const profiles = current.profiles.filter((profile) => profile.agentId === spec.id).sort((a, b) => byName(a.name, b.name))
  return (
    <Box key={spec.id} border radius="md" padding="sm" gap="sm" background="muted">
      <Row justify="between" align="center" gap="sm">
        {/* Même principe que les lignes de profil : le nom se tronque, le compteur et le + gardent leur taille. */}
        <Box key={`head-${spec.id}`} direction="row" align="center" gap="sm" grow minWidth={0}>
          {/* Convention d'arborescence : chevron vers le bas quand le groupe est ouvert, vers la droite quand il est replié. */}
          <IconButton
            icon={collapsed ? 'next' : 'expand'}
            label={collapsed ? m.expandGroup(spec.label) : m.collapseGroup(spec.label)}
            variant="ghost"
            size="sm"
            onPress={() => toggleGroup(spec.id)}
          />
          <Box key={`lead-agent-${spec.id}`} width={LEAD_SLOT_WIDTH / 2} shrink={false} align="center" justify="center">
            <Image src={themedIcon(spec.icon, env.theme.colorScheme)} alt="" size="xs" />
          </Box>
          <Text weight="semibold" truncate>
            {spec.label}
          </Text>
          {collapsed ? (
            <Box key={`count-${spec.id}`} shrink={false}>
              <Text muted size="xs">
                {m.profileCount(profiles.length)}
              </Text>
            </Box>
          ) : null}
        </Box>
        <Box key={`add-${spec.id}`} shrink={false}>
          <IconButton
            icon="add"
            label={m.newProfileFor(spec.label)}
            variant="ghost"
            size="sm"
            onPress={() => newProfile(spec.id)}
          />
        </Box>
      </Row>
      {collapsed ? null : profiles.length === 0 ? (
        <Text muted size="xs">
          {m.noProfileForAgent}
        </Text>
      ) : (
        profiles.map((profile) => renderProfileRow(current, spec, profile, canLaunch, slots.get(profile.id)))
      )}
    </Box>
  )
}

function renderProviderRow(current: Store, provider: Provider) {
  const m = copy()
  return (
    <Row key={provider.id} justify="between" align="center" gap="sm">
      <Box key={`text-${provider.id}`} grow minWidth={0}>
        <Text weight="semibold" truncate>
          {provider.name}
        </Text>
        <Text muted size="xs" truncate>
          {provider.baseUrl}
        </Text>
      </Box>
      <Box key={`actions-${provider.id}`} shrink={false}>
        <IconButton
          icon="edit"
          label={m.edit(provider.name)}
          variant="ghost"
          size="sm"
          onPress={() => openProviderForm(current, provider)}
        />
      </Box>
    </Row>
  )
}

function renderProviders(current: Store) {
  const m = copy()
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Text weight="semibold">{m.tabProviders}</Text>
        <IconButton icon="add" label={m.newProvider} variant="ghost" size="sm" onPress={() => openProviderForm(current, null)} />
      </Row>
      {current.providers.length === 0 ? (
        <Text muted size="xs">
          {m.noProviderHint}
        </Text>
      ) : (
        current.providers.map((provider) => renderProviderRow(current, provider))
      )}
    </Stack>
  )
}

function renderGroups(current: Store, agents: Inventory | null, canLaunch: boolean) {
  const m = copy()
  if (agents === null) {
    return read(inventoryError) === null ? <Skeleton lines={3} label={m.detectingAgents} /> : null
  }
  // L'inventaire suit l'ordre du catalogue d'Orca ; le volet, lui, range les groupes par ordre alphabétique.
  const specs = agents.agents.flatMap((id) => agentById(id) ?? []).sort((a, b) => byName(a.label, b.label))
  if (specs.length === 0) return <EmptyState icon="bot" title={m.noAgentTitle} description={m.noAgentHint} />
  const collapsed = read(collapsedAgents)
  const slots = slotsOf(current, agents.agents, byName)
  return <Stack gap="sm">{specs.map((spec) => renderAgentGroup(current, spec, canLaunch, collapsed.includes(spec.id), slots))}</Stack>
}

export default function Panel() {
  const m = copy()
  const current = read(store)
  const failed = read(loadError)
  if (current === null) {
    if (failed !== null) {
      return (
        <Stack gap="sm">
          <Callout tone="danger" title={m.loadFailedTitle}>
            {failed}
          </Callout>
          <Row>
            <Button variant="outline" onPress={loadStore}>
              {m.retry}
            </Button>
          </Row>
        </Stack>
      )
    }
    return <Skeleton lines={3} label={m.loading} />
  }

  if (read(profileForm) !== null) {
    return renderProfileForm(current, read(avatars), applyStore)
  }
  if (read(providerForm) !== null) {
    return renderProviderForm(applyStore)
  }

  const id = read(workspaceId)
  const agents = read(inventory)
  const detectFailure = read(inventoryError)
  const failure = read(launchFailure)
  return (
    <Stack gap="md">
      <Row justify="end">
        <IconButton
          icon="refresh"
          label={m.refreshAgents}
          variant="ghost"
          size="sm"
          disabled={read(refreshing)}
          onPress={refreshInventory}
        />
      </Row>
      {id === null ? <Callout tone="warning">{m.noWorkspace}</Callout> : null}
      {agents?.settingsReadable === false ? <Callout tone="neutral">{m.settingsUnreadable}</Callout> : null}
      {failure === null ? null : (
        <Callout tone="danger" title={m.launchFailedTitle}>
          {failure}
        </Callout>
      )}
      {detectFailure === null ? null : (
        <Stack gap="sm">
          <Callout tone="danger" title={m.detectFailedTitle}>
            {detectFailure}
          </Callout>
          <Row>
            <Button variant="outline" onPress={() => loadInventory('agents.list')}>
              {m.retry}
            </Button>
          </Row>
        </Stack>
      )}
      {renderGroups(current, agents, typeof id === 'string')}
      <Separator />
      {renderProviders(current)}
    </Stack>
  )
}
