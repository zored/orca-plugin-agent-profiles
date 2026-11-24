import { agentById } from './agents'
import type { Profile, Store } from './store'

export const SLOT_COUNT = 9

const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })

export const slotCommandId = (slot: number): string => `agentProfiles.launchSlot${slot}`

export function profilesInPanelOrder(store: Store, enabled: readonly string[]): Profile[] {
  return enabled
    .flatMap((id) => agentById(id) ?? [])
    .sort((a, b) => byName(a.label, b.label))
    .flatMap((spec) => store.profiles.filter((p) => p.agentId === spec.id).sort((a, b) => byName(a.name, b.name)))
}
