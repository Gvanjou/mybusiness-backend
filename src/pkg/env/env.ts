import { z } from 'zod'

const modelList = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((m) => m.trim()).filter(Boolean))

const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
  .refine((v) => v === undefined || v.length >= 32, 'must be at least 32 characters')

const modelLimitsSchema = z.record(
  z.string(),
  z.object({ rpm: z.number().int().positive(), rpd: z.number().int().positive() }),
)

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  GEMINI_API_KEY: z.string().min(10),
  GEMINI_MODEL_LIMITS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || v.trim() === '') return {}
      try {
        return modelLimitsSchema.parse(JSON.parse(v))
      } catch {
        ctx.addIssue({ code: 'custom', message: 'GEMINI_MODEL_LIMITS must be JSON {"model": {"rpm": n, "rpd": n}}' })
        return z.NEVER
      }
    }),

  // Google sign-in (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type "Web application").
  // Authorised redirect URI: <site address>/api/auth/callback, e.g. http://localhost:3000/api/auth/callback
  GOOGLE_CLIENT_ID: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),
  GOOGLE_CLIENT_SECRET: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined)),

  // Optional: only needed to trigger jobs over HTTP. Without it /jobs is disabled and the in-process scheduler runs them.
  JOBS_SECRET: optionalSecret,

  // Model chains, most preferred first, comma-separated. Empty = the built-in free-tier chain (ai.models.ts).
  // Example on a paid key: GEMINI_RESPONDER_MODELS=gemini-3.1-pro-preview,gemini-3-flash-preview
  GEMINI_RESPONDER_MODELS: modelList,
  // Google Maps grounding adds ratings and reviews to location analysis: one extra Gemini call per place. Paid keys.
  GOOGLE_MAPS_GROUNDING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CHAT_MESSAGES_PER_MINUTE: z.coerce.number().int().positive().default(10),
  CHAT_MESSAGES_PER_DAY: z.coerce.number().int().positive().default(200),
  // AI tokens one person may use per day (all their chats). The usage circle shows the share used.
  USER_DAILY_TOKENS: z.coerce.number().int().positive().default(400_000),
  SESSIONS_PER_HOUR: z.coerce.number().int().positive().default(20),

  SOURCE_BASE_URL: z.url().default('https://mybusiness.ge'),
  ENABLE_SCHEDULER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // OpenStreetMap place search for nearby competitors (free; ~1 request/second policy). Set to false to disable.
  COMPETITION_LOOKUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  NOMINATIM_URL: z.url().default('https://nominatim.openstreetmap.org'),
})

export type Env = z.infer<typeof envSchema>

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    // Print names and reasons only, never values.
    console.error(`Invalid environment configuration:\n${issues}`)
    process.exit(1)
  }
  return parsed.data
}

export const env = loadEnv()
