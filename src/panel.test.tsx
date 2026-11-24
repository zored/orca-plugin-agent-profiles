// Le panneau Agents tourne ici avec le vrai runtime d'Orca ; le worker est remplacé par des réponses simulées.
import { assert, mockHost, mount, test } from 'orca/testing'
import { MESSAGES } from './copy'
import type { Inventory } from './inventory'
import * as panel from './panel'
import type { DeleteResult, LaunchResult, SaveResult } from './protocol'
import type { Profile, Provider, Store } from './store'
import { ENABLED, LUNA, OPUS, SAMPLE_STORE } from './test-fixtures'

const COPY = MESSAGES.fr

type Context = { workspaceId: string; branch: string; displayName: string; terminals: [] } | null

const focused: NonNullable<Context> = { workspaceId: 'w1', branch: 'main', displayName: 'w1', terminals: [] }

type Setup = {
  context?: Context
  launch?: (input: { profileId: string }) => LaunchResult
  saveProfile?: (input: { profile: Profile }) => SaveResult
  saveProvider?: (input: { provider: Provider }) => SaveResult
  deleteProvider?: (input: { providerId: string }) => DeleteResult
  deleteProfile?: (input: { profileId: string }) => DeleteResult
  store?: Store
  storeGet?: () => Store
  inventory?: Inventory
  agentsList?: () => Inventory
  agentsRefresh?: () => Inventory | Promise<Inventory>
  avatars?: string[]
  /** Ce qu'une session précédente a mémorisé (atomes `persist: 'plugin'`). */
  persisted?: { plugin?: Record<string, unknown> }
  theme?: 'light' | 'dark'
  /** Langue d'Orca, BCP-47 ; français par défaut ici, la plupart des assertions historiques étant en français. */
  locale?: string
}

async function open(setup: Setup = {}) {
  const state = { context: setup.context === undefined ? focused : setup.context }
  const launches: string[] = []
  const refreshes: number[] = []
  const announcedLocales: string[] = []
  const profileSaves: Profile[] = []
  const providerSaves: Provider[] = []
  const store = setup.store ?? SAMPLE_STORE
  const inventory = setup.inventory ?? ENABLED
  /** Nom de chaque requête reçue par le worker simulé, dans l'ordre d'arrivée. */
  const requestOrder: string[] = []
  const track =
    <I, O>(name: string, handler: (input: I) => O) =>
    (input: I): O => {
      requestOrder.push(name)
      return handler(input)
    }
  const host = mockHost({
    requests: {
      'locale.set': track('locale.set', (input: { locale: string }) => {
        announcedLocales.push(input.locale)
        return { ok: true as const }
      }),
      'store.get': track('store.get', setup.storeGet ?? (() => store)),
      'agents.list': track('agents.list', setup.agentsList ?? (() => inventory)),
      'agents.refresh': track('agents.refresh', () => {
        refreshes.push(1)
        return setup.agentsRefresh ? setup.agentsRefresh() : inventory
      }),
      'avatars.list': track('avatars.list', () => ({ files: setup.avatars ?? ['avatars/deepseek.png', 'avatars/qwen.png'] })),
      'profile.launch': track('profile.launch', (input: { profileId: string }) => {
        launches.push(input.profileId)
        return setup.launch ? setup.launch(input) : { ok: true as const }
      }),
      'profile.save': track('profile.save', (input: { profile: Profile }) => {
        profileSaves.push(input.profile)
        return setup.saveProfile ? setup.saveProfile(input) : { ok: true as const, store }
      }),
      'provider.save': track('provider.save', (input: { provider: Provider }) => {
        providerSaves.push(input.provider)
        return setup.saveProvider ? setup.saveProvider(input) : { ok: true as const, store }
      }),
      'profile.delete': track('profile.delete', setup.deleteProfile ?? (() => ({ ok: true as const, store }))),
      'provider.delete': track('provider.delete', setup.deleteProvider ?? (() => ({ ok: true as const, store })))
    },
    results: { 'workspace.readContext': () => state.context }
  })
  const view = await mount(panel, { host, persisted: setup.persisted, theme: setup.theme, locale: setup.locale ?? 'fr-FR' })
  return { view, state, launches, refreshes, announcedLocales, requestOrder, profileSaves, providerSaves }
}

type View = Awaited<ReturnType<typeof open>>['view']

async function expectClean(view: View): Promise<void> {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
}

/** Valeurs des options d'un Select du formulaire. */
function optionValues(view: View, label: string): string[] {
  const options = view.find({ label })!.props.options as { value: string }[]
  return options.map((option) => option.value)
}

test('shows one group per enabled agent, in alphabetical order whatever the inventory order', async () => {
  // ENABLED suit l'ordre du catalogue d'Orca (Claude d'abord, Antigravity en dernier).
  const { view } = await open()
  const labels = view.findAll({ type: 'IconButton', label: /^Nouveau profil / }).map((button) => button.label)
  assert.deepEqual(labels, [
    'Nouveau profil Antigravity',
    'Nouveau profil Claude',
    'Nouveau profil Codex',
    'Nouveau profil DeepSeek Harness',
    'Nouveau profil Grok',
    'Nouveau profil OpenCode',
    'Nouveau profil Pi'
  ])
  assert.equal(view.find({ label: 'Nouveau profil Gemini' }), null)
  // Pas de lancement sans profil depuis l'en-tête : retiré en v2.0.2.
  assert.equal(view.find({ label: /sans profil$/ }), null)
  await expectClean(view)
})

