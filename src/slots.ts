import { agentById } from './agents'
import type { Profile, Store } from './store'

export const SLOT_COUNT = 9

export const byName = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })

export const slotCommandId = (slot: number): string => `agentProfiles.launchSlot${slot}`

export type Compare = (a: string, b: string) => number

export function profilesInPanelOrder(store: Store, enabled: readonly string[], compare: Compare = byName): Profile[] {
  return enabled
    .flatMap((id) => agentById(id) ?? [])
    .sort((a, b) => compare(a.label, b.label))
    .flatMap((spec) => store.profiles.filter((p) => p.agentId === spec.id).sort((a, b) => compare(a.name, b.name)))
}

export const slotShortcut = (slot: number): string => `⌘⌥${slot}`

export function slotsOf(store: Store, enabled: readonly string[], compare: Compare = byName): Map<string, number> {
  return new Map(profilesInPanelOrder(store, enabled, compare).slice(0, SLOT_COUNT).map((p, i) => [p.id, i + 1]))
}
