import { assert, test } from 'orca/testing'
import { chatArgs, launchChat, opensAsChat, worktreeSelector, type ChatRunner } from './chat'
import { DEEPSEEK, HARNESS, LUNA, OPUS } from './test-fixtures'

const WS = 'repo::/abs/path'

const runner = (code: number, stdout: string, stderr = ''): { run: ChatRunner; calls: string[][] } => {
  const calls: string[][] = []
  return { calls, run: async (_command, args) => (calls.push([...args]), { code, stdout, stderr }) }
}

test('profiles without provider and extra arguments open as a chat', () => {
  assert.equal(opensAsChat(OPUS), true)
  assert.equal(opensAsChat(DEEPSEEK), false)
  assert.equal(opensAsChat({ ...LUNA, extraArgs: ['-c', 'x=y'] }), false)
})

test('chat arguments carry the agent, worktree, model and effort', () => {
  assert.deepEqual(chatArgs(LUNA, WS), [
    'agent', 'launch', '--agent', 'codex', '--surface', 'chat', '--focus', '--json', '--worktree', `id:${WS}`,
    '--model', 'gpt-6-luna', '--effort', 'high'
  ])
  assert.deepEqual(chatArgs(HARNESS, WS).slice(-2), ['--worktree', `id:${WS}`])
})

test('launchChat accepts a structured outcome', async () => {
  const { run, calls } = runner(0, JSON.stringify({ ok: true, result: { outcome: { kind: 'structured' } } }))
  await launchChat(OPUS, WS, run)
  assert.equal(calls.length, 1)
})

test('launchChat refuses a terminal fallback', async () => {
  const { run } = runner(0, JSON.stringify({ ok: true, result: { outcome: { kind: 'terminal' } } }))
  await assert.rejects(launchChat(OPUS, WS, run), /terminal instead of a chat/)
})

test('launchChat reports the CLI error', async () => {
  const { run } = runner(1, '', 'selector_not_found')
  await assert.rejects(launchChat(OPUS, WS, run), /selector_not_found/)
})

test('workspace ids map to worktree selectors', () => {
  assert.equal(worktreeSelector('identity:wt2:local:abc'), 'identity:wt2:local:abc')
  assert.equal(worktreeSelector('folder:f1'), 'folder:f1')
  assert.equal(worktreeSelector('repo::/abs'), 'id:repo::/abs')
  assert.throws(() => worktreeSelector('w1'), /Unknown Orca workspace id format/)
})