test('sorts the profiles of a group by name, ignoring case and accents, numbers in natural order', async () => {
  const names = ['Opus', 'Kimi 10', 'argon', 'Élan', 'Kimi 9', 'DeepSeek 4.1 Flash']
  const store: Store = { ...SAMPLE_STORE, providers: [], profiles: names.map((name) => ({ ...OPUS, id: name, name })) }
  const { view } = await open({ store })
  const labels = view.findAll({ type: 'IconButton', label: /^Modifier / }).map((button) => button.label)
  assert.deepEqual(labels, [
    'Modifier argon',
    'Modifier DeepSeek 4.1 Flash',
    'Modifier Élan',
    'Modifier Kimi 9',
    'Modifier Kimi 10',
    'Modifier Opus'
  ])
  await expectClean(view)
})

test('lists each profile under its agent with model, effort and provider', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ text: /^medium$/ }), null)
  assert.notEqual(view.find({ text: /^Ollama$/ }), null)
  assert.equal(view.find({ text: /gpt-6-luna|deepseek-v4/ }), null)
  await expectClean(view)
})

test('hides the profiles of an agent that is not enabled', async () => {
  assert.notEqual((await open()).view.find({ testId: 'launch-argon' }), null)
  const { view } = await open({ inventory: { ...ENABLED, agents: ENABLED.agents.filter((id) => id !== 'antigravity') } })
  assert.equal(view.find({ testId: 'launch-argon' }), null)
  assert.notEqual(view.find({ testId: 'launch-luna' }), null)
  await expectClean(view)
})

test('shows the unreadable settings notice', async () => {
  const { view } = await open({ inventory: { ...ENABLED, settingsReadable: false } })
  assert.notEqual(view.find({ text: COPY.settingsUnreadable }), null)
  await expectClean(view)
})

test('shows the no-agent state', async () => {
  const { view } = await open({ inventory: { ...ENABLED, agents: [] } })
  assert.notEqual(view.find({ label: COPY.noAgentTitle }), null)
  await expectClean(view)
})

test('shows why the inventory could not be read and retries', async () => {
  let attempts = 0
  const { view } = await open({
    agentsList: () => {
      attempts += 1
      if (attempts === 1) throw new Error('sonde injoignable')
      return ENABLED
    }
  })
  assert.notEqual(view.find({ text: /sonde injoignable/ }), null)
  assert.notEqual(view.find({ label: COPY.detectFailedTitle }), null)
  await view.press({ text: COPY.retry })
  assert.notEqual(view.find({ label: 'Nouveau profil Claude' }), null)
  await expectClean(view)
})

test('agents.changed clears the detection failure and draws the groups', async () => {
  const { view } = await open({
    agentsList: () => {
      throw new Error('sonde injoignable')
    }
  })
  assert.notEqual(view.find({ label: COPY.detectFailedTitle }), null)
  assert.equal(view.find({ label: 'Nouveau profil Claude' }), null)
  await view.post('agents.changed', ENABLED)
  assert.notEqual(view.find({ label: 'Nouveau profil Claude' }), null)
  assert.equal(view.find({ label: COPY.detectFailedTitle }), null)
  assert.equal(view.find({ text: COPY.retry }), null)
  await expectClean(view)
})

test('refresh asks the worker for a fresh inventory, and agents.changed redraws the groups', async () => {
  const { view, refreshes } = await open()
  await view.press({ label: COPY.refreshAgents })
  assert.equal(refreshes.length, 1)
  assert.notEqual(view.find({ label: 'Nouveau profil Grok' }), null)
  await view.post('agents.changed', { ...ENABLED, agents: ENABLED.agents.filter((id) => id !== 'grok') })
  assert.equal(view.find({ label: 'Nouveau profil Grok' }), null)
  await expectClean(view)
})

test('the refresh button is disabled while a refresh is in flight and comes back after the answer', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { view, refreshes } = await open({ agentsRefresh: async () => (await gate, ENABLED) })
  assert.equal(view.find({ label: COPY.refreshAgents })!.disabled, false)
  const pressed = view.press({ label: COPY.refreshAgents })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(view.find({ label: COPY.refreshAgents })!.disabled, true)
  // Un second appui pendant la sonde ne lance pas une seconde détection.
  await assert.rejects(view.press({ label: COPY.refreshAgents }), /disabled/)
  assert.equal(refreshes.length, 1)
  release()
  await pressed
  assert.equal(view.find({ label: COPY.refreshAgents })!.disabled, false)
  await expectClean(view)
})

test('the refresh button comes back when the refresh fails', async () => {
  const { view } = await open({
    agentsRefresh: () => {
      throw new Error('sonde injoignable')
    }
  })
  await view.press({ label: COPY.refreshAgents })
  assert.equal(view.find({ label: COPY.refreshAgents })!.disabled, false)
  assert.notEqual(view.find({ text: /sonde injoignable/ }), null)
  await expectClean(view)
})

