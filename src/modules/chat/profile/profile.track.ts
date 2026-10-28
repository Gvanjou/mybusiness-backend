import { val, type Profile, type Track } from './profile.model.js'

// The track decides which questions matter and how results are ranked.
// Re-derived every turn, so a user can move between tracks as they reveal more.
export function deriveTrack(p: Profile, lastIntent?: string): Track {
  if (val(p, 'role') === 'seller') return 'seller'

  const goal = val(p, 'goal')
  const involvement = val(p, 'involvement')
  const passive = goal === 'passive_income' || involvement === 'hands_off'

  if (passive && val(p, 'assetOpenness') === 'open_to_property') return 'income_property_seeker'
  if (passive) return 'passive_investor'
  if (val(p, 'experience') === 'experienced' && (val(p, 'experienceSectors')?.length ?? 0) > 0) return 'experienced_expander'
  if (goal === 'own_job' || involvement === 'full_time' || involvement === 'part_time') return 'owner_operator'
  if ((lastIntent === 'search' || lastIntent === 'refine') && (val(p, 'sectors')?.length || val(p, 'cities')?.length)) {
    return 'specific_searcher'
  }
  return 'explorer'
}
