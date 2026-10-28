import { z } from 'zod'

const field = <T extends z.ZodType>(value: T) =>
  z.object({ value, status: z.enum(['known', 'inferred']), turn: z.number().int() }).optional()

export const goals = ['passive_income', 'own_job', 'growth', 'diversification', 'unsure'] as const
export const involvements = ['hands_off', 'part_time', 'full_time'] as const
export const experiences = ['none', 'some', 'experienced'] as const
export const risks = ['low', 'medium', 'high'] as const

// What the assistant knows about the person. Each field remembers whether the user
// stated it (known) or the assistant inferred it, and on which turn.
export const profileSchema = z.object({
  role: field(z.enum(['buyer', 'seller'])),
  budgetGel: field(z.number().positive()),
  budgetOriginal: field(z.object({ amount: z.number(), currency: z.string() })),
  capitalShare: field(z.enum(['all', 'part'])),
  goal: field(z.enum(goals)),
  involvement: field(z.enum(involvements)),
  experience: field(z.enum(experiences)),
  experienceSectors: field(z.array(z.string())),
  risk: field(z.enum(risks)),
  incomeTargetGel: field(z.number().positive()),
  cities: field(z.array(z.string())),
  locationFlexible: field(z.boolean()),
  sectors: field(z.array(z.string())),
  sectorExclusions: field(z.array(z.string())),
  interest: field(z.string()),
  assetOpenness: field(z.enum(['business_only', 'open_to_property'])),
  timeline: field(z.enum(['now', 'months', 'exploring'])),
})

export type Profile = z.infer<typeof profileSchema>
export type ProfileKey = keyof Profile
export type ProfileValue<K extends ProfileKey> = NonNullable<Profile[K]>['value']

export function parseProfile(raw: unknown): Profile {
  const parsed = profileSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : {}
}

export function has(p: Profile, key: ProfileKey): boolean {
  return p[key] !== undefined
}

export function val<K extends ProfileKey>(p: Profile, key: K): ProfileValue<K> | undefined {
  return p[key]?.value as ProfileValue<K> | undefined
}

export type Track =
  | 'explorer'
  | 'passive_investor'
  | 'owner_operator'
  | 'experienced_expander'
  | 'income_property_seeker'
  | 'specific_searcher'
  | 'seller'