test('gives the avatar and the monogram the same fixed leading slot, and the group icon a fixed one', async () => {
  const profiles = SAMPLE_STORE.profiles.map((p) => (p.id === 'opus' ? { ...p, avatar: 'avatars/qwen.png' } : p))
  const { view } = await open({ store: { ...SAMPLE_STORE, profiles } })
  // Les noms des profils s'alignent : avatar et monogramme partagent la même largeur.
  const profileSlots = [view.find({ testId: 'lead-luna' }), view.find({ testId: 'lead-opus' })]
  const groupSlot = view.find({ testId: 'lead-agent-claude' })
  for (const slot of [...profileSlots, groupSlot]) {
    assert.notEqual(slot, null)
    assert.equal(typeof slot!.props.width, 'number')
    assert.equal(slot!.props.shrink, false)
  }
  assert.equal(profileSlots[0]!.props.width, profileSlots[1]!.props.width)
  await expectClean(view)
})

test('folds and unfolds a group from its chevron, and remembers it', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ testId: 'launch-opus' }), null)
  // Chevron vers le bas quand le groupe est ouvert, vers la droite quand il est replié.
  assert.equal(view.find({ label: 'Replier Claude' })!.props.icon, 'expand')
  await view.press({ label: 'Replier Claude' })
  assert.equal(view.find({ label: 'Déplier Claude' })!.props.icon, 'next')
  assert.equal(view.find({ testId: 'launch-opus' }), null)
  assert.equal(view.find({ testId: 'launch-deepseek-flash' }), null)
  // Le groupe replié dit ce qu'il cache ; les autres groupes restent ouverts.
  assert.notEqual(view.find({ text: '2 profils' }), null)
  assert.notEqual(view.find({ testId: 'launch-luna' }), null)
  assert.notEqual(view.find({ label: 'Nouveau profil Claude' }), null)
  assert.deepEqual(view.persisted.plugin.collapsedAgents, ['claude'])

  await view.press({ label: 'Déplier Claude' })
  assert.notEqual(view.find({ testId: 'launch-opus' }), null)
  assert.equal(view.find({ text: '2 profils' }), null)
  assert.deepEqual(view.persisted.plugin.collapsedAgents, [])
  await expectClean(view)
})

test('creating a profile from a folded group unfolds it, so the new profile shows once saved', async () => {
  const { view } = await open({ persisted: { plugin: { collapsedAgents: ['claude', 'codex'] } } })
  await view.press({ label: 'Nouveau profil Claude' })
  assert.deepEqual(view.persisted.plugin.collapsedAgents, ['codex'])
  await expectClean(view)
})

test('a folded group without profiles says so in its header', async () => {
  // Grok seul : son groupe n'a aucun profil, donc la seule mention possible une fois replié est celle de l'en-tête.
  const { view } = await open({ inventory: { ...ENABLED, agents: ['grok'] } })
  await view.press({ label: 'Replier Grok' })
  assert.equal(view.findAll({ text: COPY.noProfileForAgent }).length, 1)
  await expectClean(view)
})

test('opens with the groups folded in an earlier session', async () => {
  const { view } = await open({ persisted: { plugin: { collapsedAgents: ['codex'] } } })
  assert.equal(view.find({ testId: 'launch-luna' }), null)
  assert.notEqual(view.find({ text: '1 profil' }), null)
  assert.notEqual(view.find({ label: 'Déplier Codex' }), null)
  assert.notEqual(view.find({ testId: 'launch-opus' }), null)
  await expectClean(view)
})

test('draws each group on a theme surface, and the monograms on a different one so they stay visible', async () => {
  const { view } = await open()
  const groups = ENABLED.agents.map((id) => view.find({ testId: id }))
  const surfaces = new Set(groups.map((group) => group?.props.background))
  assert.equal(surfaces.size, 1, 'every group uses the same surface')
  const [surface] = surfaces
  assert.ok(surface !== undefined && surface !== 'none', 'groups stand out from the panel background')
  const discs = view.findAll({ type: 'Box' }).filter((box) => box.props.radius === 'full')
  assert.equal(discs.length, SAMPLE_STORE.profiles.filter((profile) => profile.avatar === null).length)
  const slotWidth = view.find({ testId: 'lead-luna' })!.props.width as number
  for (const disc of discs) {
    assert.notEqual(disc.props.background, surface)
    assert.ok((disc.props.width as number) <= slotWidth, 'the disc fits its leading slot')
  }
  await expectClean(view)
})

test('marks the last launched profile', async () => {
  const { view } = await open({ store: { ...SAMPLE_STORE, lastProfileId: 'luna' } })
  assert.equal(view.findAll({ type: 'Badge', text: COPY.lastBadge }).length, 1)
  await expectClean(view)
})

test('shows a monogram when a profile has no avatar, and the avatar image when it has one', async () => {
  const profiles = SAMPLE_STORE.profiles.map((p) => (p.id === 'deepseek-flash' ? { ...p, avatar: null } : p))
  const { view } = await open({ store: { ...SAMPLE_STORE, profiles } })
  assert.equal(view.findAll({ type: 'Text', text: 'D' }).length, 1)
  assert.equal(view.findAll({ type: 'Image' }).filter((image) => String(image.props.src).startsWith('avatars/')).length, 0)

  const withAvatar = await open()
  const avatars = withAvatar.view.findAll({ type: 'Image' }).filter((image) => String(image.props.src).startsWith('avatars/'))
  assert.deepEqual(avatars.map((image) => image.props.src), ['avatars/deepseek.png'])
  await expectClean(view)
  await expectClean(withAvatar.view)
})

test('shows each group header with the icon of its agent', async () => {
  const { view } = await open()
  const icons = view.findAll({ type: 'Image' }).map((image) => image.props.src)
  for (const id of ENABLED.agents) assert.ok(icons.includes(`agent-icons/${id}.png`), `icône de ${id}`)
  await expectClean(view)
})

