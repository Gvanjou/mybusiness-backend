import { createClient } from '@supabase/supabase-js'
import { env } from '../env/env.js'

// Service-role client: bypasses RLS. Server-only; never expose this key or client.
export const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { 'x-application-name': 'mybusiness-ai-backend' } },
})
