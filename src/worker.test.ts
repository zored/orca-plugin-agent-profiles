// Joue le worker comme Orca le ferait : requêtes du panneau, commande, et hook déclenché pendant agent.launch.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { agentById } from './agents'
import { MESSAGES } from './copy'
import type { InventoryDeps } from './inventory'
import { splitWords } from './launch'
import { EMPTY_STORE, STORE_KEY, type Profile, type Store } from './store'
import { AGY_CMD, ARGON, CLAUDE_CMD, CODEX_CMD, DEEPSEEK, fakeDeps, HARNESS, LUNA, OLLAMA, OPUS, SAMPLE_STORE } from './test-fixtures'
import { activateWith, LOCALE_KEY, PRESET_GROUP } from './worker'

const COPY = MESSAGES.fr

// Forme réelle capturée dans `orca plugin logs` (Orca 1.4.259) : `orca agent launch --model`.
const CLI = "claude '--dangerously-skip-permissions' '--model' 'deepseek-v4.1-flash:cloud[1m]' 'Reponds uniquement: OK-SPIKE'"

const launch = (command: string, agent = 'claude', workspaceId = 'w1') => ({
  agent,
  workspaceId,
  workspaceKind: 'worktree' as const,
  command,
  env: {}
})

const CONTEXT = { workspaceId: 'w1', branch: 'main', displayName: 'w1', terminals: [] }

type Decision = { kind: string; event: { command: string; env: Record<string, string> } }

const QWEN: Profile = {
  id: 'qwen',
  agentId: 'claude',
  name: 'Qwen 3.8 Flash',
  avatar: null,
  model: 'qwen/qwen3.8-flash[1m]',
  effort: null,
  providerId: 'openrouter',
  extraArgs: []
}

const STORE: Store = { ...SAMPLE_STORE, profiles: [...SAMPLE_STORE.profiles, QWEN] }

/** Store dont le profil DeepSeek pointe vers un fournisseur absent : la forme seule est valide. */
const ORPHAN_STORE: Store = { ...STORE, profiles: STORE.profiles.map((p) => (p.id === DEEPSEEK.id ? { ...p, providerId: 'gone' } : p)) }

const words = (command: string): string[] => splitWords(command).map((word) => word.value)

/** Monte le worker sur des dépendances d'inventaire factices, sans jamais lancer le vrai shell ni toucher la vraie base d'Orca. */
const mountBare = (host: ReturnType<typeof mockHost>, deps: InventoryDeps = fakeDeps().deps) =>
  mountWorker({ default: (orca) => activateWith(orca, deps) }, { host })

/** Comme Orca : le panneau annonce sa langue à son montage. Les tests historiques attendent le français. */
async function mountV2(host: ReturnType<typeof mockHost>, deps: InventoryDeps = fakeDeps().deps, locale = 'fr-FR') {
  const worker = await mountBare(host, deps)
  await worker.request('locale.set', { locale })
  return worker
}

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

/** Hôte dont `agent.launch` déclenche le hook comme Orca, sans l'attendre (sinon interblocage). */
function launchingHost(
  state: { fired?: Promise<unknown> },
  fire: (agent: string) => Promise<unknown>,
  storage?: Record<string, Store>,
  focus: unknown = { focused: true }
) {
  return mockHost({
    storage,
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async (params: unknown) => {
        state.fired = fire((params as { agent: string }).agent)
        await pause()
        return { terminalId: 't1' }
      },
      'terminal.focus': focus
    }
  })
}

test('starts with an empty v2 store and leaves store.v1 untouched', async () => {
  const legacy = { version: 1, providers: [], profiles: [{ id: 'old' }] }
  const host = mockHost({ storage: { 'store.v1': legacy } })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('store.get'), EMPTY_STORE)
  assert.deepEqual(host.data().storage[STORE_KEY], EMPTY_STORE)
  assert.deepEqual(host.data().storage['store.v1'], legacy)
  await worker.deactivate()
})

test('backs up an invalid store instead of overwriting it', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: { version: 1 } } })
  const worker = await mountV2(host)
  await worker.request('store.get')
  const data = host.data().storage
  const backups = Object.keys(data).filter((key) => key.startsWith(`${STORE_KEY}.corrupt-`))
  assert.equal(backups.length, 1)
  assert.deepEqual(data[backups[0]!], { version: 1 })
  assert.deepEqual(data[STORE_KEY], EMPTY_STORE)
  await worker.deactivate()
})

test('saves a valid profile and refuses a duplicate model', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE } })
  const worker = await mountV2(host)
  const glm: Profile = { ...DEEPSEEK, id: '', name: ' GLM 5.3 Flash ', model: ' glm-5.3-flash:cloud[1m] ' }
  const saved = await worker.request('profile.save', { profile: glm })
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  const created = saved.store.profiles.find((p) => p.model === 'glm-5.3-flash:cloud[1m]')
  assert.ok(created)
  assert.notEqual(created.id, '')
  assert.equal(created.name, 'GLM 5.3 Flash')
  assert.equal(worker.posts.filter((p) => p.event === 'store.changed').at(-1)?.event, 'store.changed')
  assert.deepEqual(worker.posts.filter((p) => p.event === 'store.changed').at(-1)?.payload, saved.store)

  const before = host.data().storage[STORE_KEY]
  const duplicate = await worker.request('profile.save', {
    profile: { ...glm, id: '', name: 'Autre', model: 'deepseek-v4.1-flash:cloud' }
  })
  assert.deepEqual(duplicate, { ok: false, errors: { model: COPY.modelTaken('DeepSeek 4.1 Flash') } })
  assert.deepEqual(host.data().storage[STORE_KEY], before)
  await worker.deactivate()
})