/** Chemins des images du panneau : en-têtes de groupe (tous) et avatars de profil. */
function imageSources(view: View): string[] {
  return view.findAll({ type: 'Image' }).map((image) => String(image.props.src))
}

/** Codex (en-tête de groupe + avatar d'un profil) et Kilo (idem), pour juger la variante choisie par thème. */
const ICON_STORE: Store = {
  ...SAMPLE_STORE,
  profiles: [
    { ...LUNA, avatar: 'agent-icons/codex.png' },
    { ...LUNA, id: 'kilo-profile', agentId: 'kilo', name: 'Kilo profile', avatar: 'agent-icons/kilo.png' }
  ]
}
const ICON_INVENTORY: Inventory = { ...ENABLED, agents: ['claude', 'codex', 'kilo'] }

test('in the light theme, Codex uses its light-theme variant for the group header and the profile avatar, and Kilo keeps its base icon', async () => {
  const { view } = await open({ theme: 'light', store: ICON_STORE, inventory: ICON_INVENTORY })
  const sources = imageSources(view)
  assert.equal(sources.filter((src) => src === 'agent-icons/on-light/codex.png').length, 2, 'group header and avatar')
  assert.ok(!sources.includes('agent-icons/codex.png'))
  assert.equal(sources.filter((src) => src === 'agent-icons/kilo.png').length, 2, 'group header and avatar')
  assert.ok(!sources.some((src) => src.includes('on-dark')))
  assert.ok(sources.includes('agent-icons/claude.png'), 'an icon without variant stays the base one')
  await expectClean(view)
})

test('in the dark theme, Kilo uses its dark-theme variant for the group header and the profile avatar, and Codex keeps its base icon', async () => {
  const { view } = await open({ theme: 'dark', store: ICON_STORE, inventory: ICON_INVENTORY })
  const sources = imageSources(view)
  assert.equal(sources.filter((src) => src === 'agent-icons/on-dark/kilo.png').length, 2, 'group header and avatar')
  assert.ok(!sources.includes('agent-icons/kilo.png'))
  assert.equal(sources.filter((src) => src === 'agent-icons/codex.png').length, 2, 'group header and avatar')
  assert.ok(!sources.some((src) => src.includes('on-light')))
  await expectClean(view)
})

/** Deux avatars livrés (Ollama, Kimi) ont un glyphe blanc : variante `avatars/on-light/` en thème clair seulement. */
const AVATAR_STORE: Store = {
  ...SAMPLE_STORE,
  profiles: [
    { ...OPUS, avatar: 'avatars/ollama.png' },
    { ...OPUS, id: 'kimi-profile', name: 'Kimi profile', avatar: 'avatars/kimi.png' },
    { ...OPUS, id: 'qwen-profile', name: 'Qwen profile', avatar: 'avatars/qwen.png' }
  ]
}

test('in the light theme, the Ollama and Kimi avatars use their light-theme variant and the others stay as they are', async () => {
  const { view } = await open({ theme: 'light', store: AVATAR_STORE })
  const sources = imageSources(view)
  assert.ok(sources.includes('avatars/on-light/ollama.png'))
  assert.ok(sources.includes('avatars/on-light/kimi.png'))
  assert.ok(!sources.includes('avatars/ollama.png'))
  assert.ok(!sources.includes('avatars/kimi.png'))
  assert.ok(sources.includes('avatars/qwen.png'))
  await expectClean(view)
})

test('in the dark theme, the Ollama and Kimi avatars keep their base image', async () => {
  const { view } = await open({ theme: 'dark', store: AVATAR_STORE })
  const sources = imageSources(view)
  assert.ok(sources.includes('avatars/ollama.png'))
  assert.ok(sources.includes('avatars/kimi.png'))
  assert.ok(!sources.some((src) => src.includes('/on-')))
  await expectClean(view)
})

test('switching the theme swaps the icons without remounting', async () => {
  const { view } = await open({ theme: 'dark', store: ICON_STORE, inventory: ICON_INVENTORY })
  assert.ok(imageSources(view).includes('agent-icons/codex.png'))
  await view.emit('theme', { colorScheme: 'light' })
  assert.ok(imageSources(view).includes('agent-icons/on-light/codex.png'))
  assert.ok(!imageSources(view).includes('agent-icons/codex.png'))
  await expectClean(view)
})

test('shows a placeholder under an agent without profile', async () => {
  const { view } = await open({ store: { ...SAMPLE_STORE, profiles: [] } })
  assert.equal(view.findAll({ text: COPY.noProfileForAgent }).length, ENABLED.agents.length)
  assert.equal(view.find({ testId: 'launch-luna' }), null)
  await expectClean(view)
})

test('launches a profile in the focused workspace', async () => {
  const { view, launches } = await open()
  await view.press({ testId: 'launch-deepseek-flash' })
  assert.deepEqual(launches, ['deepseek-flash'])
  await expectClean(view)
})

test('disables launch without a workspace and enables it when one is focused', async () => {
  const { view, state } = await open({ context: null })
  assert.equal(view.find({ testId: 'launch-deepseek-flash' })!.disabled, true)
  assert.notEqual(view.find({ text: COPY.noWorkspace }), null)

  state.context = focused
  await view.emit('workspace.changed', { context: focused })
  assert.equal(view.find({ testId: 'launch-deepseek-flash' })!.disabled, false)
  assert.equal(view.find({ text: COPY.noWorkspace }), null)
  await expectClean(view)
})

