import { assert, test } from 'orca/testing'
import { profilesInPanelOrder, slotCommandId } from './slots'
import { SAMPLE_STORE } from './test-fixtures'

test('slots follow the panel: agents by label, then profiles by name', () => {
  const order = profilesInPanelOrder(SAMPLE_STORE, ['codex', 'claude', 'antigravity'])
  assert.deepEqual(order.map((p) => p.name), ['Argon', 'DeepSeek 4.1 Flash', 'Opus', 'Luna'])
})

test('disabled agents take no slot', () => {
  assert.deepEqual(profilesInPanelOrder(SAMPLE_STORE, ['codex']).map((p) => p.name), ['Luna'])
})

test('slot command ids', () => {
  assert.equal(slotCommandId(3), 'agentProfiles.launchSlot3')
})