test('saves a profile of an agent without model flag as null', async () => {
  const worker = await mountV2(mockHost())
  const saved = await worker.request('profile.save', { profile: { ...HARNESS, id: '' } })
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  assert.equal(saved.store.profiles[0]!.model, null)
  await worker.deactivate()
})

test('persists a provider trimmed and refuses to delete one in use', async () => {
  const worker = await mountV2(mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE } }))
  const saved = await worker.request('provider.save', {
    provider: { id: '', name: ' Local ', baseUrl: ' http://localhost:1234 ', token: ' abc ', extraEnv: {} }
  })
  assert.equal(saved.ok, true)
  if (!saved.ok) return
  const created = saved.store.providers.find((p) => p.name === 'Local')
  assert.ok(created)
  assert.equal(created.baseUrl, 'http://localhost:1234')
  assert.equal(created.token, 'abc')

  assert.deepEqual(await worker.request('provider.delete', { providerId: OLLAMA.id }), {
    ok: false,
    error: COPY.providerInUse('DeepSeek 4.1 Flash')
  })
  await worker.deactivate()
})

test('deletes a profile and reports an unknown one', async () => {
  const worker = await mountV2(mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE } }))
  const deleted = await worker.request('profile.delete', { profileId: DEEPSEEK.id })
  assert.equal(deleted.ok, true)
  if (!deleted.ok) return
  assert.ok(!deleted.store.profiles.some((p) => p.id === DEEPSEEK.id))
  assert.deepEqual(await worker.request('profile.delete', { profileId: 'nope' }), { ok: false, error: COPY.profileNotFound })
  await worker.deactivate()
})

test('agents.list answers from its cache for 10 s, agents.refresh probes again', async () => {
  const { deps, state } = fakeDeps()
  const worker = await mountV2(mockHost(), deps)
  assert.equal(state.finds, 1)
  await worker.request('agents.list')
  state.now = 5_000
  await worker.request('agents.list')
  assert.equal(state.finds, 1)
  await worker.request('agents.refresh')
  assert.equal(state.finds, 2)
  state.now = 20_000
  await worker.request('agents.list')
  assert.equal(state.finds, 3)
  await worker.deactivate()
})

test('two simultaneous agents.list requests share one probe', async () => {
  const { deps, state } = fakeDeps()
  const worker = await mountV2(mockHost(), deps)
  await worker.request('agents.list')
  state.now = 20_000
  const [first, second] = await Promise.all([worker.request('agents.list'), worker.request('agents.list')])
  assert.equal(state.finds, 2)
  assert.deepEqual(first, second)
  await worker.deactivate()
})

test('posts agents.changed only when the enabled agents change', async () => {
  const { deps, state } = fakeDeps()
  const worker = await mountV2(mockHost(), deps)
  // Le premier calcul, au démarrage, poste déjà : un volet peut attendre. Les comptes partent de là.
  await worker.request('agents.list')
  const changes = () => worker.posts.filter((post) => post.event === 'agents.changed')
  const settled = changes().length
  assert.equal(settled, 1)
  await worker.request('agents.refresh')
  assert.equal(changes().length, settled)
  state.agents = ['claude']
  await worker.request('agents.refresh')
  assert.equal(changes().length, settled + 1)
  assert.deepEqual((changes().at(-1)?.payload as { agents: string[] }).agents, ['claude'])
  await worker.deactivate()
})

test('does not launch without a focused workspace', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE }, results: { 'workspace.readContext': null } })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: false, reason: COPY.noWorkspace })
  assert.equal(host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('a launch whose hook never ran reports that routing did not take', async () => {
  const host = mockHost({
    storage: { [STORE_KEY]: SAMPLE_STORE },
    results: { 'workspace.readContext': CONTEXT, 'agent.launch': { terminalId: 't1' }, 'terminal.focus': { focused: true } }
  })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.routingNotTaken
  })
  // Le Claude non routé tourne sur le compte Anthropic : son terminal passe au premier plan pour être fermé.
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 't1' }])
  // L'entrée en attente a été retirée : un lancement natif ultérieur n'est pas détourné.
  const next = launch(CLAUDE_CMD)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', next), { kind: 'continue', event: next })
  await worker.deactivate()
})