test('shows why a launch failed', async () => {
  const { view } = await open({
    launch: () => ({ ok: false, reason: '« DeepSeek 4.1 Flash » : fournisseur introuvable.' })
  })
  await view.press({ testId: 'launch-deepseek-flash' })
  assert.notEqual(view.find({ text: /fournisseur introuvable/ }), null)
  await expectClean(view)
})

test('clears a launch failure when the store changes', async () => {
  const { view } = await open({ launch: () => ({ ok: false, reason: 'Le routage a échoué.' }) })
  await view.press({ testId: 'launch-deepseek-flash' })
  assert.notEqual(view.find({ text: /routage a échoué/ }), null)
  await view.post('store.changed', { ...SAMPLE_STORE, lastProfileId: 'deepseek-flash' })
  assert.equal(view.find({ text: /routage a échoué/ }), null)
  await expectClean(view)
})

test('the Claude form offers providers with an Anthropic option, other agents do not', async () => {
  const claude = await open()
  await claude.view.press({ label: 'Nouveau profil Claude' })
  assert.notEqual(claude.view.find({ label: COPY.fieldProvider }), null)
  const options = claude.view.find({ label: COPY.fieldProvider })!.props.options as { value: string; label: string }[]
  assert.deepEqual(options[0], { value: 'none', label: COPY.providerNone })
  assert.deepEqual(
    options.slice(1).map((option) => option.value),
    SAMPLE_STORE.providers.map((provider) => provider.id)
  )
  await expectClean(claude.view)

  const codex = await open()
  await codex.view.press({ label: 'Nouveau profil Codex' })
  assert.equal(codex.view.find({ label: COPY.fieldProvider }), null)
  await expectClean(codex.view)
})

test("effort options are the agent's own levels", async () => {
  const codex = await open()
  await codex.view.press({ label: 'Nouveau profil Codex' })
  assert.deepEqual(optionValues(codex.view, COPY.fieldEffort), [
    'default',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ])
  await expectClean(codex.view)

  const antigravity = await open()
  await antigravity.view.press({ label: 'Nouveau profil Antigravity' })
  assert.deepEqual(optionValues(antigravity.view, COPY.fieldEffort), ['default', 'low', 'medium', 'high'])
  await expectClean(antigravity.view)

  const harness = await open()
  await harness.view.press({ label: 'Nouveau profil DeepSeek Harness' })
  assert.equal(harness.view.find({ label: COPY.fieldModel }), null)
  assert.equal(harness.view.find({ label: COPY.fieldEffort }), null)
  await expectClean(harness.view)
})

test('the form title names the agent for a new profile and stays generic when editing', async () => {
  const { view } = await open()
  await view.press({ label: 'Nouveau profil Codex' })
  assert.notEqual(view.find({ type: 'Heading', text: 'Nouveau profil Codex' }), null)
  await view.press({ text: COPY.cancel })
  await view.press({ label: 'Modifier Luna' })
  assert.notEqual(view.find({ type: 'Heading', text: COPY.editProfileTitle }), null)
  await expectClean(view)
})

test('saves a profile bound to its agent', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Nouveau profil Claude' })
  // Un nouveau profil n'a rien à supprimer.
  assert.equal(view.find({ text: COPY.remove }), null)
  await view.type({ label: 'Nom' }, 'Sonnet')
  await view.type({ label: COPY.fieldModel }, 'sonnet')
  await view.select({ label: COPY.fieldEffort }, 'high')
  await view.select({ label: COPY.fieldProvider }, 'none')
  await view.press({ text: COPY.save })
  assert.equal(profileSaves.length, 1)
  const saved = profileSaves[0]!
  assert.equal(saved.agentId, 'claude')
  assert.equal(saved.name, 'Sonnet')
  assert.equal(saved.model, 'sonnet')
  assert.equal(saved.effort, 'high')
  assert.equal(saved.providerId, null)
  assert.match(saved.id, /^profile-/)
  await expectClean(view)
})

test('saves a provider-routed Claude profile and keeps the default effort as null', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Nouveau profil Claude' })
  await view.type({ label: 'Nom' }, 'GLM')
  await view.type({ label: COPY.fieldModel }, 'glm-5')
  await view.select({ label: COPY.fieldProvider }, 'openrouter')
  await view.press({ text: COPY.save })
  assert.equal(profileSaves[0]!.providerId, 'openrouter')
  assert.equal(profileSaves[0]!.effort, null)
  await expectClean(view)
})

test('saves a DeepSeek Harness profile without model', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Nouveau profil DeepSeek Harness' })
  await view.type({ label: 'Nom' }, 'Harness 2')
  await view.type({ label: COPY.fieldExtraArgs }, '--yolo')
  await view.press({ text: COPY.save })
  assert.equal(profileSaves.length, 1)
  assert.equal(profileSaves[0]!.agentId, 'dsh')
  assert.equal(profileSaves[0]!.model, null)
  assert.equal(profileSaves[0]!.effort, null)
  assert.equal(profileSaves[0]!.providerId, null)
  assert.deepEqual(profileSaves[0]!.extraArgs, ['--yolo'])
  await expectClean(view)
})

