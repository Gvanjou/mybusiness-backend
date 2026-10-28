
import type { Profile, ProfileKey } from './profile.model.js'

function set<K extends ProfileKey>(p: Profile, key: K, value: NonNullable<Profile[K]>['value'], inferred: boolean, turn: number) {
  const prev = p[key]
  // A stated value is never overwritten by an inference.
  if (inferred && prev?.status === 'known') return
  ;(p as Record<string, unknown>)[key] = { value, status: inferred ? 'inferred' : 'known', turn }
}

// Applies a tapped quick-reply option: values are exact, so they are "known".
export function applyPatch(profile: Profile, patch: Partial<Record<ProfileKey, unknown>>, turn: number): { profile: Profile; changed: ProfileKey[] } {
  const p: Profile = structuredClone(profile)
  const changed: ProfileKey[] = []
  for (const [key, value] of Object.entries(patch) as [ProfileKey, never][]) {
    set(p, key, value, false, turn)
    changed.push(key)
  }
  if (p.capitalShare?.value === 'all' && !p.risk) set(p, 'risk', 'low', true, turn)
  if (p.goal?.value === 'passive_income' && !p.involvement) set(p, 'involvement', 'hands_off', true, turn)
  if (p.goal?.value === 'own_job' && !p.involvement) set(p, 'involvement', 'full_time', true, turn)
  if (!p.role) set(p, 'role', 'buyer', true, turn)
  return { profile: p, changed }
}