test('a launch routed by the hook succeeds and becomes the last profile', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: SAMPLE_STORE })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.equal(decision.kind, 'continue')
  assert.ok(decision.event.command.includes("'--model' 'deepseek-v4.1-flash:cloud[1m]'"))
  assert.equal((await worker.request('store.get')).lastProfileId, DEEPSEEK.id)
  assert.equal(worker.posts.at(-1)?.event, 'store.changed')
  // Orca démarre l'agent dans un onglet en arrière-plan : le worker amène ce terminal au premier plan.
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 't1' }])
  assert.deepEqual(host.refusals, [])

  // Le profil en attente ne sert qu'une fois.
  const again = launch(CLAUDE_CMD)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', again), { kind: 'continue', event: again })
  await worker.deactivate()
})

test('routes a Claude profile through its provider', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: SAMPLE_STORE })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.ok(decision.event.command.startsWith("ANTHROPIC_BASE_URL='http://localhost:11434'"))
  assert.equal(decision.event.env.ANTHROPIC_BASE_URL, 'http://localhost:11434')
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), ['profile=deepseek-flash agent=claude via=panel'])
  for (const line of worker.logs) {
    assert.ok(!line.includes('localhost:11434'), line)
    assert.ok(!line.includes('ANTHROPIC_AUTH_TOKEN='), line)
  }
  await worker.deactivate()
})

test('launches an Antigravity profile with its model and effort', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(AGY_CMD, 'antigravity')), { [STORE_KEY]: SAMPLE_STORE })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: ARGON.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.deepEqual(words(decision.event.command), [
    'agy',
    '--model',
    'gemini-4-argon',
    '--effort',
    'medium',
    '--dangerously-skip-permissions'
  ])
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: 'w1', agent: 'antigravity' }])
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), ['profile=argon agent=antigravity via=panel'])
  await worker.deactivate()
})

test('does not apply a pending Claude profile to another agent\'s launch', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const native = launch(CODEX_CMD, 'codex')
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', native), { [STORE_KEY]: SAMPLE_STORE })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: OPUS.id }), {
    ok: false,
    reason: COPY.profileNotApplied('Opus')
  })
  assert.deepEqual(await state.fired, { kind: 'continue', event: native })
  // Même sans routage, le terminal existe : il passe au premier plan.
  assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 't1' }])
  await worker.deactivate()
})

test('a profile launched from the panel wins over a provider profile whose model matches the command', async () => {
  // Sans lancement nu, c'est la seule façon d'obtenir ce modèle sans passer par le fournisseur.
  const store: Store = { ...SAMPLE_STORE, profiles: [OPUS, { ...DEEPSEEK, model: 'claude-opus-5-5' }] }
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: store })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: OPUS.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.equal(decision.kind, 'continue')
  assert.ok(decision.event.command.includes("'--model' 'opus'"), decision.event.command)
  assert.ok(!decision.event.command.includes('ANTHROPIC_BASE_URL'), decision.event.command)
  assert.equal(decision.event.env.ANTHROPIC_BASE_URL, undefined)
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), ['profile=opus agent=claude via=panel'])
  await worker.deactivate()
})

test('refuses a profile whose agent the table does not know', async () => {
  const retired: Profile = { ...OPUS, id: 'retired', name: 'Retired', agentId: 'retired-agent' }
  const host = mockHost({
    storage: { [STORE_KEY]: { ...SAMPLE_STORE, profiles: [retired] } },
    results: { 'workspace.readContext': CONTEXT, 'agent.launch': { terminalId: 't1' } }
  })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: retired.id }), { ok: false, reason: COPY.agentUnknown })
  assert.equal(host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('a launch refused by the hook reports its reason', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: ORPHAN_STORE })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.profileProviderMissing('DeepSeek 4.1 Flash')
  })
  await state.fired
  assert.equal(worker.posts.filter((p) => p.event === 'store.changed').length, 0)
  assert.equal(host.callsOf('terminal.focus').length, 0)

  // La raison périmée est remise à zéro au lancement suivant.
  assert.deepEqual(await worker.request('profile.launch', { profileId: OPUS.id }), { ok: true })
  await state.fired
  await worker.deactivate()
})

test('the hook refuses a hand-edited store that puts a provider on a non-Claude agent', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const store: Store = { ...SAMPLE_STORE, profiles: [{ ...ARGON, providerId: OLLAMA.id }] }
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(AGY_CMD, 'antigravity')), { [STORE_KEY]: store })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: ARGON.id }), {
    ok: false,
    reason: COPY.providerClaudeOnly
  })
  assert.deepEqual(await state.fired, { kind: 'deny', reason: COPY.providerClaudeOnly })
  await worker.deactivate()
})

test('under cmd, the hook refuses a provider profile and writes a plain profile in double quotes', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const { deps } = fakeDeps()
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch('claude "--dangerously-skip-permissions"')), {
    [STORE_KEY]: SAMPLE_STORE
  })
  const worker = await mountV2(host, { ...deps, launchShell: () => 'cmd' })
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.providerShellUnsupported
  })
  assert.deepEqual(await state.fired, { kind: 'deny', reason: COPY.providerShellUnsupported })
  assert.deepEqual(await worker.request('profile.launch', { profileId: OPUS.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.equal(decision.event.command, 'claude "--model" "opus" "--effort" "medium" "--dangerously-skip-permissions"')
  await worker.deactivate()
})

test('under PowerShell, the hook routes a provider profile with $env: assignments', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const { deps } = fakeDeps()
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: SAMPLE_STORE })
  const worker = await mountV2(host, { ...deps, launchShell: () => 'powershell' })
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.ok(decision.event.command.startsWith("$env:ANTHROPIC_BASE_URL='http://localhost:11434'; "), decision.event.command)
  assert.equal(decision.event.env.ANTHROPIC_AUTH_TOKEN, 'ollama')
  await worker.deactivate()
})