test('saves the avatar path and effort chosen in the form', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.select({ label: 'Effort' }, 'max')
  await view.select({ label: 'Avatar' }, 'avatars/qwen.png')
  await view.press({ text: 'Enregistrer' })
  assert.equal(profileSaves.length, 1)
  assert.equal(profileSaves[0]!.effort, 'max')
  assert.equal(profileSaves[0]!.avatar, 'avatars/qwen.png')
  assert.equal(profileSaves[0]!.id, 'deepseek-flash')
  assert.equal(profileSaves[0]!.agentId, 'claude')

  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.select({ label: 'Effort' }, 'default')
  await view.select({ label: 'Avatar' }, 'none')
  await view.press({ text: 'Enregistrer' })
  assert.equal(profileSaves.length, 2)
  assert.equal(profileSaves[1]!.effort, null)
  assert.equal(profileSaves[1]!.avatar, null)
  await expectClean(view)
})

test('tells an agent icon from an avatar of the same name in the avatar options', async () => {
  const { view } = await open({ avatars: ['avatars/claude.png', 'agent-icons/claude.png'] })
  await view.press({ label: 'Nouveau profil Claude' })
  const options = view.find({ label: COPY.fieldAvatar })!.props.options as { value: string; label: string }[]
  assert.deepEqual(options, [
    { value: 'none', label: COPY.avatarNone },
    { value: 'avatars/claude.png', label: 'claude' },
    { value: 'agent-icons/claude.png', label: COPY.agentIconLabel('claude') }
  ])
  await expectClean(view)
})

test('saves extra arguments one per line', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.type({ label: 'Arguments supplémentaires' }, '--verbose\n\n  --add-dir  \n/tmp')
  await view.press({ text: 'Enregistrer' })
  assert.deepEqual(profileSaves[0]!.extraArgs, ['--verbose', '--add-dir', '/tmp'])
  await expectClean(view)
})

test('splits each extra arguments line into shell words, quotes respected', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.type({ label: 'Arguments supplémentaires' }, '--add-dir /tmp\n--note "a b"\n--other \'c d\'')
  await view.press({ text: 'Enregistrer' })
  assert.deepEqual(profileSaves[0]!.extraArgs, ['--add-dir', '/tmp', '--note', 'a b', '--other', 'c d'])
  await expectClean(view)
})

test('shows a saved argument containing spaces quoted so that saving it again keeps it whole', async () => {
  const profiles = SAMPLE_STORE.profiles.map((p) => (p.id === 'deepseek-flash' ? { ...p, extraArgs: ['--note', 'a b'] } : p))
  const { view, profileSaves } = await open({ store: { ...SAMPLE_STORE, profiles } })
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.press({ text: 'Enregistrer' })
  assert.deepEqual(profileSaves[0]!.extraArgs, ['--note', 'a b'])
  await expectClean(view)
})

test('reopens an edited profile with its own values', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Modifier Luna' })
  await view.press({ text: 'Enregistrer' })
  const { id, agentId, model, effort, providerId } = profileSaves[0]!
  assert.deepEqual({ id, agentId, model, effort, providerId }, { id: 'luna', agentId: 'codex', model: 'gpt-6-luna', effort: 'high', providerId: null })
  await expectClean(view)
})

test('shows the field errors the worker returns, agent and effort included', async () => {
  const { view } = await open({
    saveProfile: () => ({
      ok: false,
      errors: { model: 'Modèle déjà utilisé par « Qwen 3.8 Flash ».', effort: COPY.effortNotSupported, agentId: COPY.agentUnknown }
    })
  })
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.press({ text: 'Enregistrer' })
  assert.notEqual(view.find({ text: 'Modèle déjà utilisé par « Qwen 3.8 Flash ».' }), null)
  assert.notEqual(view.find({ text: COPY.effortNotSupported }), null)
  assert.notEqual(view.find({ text: COPY.agentUnknown }), null)
  await expectClean(view)
})

test('closes the form without saving on cancel', async () => {
  const { view, profileSaves } = await open()
  await view.press({ label: 'Modifier DeepSeek 4.1 Flash' })
  await view.press({ text: 'Annuler' })
  assert.deepEqual(profileSaves, [])
  assert.notEqual(view.find({ testId: 'launch-deepseek-flash' }), null)
  await expectClean(view)
})

test('lists providers below the groups, and shows a hint when there is none', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ label: 'Modifier Ollama' }), null)
  assert.notEqual(view.find({ label: 'Modifier OpenRouter' }), null)
  assert.notEqual(view.find({ label: COPY.newProvider }), null)
  await expectClean(view)

  const empty = await open({ store: { ...SAMPLE_STORE, providers: [], profiles: [] } })
  assert.notEqual(empty.view.find({ text: COPY.noProviderHint }), null)
  await expectClean(empty.view)
})

test('warns about a long literal token only', async () => {
  const { view } = await open()
  await view.press({ label: 'Modifier OpenRouter' })
  assert.equal(view.find({ text: COPY.literalToken }), null)
  await view.type({ label: 'Jeton' }, '$open-router-key', { replace: true })
  assert.notEqual(view.find({ text: COPY.literalToken }), null)
  await view.press({ text: 'Annuler' })

  await view.press({ label: 'Modifier Ollama' })
  assert.equal(view.find({ text: COPY.literalToken }), null)
  await expectClean(view)
})

test('does not warn about a $NAME reference followed by a space', async () => {
  const { view } = await open()
  await view.press({ label: 'Modifier OpenRouter' })
  await view.type({ label: 'Jeton' }, '$OPENROUTER_API_KEY ', { replace: true })
  assert.equal(view.find({ text: COPY.literalToken }), null)
  await expectClean(view)
})

