import { createHash } from 'node:crypto'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { env } from '../../pkg/env/env.js'
import { db } from '../../pkg/supabase/supabase.js'
import { AppError } from '../../shared/http/app-error.js'
import { randomToken, safeEqual, sha256 } from '../../shared/utils/crypto.js'

// Google sign-in, handled entirely here (OAuth 2.0 authorization code flow with PKCE). The browser only holds
// httpOnly cookies: a short-lived one during sign-in, then a random session token whose hash is in auth_sessions.

export type User = { id: string; email: string | null; name: string; avatarUrl: string | null }

const SESSION = 'mb_session'
const SIGN_IN = 'mb_oauth'
const SESSION_DAYS = 60
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com']

const cookieOptions = (maxAge: number) => ({ httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'Lax' as const, path: '/', maxAge })

function googleConfig(): { clientId: string; clientSecret: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new AppError('internal', 'Google sign-in is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)')
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
}

// Step 1: where to send the browser. state guards against forged callbacks; the PKCE verifier proves the code
// is redeemed by whoever started the sign-in. Both wait in a 10-minute httpOnly cookie.
export function googleSignInUrl(c: Context, redirectUri: string, next: string): string {
  const { clientId } = googleConfig()
  const state = randomToken(24)
  const verifier = randomToken(48)
  setCookie(c, SIGN_IN, JSON.stringify({ state, verifier, next }), cookieOptions(10 * 60))
  const url = new URL(GOOGLE_AUTH)
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()
  return url.toString()
}

function parsePending(raw: string | undefined): { state: string; verifier: string; next: string } | null {
  try {
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    return v && typeof v.state === 'string' && typeof v.verifier === 'string' && typeof v.next === 'string' ? { state: v.state, verifier: v.verifier, next: v.next } : null
  } catch {
    return null
  }
}

type IdToken = { iss: string; aud: string; exp: number; sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }

// Step 2: Google sent the user back. Returns where to go next; throws when the sign-in is not valid.
export async function finishGoogleSignIn(c: Context, redirectUri: string, code: string, state: string): Promise<string> {
  const { clientId, clientSecret } = googleConfig()
  const saved = getCookie(c, SIGN_IN)
  deleteCookie(c, SIGN_IN, { path: '/' })
  const pending = parsePending(saved)
  if (!pending || !safeEqual(pending.state, state)) throw new AppError('unauthorized', 'Sign-in expired or was not started here')

  const res = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new AppError('unauthorized', `Google rejected the sign-in (${res.status})`)
  const { id_token } = (await res.json()) as { id_token?: string }
  // The ID token came straight from Google's token endpoint over TLS, so its claims are checked, not its signature
  // (OpenID Connect Core 3.1.3.7).
  const claims = JSON.parse(Buffer.from(id_token?.split('.')[1] ?? '', 'base64url').toString('utf8')) as IdToken
  if (!GOOGLE_ISSUERS.includes(claims.iss) || claims.aud !== clientId || claims.exp * 1000 < Date.now() || !claims.sub) {
    throw new AppError('unauthorized', 'Invalid Google ID token')
  }
  if (claims.email && claims.email_verified === false) throw new AppError('unauthorized', 'Google email is not verified')

  const { data: user, error } = await db
    .from('app_users')
    .upsert(
      { google_sub: claims.sub, email: claims.email ?? null, name: claims.name ?? null, avatar_url: claims.picture ?? null, last_login_at: new Date().toISOString() },
      { onConflict: 'google_sub' },
    )
    .select('id')
    .single()
  if (error) throw error
  await startSession(c, String(user.id))
  return pending.next
}

async function startSession(c: Context, userId: string): Promise<void> {
  const token = randomToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  const { error } = await db.from('auth_sessions').insert({ user_id: userId, token_hash: sha256(token), expires_at: expires.toISOString() })
  if (error) throw error
  setCookie(c, SESSION, token, cookieOptions(SESSION_DAYS * 86_400))
}

// The signed-in user, or null.
export async function currentUser(c: Context): Promise<User | null> {
  const token = getCookie(c, SESSION)
  if (!token || token.length < 20 || token.length > 200) return null
  const { data, error } = await db
    .from('auth_sessions')
    .select('expires_at, app_users (id, email, name, avatar_url)')
    .eq('token_hash', sha256(token))
    .maybeSingle()
  if (error) throw error
  const u = data?.app_users as unknown as { id: string; email: string | null; name: string | null; avatar_url: string | null } | null
  if (!data || !u || new Date(data.expires_at) < new Date()) return null
  return { id: u.id, email: u.email, name: u.name ?? u.email ?? '', avatarUrl: u.avatar_url }
}

export async function requireUser(c: Context): Promise<User> {
  const user = await currentUser(c)
  if (!user) throw new AppError('unauthorized', 'Sign in to continue')
  return user
}

export async function signOut(c: Context): Promise<void> {
  const token = getCookie(c, SESSION)
  if (token) await db.from('auth_sessions').delete().eq('token_hash', sha256(token))
  deleteCookie(c, SESSION, { path: '/' })
}

// The Google profile photo, fetched here and served from our own address: the site only loads images from
// itself (Content-Security-Policy), and Google's image host refuses some cross-site requests. Cached in memory.
const AVATAR_TTL_MS = 24 * 3_600_000
const avatars = new Map<string, { at: number; type: string; bytes: ArrayBuffer }>()

export async function avatarImage(url: string): Promise<{ type: string; bytes: ArrayBuffer } | null> {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  if (!host.endsWith('.googleusercontent.com')) return null // only Google's photo host, never an arbitrary URL
  const hit = avatars.get(url)
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return hit
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) }).catch(() => null)
  const type = res?.headers.get('content-type') ?? ''
  if (!res?.ok || !type.startsWith('image/')) return null
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength > 512 * 1024) return null
  avatars.set(url, { at: Date.now(), type, bytes })
  if (avatars.size > 2_000) avatars.delete(avatars.keys().next().value!)
  return { type, bytes }
}

// Where the UI loads the photo from; the version changes when Google's photo does.
export const avatarPath = (url: string | null) => (url ? `/api/auth/avatar?v=${sha256(url).slice(0, 10)}` : null)

// Sessions past their expiry (housekeeping job).
export async function deleteExpiredSessions(): Promise<void> {
  await db.from('auth_sessions').delete().lt('expires_at', new Date().toISOString())
}