test('the hook refuses a hand-edited store that routes a Claude profile without a model', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const store: Store = { ...SAMPLE_STORE, profiles: [{ ...DEEPSEEK, model: null }] }
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: store })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.modelRequired
  })
  assert.deepEqual(await state.fired, { kind: 'deny', reason: COPY.modelRequired })
  await worker.deactivate()
})

test('a launch stays successful when Orca cannot focus its terminal', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: SAMPLE_STORE }, () => {
    throw hostError('unavailable', 'desktop app only')
  })
  const worker = await mountV2(host)
  // L'agent tourne déjà : un focus refusé ne transforme pas le lancement en échec.
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  await state.fired
  assert.equal((await worker.request('store.get')).lastProfileId, DEEPSEEK.id)
  assert.ok(worker.logs.includes('focus failed terminal=t1 code=unavailable'))
  await worker.deactivate()
})

test('a focus Orca did not take is logged and leaves the launch successful', async () => {
  const state: { fired?: Promise<unknown> } = {}
  // Orca répond false quand une demande de focus plus récente a gagné ou que la fenêtre n'a pas suivi.
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD)), { [STORE_KEY]: SAMPLE_STORE }, { focused: false })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  await state.fired
  assert.ok(worker.logs.includes('focus not taken terminal=t1'))
  await worker.deactivate()
})

test('a pending profile is consumed whatever the workspace id format of the hook event', async () => {
  const state: { fired?: Promise<unknown> } = {}
  // Orca 1.4.259 : l'identifiant du hook n'a pas le format de celui de workspace.readContext.
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD, 'claude', 'wt-hook-format')), {
    [STORE_KEY]: SAMPLE_STORE
  })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), { ok: true })
  const decision = (await state.fired) as Decision
  assert.equal(decision.kind, 'continue')
  assert.ok(decision.event.command.includes("'--model' 'deepseek-v4.1-flash:cloud[1m]'"))
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), ['profile=deepseek-flash agent=claude via=panel'])
  await worker.deactivate()
})

test('a pending profile deleted before the hook ran refuses the launch', async () => {
  const state: { fired?: Promise<unknown>; deleted?: Promise<unknown> } = {}
  const host = mockHost({
    storage: { [STORE_KEY]: SAMPLE_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async () => {
        // Le profil disparaît entre la mise en attente et le hook (autre fenêtre, édition du store).
        state.deleted = worker.request('profile.delete', { profileId: DEEPSEEK.id })
        await pause()
        state.fired = worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD))
        await pause()
        return { terminalId: 't1' }
      }
    }
  })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.profileNotFound
  })
  assert.deepEqual(await state.fired, { kind: 'deny', reason: COPY.profileNotFound })
  assert.equal(((await state.deleted) as { ok: boolean }).ok, true)
  assert.equal(worker.posts.filter((p) => p.event === 'store.changed').length, 1)
  await worker.deactivate()
})

test('a pending entry older than 15 s is ignored by the hook', async () => {
  const realNow = Date.now
  const state: { fired?: Promise<unknown> } = {}
  const host = mockHost({
    storage: { [STORE_KEY]: STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async () => {
        // Le hook arrive 20 s après la mise en attente.
        Date.now = () => realNow() + 20_000
        state.fired = worker.hooks.fire('agent.launch.before', launch(CLI))
        await pause()
        return { terminalId: 't1' }
      }
    }
  })
  const worker = await mountV2(host)
  try {
    const result = await worker.request('profile.launch', { profileId: QWEN.id })
    const decision = (await state.fired) as Decision
    // Le profil Qwen en attente est périmé : seul le flag --model du lancement (DeepSeek) route.
    assert.equal(decision.kind, 'continue')
    assert.ok(decision.event.command.includes("'--model' 'deepseek-v4.1-flash:cloud[1m]'"))
    assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), ['profile=deepseek-flash agent=claude via=model-flag'])
    // Le profil du panneau n'a pas été appliqué : la réponse le dit.
    assert.deepEqual(result, { ok: false, reason: COPY.routingNotTaken })
  } finally {
    Date.now = realNow
  }
  await worker.deactivate()
})

test('a pending entry older than 15 s leaves a native launch untouched', async () => {
  const realNow = Date.now
  const state: { fired?: Promise<unknown> } = {}
  const native = launch(CLAUDE_CMD)
  const host = mockHost({
    storage: { [STORE_KEY]: SAMPLE_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async () => {
        Date.now = () => realNow() + 20_000
        state.fired = worker.hooks.fire('agent.launch.before', native)
        await pause()
        return { terminalId: 't1' }
      }
    }
  })
  const worker = await mountV2(host)
  try {
    await worker.request('profile.launch', { profileId: DEEPSEEK.id })
    assert.deepEqual(await state.fired, { kind: 'continue', event: native })
  } finally {
    Date.now = realNow
  }
  await worker.deactivate()
})

