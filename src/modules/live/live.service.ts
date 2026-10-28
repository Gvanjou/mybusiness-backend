import { env } from '../../pkg/env/env.js'

// The mybusiness.ge public API, read at question time. Nothing is copied into our database: answers are kept in
// memory for a short while so one conversation does not ask the site the same thing twice.

const TIMEOUT_MS = 4_000
const PAGE_SIZE = 60 // the site's maximum
const MAX_PAGES = 20
const CACHE_TTL_MS = 3 * 60_000
const HEADERS = { 'user-agent': 'MyBusinessAI/0.2 (+assistant)', accept: 'application/json' }

export type SiteListing = Record<string, unknown>
type Page = { data: SiteListing[]; hasMore: boolean }

const cache = new Map<string, { at: number; value: unknown }>()

async function getJson<T>(path: string): Promise<T | 'not_found'> {
  const hit = cache.get(path)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T
  const res = await fetch(new URL(path, env.SOURCE_BASE_URL), { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 404) return 'not_found'
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  const value = (await res.json()) as T
  cache.set(path, { at: Date.now(), value })
  return value
}

// Every active listing on the site (all pages in parallel, ~1 s).
export async function siteListings(): Promise<SiteListing[]> {
  const q = (page: number) => `/api/listings?${new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) })}`
  const first = await getJson<Page>(q(0))
  if (first === 'not_found') return []
  if (!first.hasMore) return first.data
  const rest = await Promise.all(Array.from({ length: MAX_PAGES - 1 }, (_, i) => getJson<Page>(q(i + 1)).catch(() => null)))
  const seen = new Map<string, SiteListing>()
  for (const item of [first, ...rest].flatMap((p) => (p && p !== 'not_found' ? p.data : []))) seen.set(String(item.id), item)
  return [...seen.values()]
}

// One listing with everything the site has (description, address, coordinates, figures). null = removed or expired.
export async function siteListing(id: string): Promise<SiteListing | null> {
  const res = await getJson<{ data: SiteListing | null }>(`/api/listings/${id}`)
  if (res === 'not_found' || !res.data) return null
  const raw = res.data
  const expired = typeof raw.expires_at === 'string' && new Date(raw.expires_at) < new Date()
  if ((typeof raw.status === 'string' && raw.status !== 'active') || expired) return null
  return raw
}
