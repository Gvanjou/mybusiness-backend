import type { Context, MiddlewareHandler } from 'hono'
import { AppError } from './app-error.js'

// The site's address as the browser sees it. Requests come through the frontend proxy, which passes the
// browser's host and protocol on.
export function publicOrigin(c: Context): string {
  const host = c.req.header('x-forwarded-host') ?? c.req.header('host') ?? 'localhost'
  const proto = c.req.header('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

// Blocks cross-site posts that would ride on the sign-in cookies: changes must come from our own pages.
export const sameOrigin: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin')
    const ok = origin ? safeHost(origin) === new URL(publicOrigin(c)).host : c.req.header('sec-fetch-site') === 'same-origin'
    if (!ok) throw new AppError('forbidden', 'Forbidden')
  }
  await next()
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// Only same-site paths like /ka or /en/listing/abc after sign-in.
export function safeNext(next: string | undefined): string {
  return next && /^\/[a-z]{2}(\/[\w-]*)*$/.test(next) ? next : '/ka'
}