test('an agent.launch that throws after the hook denied reports the deny reason and leaves no pending entry', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = mockHost({
    storage: { [STORE_KEY]: ORPHAN_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      // Orca lève une erreur quand le hook refuse.
      'agent.launch': async () => {
        state.fired = worker.hooks.fire('agent.launch.before', launch(CLAUDE_CMD))
        await pause()
        throw new Error('denied by a hook')
      }
    }
  })
  const worker = await mountV2(host)
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: COPY.profileProviderMissing('DeepSeek 4.1 Flash')
  })
  assert.equal(((await state.fired) as { kind: string }).kind, 'deny')
  // Aucune entrée en attente : un lancement natif ultérieur passe tel quel.
  const next = launch(CLAUDE_CMD)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', next), { kind: 'continue', event: next })
  await worker.deactivate()
})

test('two launches in a row each apply their own profile', async () => {
  const fired: Promise<unknown>[] = []
  const commands: Record<string, string> = { antigravity: AGY_CMD, codex: CODEX_CMD }
  const host = mockHost({
    storage: { [STORE_KEY]: SAMPLE_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async (params: unknown) => {
        const { agent } = params as { agent: string }
        fired.push(worker.hooks.fire('agent.launch.before', launch(commands[agent]!, agent)))
        await pause()
        return { terminalId: 't1' }
      },
      'terminal.focus': { focused: true }
    }
  })
  const worker = await mountV2(host)
  // Le second lancement part sans attendre le premier : la file sérialisée les passe un par un.
  const results = await Promise.all([
    worker.request('profile.launch', { profileId: ARGON.id }),
    worker.request('profile.launch', { profileId: LUNA.id })
  ])
  assert.deepEqual(results, [{ ok: true }, { ok: true }])
  const decisions = (await Promise.all(fired)) as Decision[]
  assert.equal(decisions.length, 2)
  assert.ok(words(decisions[0]!.event.command).includes('gemini-4-argon'))
  assert.ok(!words(decisions[0]!.event.command).includes('gpt-6-luna'))
  assert.ok(words(decisions[1]!.event.command).includes('gpt-6-luna'))
  assert.ok(!words(decisions[1]!.event.command).includes('gemini-4-argon'))
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('profile=')), [
    'profile=argon agent=antigravity via=panel',
    'profile=luna agent=codex via=panel'
  ])
  await worker.deactivate()
})

test('the model-flag fallback only routes Claude profiles with a provider', async () => {
  const worker = await mountV2(mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE } }))
  const routed = await worker.hooks.fire('agent.launch.before', launch(CLI))
  assert.equal(routed.kind, 'continue')
  if (routed.kind !== 'continue') return
  assert.ok(routed.event.command.includes("'--model' 'deepseek-v4.1-flash:cloud[1m]'"))
  assert.equal(routed.event.env.ANTHROPIC_BASE_URL, 'http://localhost:11434')
  assert.ok(worker.logs.includes('profile=deepseek-flash agent=claude via=model-flag'))
  for (const line of worker.logs) {
    assert.ok(!line.includes('localhost:11434'), line)
    assert.ok(!line.includes('Reponds'), line)
  }

  const agy = launch("agy '--model' 'gemini-4-argon'", 'antigravity')
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', agy), { kind: 'continue', event: agy })
  await worker.deactivate()
})

test('leaves native launches and other agents untouched', async () => {
  const worker = await mountV2(mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE } }))
  const native = launch(CLAUDE_CMD)
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', native), { kind: 'continue', event: native })
  const codex = launch(CODEX_CMD, 'codex')
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', codex), { kind: 'continue', event: codex })
  await worker.deactivate()
})

test('refuses a profile whose provider is gone', async () => {
  const worker = await mountV2(mockHost({ storage: { [STORE_KEY]: ORPHAN_STORE } }))
  const decision = await worker.hooks.fire('agent.launch.before', launch(CLI))
  assert.deepEqual(decision, { kind: 'deny', reason: COPY.profileProviderMissing('DeepSeek 4.1 Flash') })
  await worker.deactivate()
})

test('relaunch without history says so', async () => {
  const worker = await mountV2(mockHost())
  assert.equal(await worker.command('agentProfiles.relaunchLast'), COPY.noLastProfile)
  await worker.deactivate()
})