test('saves a provider with its extra environment', async () => {
  const { view, providerSaves } = await open()
  await view.press({ label: 'Modifier Ollama' })
  await view.type({ label: 'Variables supplémentaires' }, 'FOO=bar\nBAZ=a=b')
  await view.press({ text: 'Enregistrer' })
  assert.equal(providerSaves.length, 1)
  assert.deepEqual(providerSaves[0]!.extraEnv, { FOO: 'bar', BAZ: 'a=b' })
  assert.equal(providerSaves[0]!.id, 'ollama')
  await expectClean(view)
})

test('rejects a malformed environment line without calling the worker', async () => {
  const { view, providerSaves } = await open()
  await view.press({ label: 'Modifier Ollama' })
  await view.type({ label: 'Variables supplémentaires' }, 'pas une ligne valide')
  await view.press({ text: 'Enregistrer' })
  assert.deepEqual(providerSaves, [])
  assert.notEqual(view.find({ text: COPY.envLine(1) }), null)
  await expectClean(view)
})

test('shows why a provider cannot be deleted', async () => {
  const { view } = await open({
    deleteProvider: () => ({ ok: false, error: 'Utilisé par : DeepSeek 4.1 Flash.' })
  })
  await view.press({ label: 'Modifier Ollama' })
  await view.press({ text: 'Supprimer' })
  assert.notEqual(view.find({ text: /Utilisé par/ }), null)
  await expectClean(view)
})

test('follows store changes from the worker', async () => {
  const { view } = await open()
  const withoutDeepseek: Store = { ...SAMPLE_STORE, profiles: SAMPLE_STORE.profiles.filter((p) => p.id !== 'deepseek-flash') }
  await view.post('store.changed', withoutDeepseek)
  assert.equal(view.find({ testId: 'launch-deepseek-flash' }), null)
  assert.notEqual(view.find({ testId: 'launch-opus' }), null)
  await expectClean(view)
})

test('shows why the store could not be read and retries', async () => {
  let attempts = 0
  const { view } = await open({
    storeGet: () => {
      attempts += 1
      if (attempts === 1) throw new Error('worker injoignable')
      return SAMPLE_STORE
    }
  })
  assert.notEqual(view.find({ text: /worker injoignable/ }), null)
  await view.press({ text: COPY.retry })
  assert.notEqual(view.find({ testId: 'launch-deepseek-flash' }), null)
  await expectClean(view)
})

test('shows the provider field error the worker returns when no provider exists', async () => {
  const { view } = await open({
    store: { ...SAMPLE_STORE, providers: [], profiles: [] },
    saveProfile: () => ({ ok: false, errors: { providerId: COPY.providerNotFound } })
  })
  await view.press({ label: 'Nouveau profil Claude' })
  await view.type({ label: 'Nom' }, 'GLM')
  await view.type({ label: 'Modèle' }, 'glm-5')
  await view.press({ text: 'Enregistrer' })
  assert.notEqual(view.find({ text: COPY.providerNotFound }), null)
  await expectClean(view)
})

// Langue d'affichage (AC-3) : les libellés anglais sont écrits en clair, pas lus dans le dictionnaire, pour que le test morde.

test('announces Orca\'s language to the worker once, before anything else is asked', async () => {
  const { view, announcedLocales, requestOrder } = await open({ locale: 'de-DE' })
  assert.deepEqual(announcedLocales, ['de-DE'])
  // Le worker doit connaître la langue avant toute autre demande : ses refus et validations en dépendent.
  assert.equal(requestOrder[0], 'locale.set')
  assert.ok(requestOrder.length > 1, 'the panel asked for its data after announcing the language')
  await expectClean(view)
})

test('draws the list in English for en-US and any language Orca offers besides French', async () => {
  for (const locale of ['en-US', 'de-DE']) {
    const { view } = await open({ locale, store: { ...SAMPLE_STORE, lastProfileId: 'luna' } })
    assert.notEqual(view.find({ label: 'New Claude profile' }), null, locale)
    assert.notEqual(view.find({ testId: 'launch-luna' }), null, locale)
    assert.notEqual(view.find({ label: 'Edit Opus' }), null, locale)
    assert.notEqual(view.find({ label: 'Refresh agents' }), null, locale)
    assert.notEqual(view.find({ type: 'Badge', text: 'Last used' }), null, locale)
    assert.notEqual(view.find({ text: 'Providers' }), null, locale)
    assert.equal(view.find({ label: 'Nouveau profil Claude' }), null, locale)
    await expectClean(view)
  }
})

test('draws the list in French for fr-FR and fr-CA', async () => {
  for (const locale of ['fr-FR', 'fr-CA']) {
    const { view } = await open({ locale })
    assert.notEqual(view.find({ label: 'Nouveau profil Claude' }), null, locale)
    assert.notEqual(view.find({ text: 'Fournisseurs' }), null, locale)
    assert.equal(view.find({ label: 'New Claude profile' }), null, locale)
    await expectClean(view)
  }
})