test('relaunch refuses when the last profile\'s agent is disabled', async () => {
  const host = mockHost({
    storage: { [STORE_KEY]: { ...SAMPLE_STORE, lastProfileId: ARGON.id } },
    results: { 'workspace.readContext': CONTEXT, 'agent.launch': { terminalId: 't1' } }
  })
  const worker = await mountV2(host, fakeDeps(['claude']).deps)
  assert.equal(await worker.command('agentProfiles.relaunchLast'), COPY.agentDisabled('Antigravity'))
  assert.equal(host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('relaunch starts the last profile again, whatever its agent', async () => {
  const state: { fired?: Promise<unknown> } = {}
  const host = launchingHost(state, () => worker.hooks.fire('agent.launch.before', launch(CODEX_CMD, 'codex')), {
    [STORE_KEY]: { ...SAMPLE_STORE, lastProfileId: LUNA.id }
  })
  const worker = await mountV2(host)
  assert.equal(await worker.command('agentProfiles.relaunchLast'), COPY.launched('Luna'))
  await state.fired
  assert.deepEqual(host.callsOf('agent.launch'), [{ workspaceId: 'w1', agent: 'codex' }])
  assert.ok(worker.logs.includes('profile=luna agent=codex via=relaunch'))
  // Le raccourci de relance amène aussi son terminal au premier plan.
  assert.equal(host.callsOf('terminal.focus').length, 1)
  await worker.deactivate()
})

test('relaunch reads the Orca settings again and refuses an agent disabled since the last probe', async () => {
  const { deps, state } = fakeDeps()
  const host = mockHost({
    storage: { [STORE_KEY]: { ...SAMPLE_STORE, lastProfileId: ARGON.id } },
    results: { 'workspace.readContext': CONTEXT, 'agent.launch': { terminalId: 't1' } }
  })
  const worker = await mountV2(host, deps)
  // L'inventaire est en cache (moins de 10 s) quand l'utilisateur coupe l'agent dans Orca.
  await worker.request('agents.list')
  state.settings = { disabled: ['antigravity'], overrides: {} }
  assert.equal(await worker.command('agentProfiles.relaunchLast'), COPY.agentDisabled('Antigravity'))
  assert.equal(host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('an older, slower probe never overwrites a newer refresh', async () => {
  const settings = { disabled: [] as string[] }
  let calls = 0
  const found = ['claude', 'grok'].flatMap((id) => agentById(id)!.commands)
  const deps: InventoryDeps = {
    readSettings: () => ({ disabled: [...settings.disabled], overrides: {} }),
    findCommands: async () => {
      calls++
      await pause(calls === 1 ? 200 : 10)
      return new Set(found)
    },
    now: () => Date.now(),
    launchShell: () => 'posix'
  }
  const worker = await mountV2(mockHost(), deps)
  settings.disabled = ['grok']
  const fresh = await worker.request('agents.refresh')
  // Le démarrage finit après la relance : il ne doit plus rien écrire.
  await pause(300)
  const cached = await worker.request('agents.list')
  const posted = worker.posts.filter((p) => p.event === 'agents.changed').map((p) => (p.payload as { agents: string[] }).agents)
  assert.deepEqual(fresh.agents, ['claude'])
  assert.deepEqual(cached.agents, ['claude'])
  assert.deepEqual(posted.at(-1), ['claude'])
  await worker.deactivate()
})

test('a Claude launch denied during a codex panel launch does not fail the codex launch', async () => {
  const fired: Promise<unknown>[] = []
  const host = mockHost({
    storage: { [STORE_KEY]: ORPHAN_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async () => {
        fired.push(worker.hooks.fire('agent.launch.before', launch(CODEX_CMD, 'codex')))
        fired.push(worker.hooks.fire('agent.launch.before', launch(CLI)))
        await pause()
        return { terminalId: 't1' }
      },
      'terminal.focus': { focused: true }
    }
  })
  const worker = await mountV2(host)
  const result = await worker.request('profile.launch', { profileId: LUNA.id })
  const [codexDecision, claudeDecision] = (await Promise.all(fired)) as { kind: string; event?: { command: string } }[]
  assert.equal(codexDecision!.kind, 'continue')
  assert.ok(words(codexDecision!.event!.command).includes('gpt-6-luna'))
  // Le refus du lancement Claude natif reste le sien.
  assert.equal(claudeDecision!.kind, 'deny')
  assert.deepEqual(result, { ok: true })
  assert.equal(host.callsOf('terminal.focus').length, 1)
  assert.equal((await worker.request('store.get')).lastProfileId, LUNA.id)
  await worker.deactivate()
})

test('a panel profile the hook never saw does not leak into a later native launch', async () => {
  const fired: Promise<unknown>[] = []
  const host = mockHost({
    storage: { [STORE_KEY]: ORPHAN_STORE },
    results: {
      'workspace.readContext': CONTEXT,
      'agent.launch': async () => {
        // Le hook du lancement codex ne passe pas ; un lancement Claude natif est refusé pendant ce temps.
        fired.push(worker.hooks.fire('agent.launch.before', launch(CLI)))
        await pause()
        return { terminalId: 't1' }
      },
      'terminal.focus': { focused: true }
    }
  })
  const worker = await mountV2(host)
  const result = await worker.request('profile.launch', { profileId: LUNA.id })
  await Promise.all(fired)
  assert.equal(result.ok, false)
  assert.ok(!('reason' in result) || result.reason !== COPY.profileProviderMissing('DeepSeek 4.1 Flash'))
  // Un lancement codex natif, plus tard (moins de 15 s), reste tel qu'Orca l'a préparé.
  const native = launch(CODEX_CMD, 'codex')
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', native), { kind: 'continue', event: native })
  await worker.deactivate()
})

test('logs once when the Orca settings cannot be read', async () => {
  const { deps, state } = fakeDeps()
  state.settings = null
  const worker = await mountV2(mockHost(), deps)
  await worker.request('agents.list')
  await worker.request('agents.refresh')
  await worker.request('agents.refresh')
  assert.equal(worker.logs.filter((line) => line === 'settings unreadable').length, 1)
  await worker.deactivate()
})

test('logs when the login shell failed and detection fell back to the PATH', async () => {
  const { deps } = fakeDeps()
  const failing: InventoryDeps = {
    ...deps,
    findCommands: async (tokens, onFallback) => {
      onFallback?.()
      return deps.findCommands(tokens)
    }
  }
  const worker = await mountV2(mockHost(), failing)
  await worker.request('agents.list')
  assert.ok(worker.logs.includes('shell probe failed, PATH fallback'))
  await worker.deactivate()
})

test('stays quiet when the settings are readable and the shell answered', async () => {
  const worker = await mountV2(mockHost())
  await worker.request('agents.list')
  assert.ok(!worker.logs.includes('settings unreadable'))
  assert.ok(!worker.logs.includes('shell probe failed, PATH fallback'))
  await worker.deactivate()
})

// Langue du worker (AC-4) : les textes anglais sont écrits en clair, pas lus dans le dictionnaire, pour que le test morde.

test('the worker speaks English until a panel announces a language', async () => {
  const worker = await mountBare(mockHost())
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'No profile launched yet.')
  assert.deepEqual(await worker.request('profile.delete', { profileId: 'nope' }), { ok: false, error: 'Profile not found.' })
  await worker.deactivate()
})

test('after an English panel, relaunch, validations and hook refusals answer in English', async () => {
  const host = mockHost({
    storage: { [STORE_KEY]: ORPHAN_STORE },
    results: { 'workspace.readContext': null }
  })
  const worker = await mountV2(host, fakeDeps().deps, 'en-US')
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'No profile launched yet.')
  assert.deepEqual(await worker.request('profile.launch', { profileId: DEEPSEEK.id }), {
    ok: false,
    reason: 'Open a workspace to launch a profile.'
  })
  const invalid = await worker.request('provider.save', { provider: { ...OLLAMA, id: 'x', baseUrl: 'localhost' } })
  assert.deepEqual(invalid, { ok: false, errors: { baseUrl: 'The URL must start with http:// or https://.' } })
  assert.deepEqual(await worker.hooks.fire('agent.launch.before', launch(CLI)), {
    kind: 'deny',
    reason: '"DeepSeek 4.1 Flash": provider not found.'
  })
  await worker.deactivate()
})

test('relaunch speaks English after en-US and French after fr-FR, the last announcement winning', async () => {
  const host = mockHost({
    storage: { [STORE_KEY]: { ...SAMPLE_STORE, lastProfileId: ARGON.id } },
    results: { 'workspace.readContext': CONTEXT, 'agent.launch': { terminalId: 't1' } }
  })
  const worker = await mountBare(host, fakeDeps(['claude']).deps)
  await worker.request('locale.set', { locale: 'en-US' })
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'Antigravity is disabled in Orca.')
  await worker.request('locale.set', { locale: 'fr-FR' })
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'Antigravity est désactivé dans Orca.')
  await worker.request('locale.set', { locale: 'de-DE' })
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'Antigravity is disabled in Orca.')
  await worker.deactivate()
})

test('any French variant is French, any other language is English', async () => {
  const worker = await mountBare(mockHost())
  for (const [tag, expected] of [['fr', 'fr'], ['fr-CA', 'fr'], ['FR_be', 'fr'], ['frisian', 'en'], ['en-GB', 'en'], ['', 'en']] as const) {
    await worker.request('locale.set', { locale: tag })
    assert.equal(await worker.command('agentProfiles.relaunchLast'), MESSAGES[expected].noLastProfile, tag)
  }
  await worker.deactivate()
})

test('the last announced language survives a worker restart, in its own storage key', async () => {
  const legacy = { version: 1, providers: [], profiles: [{ id: 'old' }] }
  const host = mockHost({ storage: { 'store.v1': legacy, [STORE_KEY]: SAMPLE_STORE } })
  const first = await mountV2(host, fakeDeps().deps, 'fr-FR')
  await first.deactivate()
  assert.equal(host.data().storage[LOCALE_KEY], 'fr')

  // Nouveau worker sur le même stockage, aucun panneau : il parle toujours français.
  const second = await mountBare(host)
  assert.equal(await second.command('agentProfiles.relaunchLast'), 'Aucun profil lancé pour l\'instant.')
  await second.request('locale.set', { locale: 'en-US' })
  await second.deactivate()
  assert.equal(host.data().storage[LOCALE_KEY], 'en')

  const third = await mountBare(host)
  assert.equal(await third.command('agentProfiles.relaunchLast'), 'No profile launched yet.')
  await third.deactivate()

  // La langue ne touche ni au store v2 ni au store v1.
  assert.deepEqual(host.data().storage[STORE_KEY], SAMPLE_STORE)
  assert.deepEqual(host.data().storage['store.v1'], legacy)
  assert.notEqual(LOCALE_KEY, STORE_KEY)
})

test('a language announced while the storage is still being read wins over the stored one', async () => {
  // Une lecture lente rend « en » : l'annonce « fr » du panneau, arrivée entre-temps, est plus récente et doit rester.
  const host = mockHost({
    results: {
      'storage.get': async (params: unknown) => {
        await pause(60)
        return { value: (params as { key: string }).key === LOCALE_KEY ? 'en' : null }
      }
    }
  })
  // Comme Orca : les gestionnaires sont enregistrés pendant l'activation, et une requête peut déjà arriver.
  const worker = await mountWorker(
    { default: (orca) => { void activateWith(orca, fakeDeps().deps); return Promise.resolve() } },
    { host }
  )
  await worker.request('locale.set', { locale: 'fr-FR' })
  assert.equal(await worker.command('agentProfiles.relaunchLast'), MESSAGES.fr.noLastProfile)
  assert.equal(host.data().storage[LOCALE_KEY], 'fr')
  await worker.deactivate()
})

test('a failing read of the stored language falls back to English, is logged with its code, and does not break activation', async () => {
  const host = mockHost({
    results: {
      'storage.get': (params: unknown) => {
        if ((params as { key: string }).key === LOCALE_KEY) throw hostError('unavailable', 'storage busy')
        return { value: null }
      }
    }
  })
  const worker = await mountBare(host)
  assert.equal(await worker.command('agentProfiles.relaunchLast'), MESSAGES.en.noLastProfile)
  assert.ok(worker.logs.includes('locale read failed code=unavailable'), worker.logs.join('|'))
  // Le store, lui, est chargé normalement.
  assert.deepEqual(await worker.request('store.get'), EMPTY_STORE)
  await worker.deactivate()
})

test('an unreadable stored language falls back to English and is replaced on the next announcement', async () => {
  const host = mockHost({ storage: { [LOCALE_KEY]: 'klingon' } })
  const worker = await mountBare(host)
  assert.equal(await worker.command('agentProfiles.relaunchLast'), 'No profile launched yet.')
  await worker.request('locale.set', { locale: 'en-US' })
  assert.equal(host.data().storage[LOCALE_KEY], 'en')
  await worker.deactivate()
})

test('a profile without provider and extra arguments opens as a chat', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE }, results: { 'workspace.readContext': CONTEXT } })
  const chats: [string, string][] = []
  const worker = await mountWorker(
    { default: (orca) => activateWith(orca, fakeDeps().deps, async (profile, workspaceId) => void chats.push([profile.id, workspaceId])) },
    { host }
  )
  await worker.request('locale.set', { locale: 'fr-FR' })
  assert.deepEqual(await worker.request('profile.launch', { profileId: LUNA.id }), { ok: true })
  assert.deepEqual(chats, [[LUNA.id, 'w1']])
  assert.equal(host.callsOf('agent.launch').length, 0)
  await worker.deactivate()
})

test('a failed chat launch returns its reason', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE }, results: { 'workspace.readContext': CONTEXT } })
  const worker = await mountWorker(
    { default: (orca) => activateWith(orca, fakeDeps().deps, async () => { throw new Error('selector_not_found') }) },
    { host }
  )
  assert.deepEqual(await worker.request('profile.launch', { profileId: OPUS.id }), { ok: false, reason: 'selector_not_found' })
  await worker.deactivate()
})

test('Mod+Alt+N launches the Nth profile of the panel', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE }, results: { 'workspace.readContext': CONTEXT } })
  const chats: string[] = []
  const worker = await mountWorker(
    { default: (orca) => activateWith(orca, fakeDeps(['claude', 'codex']).deps, async (profile) => void chats.push(profile.id)) },
    { host }
  )
  await worker.request('locale.set', { locale: 'en-US' })
  await worker.command('agentProfiles.launchSlot3')
  assert.deepEqual(chats, [LUNA.id])
  assert.equal(await worker.command('agentProfiles.launchSlot9'), 'No profile #9 in the Agents panel')
  await worker.deactivate()
})

test('publishes chat-ready profiles as new-tab presets in panel order with their slot shortcut', async () => {
  const host = mockHost({ storage: { [STORE_KEY]: SAMPLE_STORE }, results: { 'agentPresets.set': { ok: true } } })
  const worker = await mountV2(host)
  await worker.request('agents.list')
  await pause()
  const calls = host.callsOf('agentPresets.set')
  assert.deepEqual(calls[calls.length - 1], {
    group: PRESET_GROUP,
    title: 'Agent profiles',
    items: [
      { id: 'argon', title: 'Argon', agent: 'antigravity', model: 'gemini-4-argon', effort: 'medium', keybinding: '⌘⌥1' },
      { id: 'opus', title: 'Opus', agent: 'claude', model: 'opus', effort: 'medium', keybinding: '⌘⌥3' },
      { id: 'luna', title: 'Luna', agent: 'codex', model: 'gpt-6-luna', effort: 'high', keybinding: '⌘⌥4' },
      { id: 'harness', title: 'Harness', agent: 'dsh', keybinding: '⌘⌥5' }
    ]
  })
  await worker.deactivate()
})