test('the folded count of a group is pluralised in English', async () => {
  const names = ['Opus', 'Sonnet']
  const store: Store = {
    ...SAMPLE_STORE,
    providers: [],
    profiles: [OPUS, ...names.slice(1).map((name) => ({ ...OPUS, id: name, name })), ...SAMPLE_STORE.profiles.filter((p) => p.agentId === 'codex')]
  }
  const { view } = await open({
    locale: 'en-US',
    store,
    inventory: { ...ENABLED, agents: ['claude', 'codex', 'grok'] },
    persisted: { plugin: { collapsedAgents: ['claude', 'codex', 'grok'] } }
  })
  assert.notEqual(view.find({ text: '2 profiles' }), null)
  assert.notEqual(view.find({ text: '1 profile' }), null)
  assert.notEqual(view.find({ text: 'No profiles' }), null)
  await expectClean(view)
})

test('the profile form is in English, effort levels included', async () => {
  const { view } = await open({ locale: 'en-US' })
  await view.press({ label: 'Edit Opus' })
  assert.notEqual(view.find({ type: 'Heading', text: 'Edit profile' }), null)
  for (const label of ['Name', 'Avatar', 'Model', 'Effort', 'Provider', 'Extra arguments']) {
    assert.notEqual(view.find({ label }), null, label)
  }
  assert.notEqual(view.find({ text: 'Save' }), null)
  assert.notEqual(view.find({ text: 'Cancel' }), null)
  assert.notEqual(view.find({ text: 'Delete' }), null)
  const effort = view.find({ label: 'Effort' })!.props.options as { value: string; label: string }[]
  assert.equal(effort[0]!.label, "Orca's default")
  assert.deepEqual(
    effort.slice(1).map((option) => option.label),
    effort.slice(1).map((option) => ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[option.value])
  )
  const provider = view.find({ label: 'Provider' })!.props.options as { value: string; label: string }[]
  assert.equal(provider[0]!.label, 'None (Anthropic account)')
  await expectClean(view)
})

test('an agent icon is labelled in English in the avatar list', async () => {
  const { view } = await open({ locale: 'en-US', avatars: ['avatars/deepseek.png', 'agent-icons/claude.png'] })
  await view.press({ label: 'New Claude profile' })
  const options = view.find({ label: 'Avatar' })!.props.options as { value: string; label: string }[]
  assert.deepEqual(options.map((option) => option.label), ['None', 'deepseek', 'claude (agent icon)'])
  await expectClean(view)
})

test('the provider form is in English, with its own validation message', async () => {
  const { view, providerSaves } = await open({ locale: 'en-US' })
  await view.press({ label: 'New provider' })
  assert.notEqual(view.find({ type: 'Heading', text: 'New provider' }), null)
  for (const label of ['Name', 'Base URL', 'Token', 'Extra variables']) {
    assert.notEqual(view.find({ label }), null, label)
  }
  await view.type({ label: 'Extra variables' }, 'NOEQUALS')
  await view.press({ text: 'Save' })
  assert.deepEqual(providerSaves, [])
  assert.notEqual(view.find({ text: 'Line 1: expected NAME=value.' }), null)
  await view.type({ label: 'Token' }, 'sk-0123456789abcdef')
  assert.notEqual(view.find({ text: 'Token stored in plain text in the plugin; prefer a $NAME reference.' }), null)
  await expectClean(view)
})

test('the empty and error states are in English', async () => {
  const noAgents = await open({ locale: 'en-US', inventory: { ...ENABLED, agents: [] } })
  assert.notEqual(noAgents.view.find({ label: 'No agents enabled' }), null)
  assert.equal(noAgents.view.find({ type: 'EmptyState' })?.props.description, "Enable an agent in Orca's settings (Agents).")
  await expectClean(noAgents.view)

  const noWorkspace = await open({ locale: 'en-US', context: null })
  assert.notEqual(noWorkspace.view.find({ text: 'Open a workspace to launch a profile.' }), null)
  await expectClean(noWorkspace.view)

  const failing = await open({
    locale: 'en-US',
    agentsList: () => {
      throw new Error('boom')
    }
  })
  assert.notEqual(failing.view.find({ label: "Couldn't detect agents" }), null)
  assert.notEqual(failing.view.find({ text: 'Retry' }), null)
  await expectClean(failing.view)
})

test('the alphabetical order follows the display language, not French', async () => {
  // En suédois « Ä » vient après « Z » ; en français et en anglais il se range avec « A ».
  const store: Store = { ...SAMPLE_STORE, providers: [], profiles: ['Zed', 'Äpple'].map((name) => ({ ...OPUS, id: name, name })) }
  const order = async (locale: string) => {
    const { view } = await open({ locale, store })
    const labels = view.findAll({ type: 'IconButton', label: /^(Modifier|Edit|Ändra) / }).map((button) => button.label)
    await expectClean(view)
    return labels
  }
  assert.deepEqual(await order('sv-SE'), ['Edit Zed', 'Edit Äpple'])
  assert.deepEqual(await order('en-US'), ['Edit Äpple', 'Edit Zed'])
  assert.deepEqual(await order('fr-FR'), ['Modifier Äpple', 'Modifier Zed'])
})

test('numbers the profiles with their shortcut in panel order, without the model', async () => {
  const { view } = await open()
  assert.deepEqual(
    view.findAll({ text: /^⌘⌥\d$/ }).map((t) => t.text),
    ['⌘⌥1', '⌘⌥2', '⌘⌥3', '⌘⌥4', '⌘⌥5']
  )
  assert.equal(view.findAll({ type: 'IconButton', label: /^Lancer / }).length, 0)
  await view.press({ testId: 'launch-opus' })
  await expectClean(view)
})
