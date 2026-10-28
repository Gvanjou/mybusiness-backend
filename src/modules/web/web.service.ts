import { ai } from '../ai/ai.gateway.js'
import type { Locale } from '../../shared/i18n/locale.js'
import { logger, errorFields } from '../../shared/logger/logger.js'

// Web search through Gemini's own Google Search, for current figures our data cannot have (statistics,
// regulations, market trends). Results always carry their sources so the user can check them.

export type WebSource = { title: string; url: string }
export type WebAnswer = { summary: string; sources: WebSource[] }

const CACHE_TTL_MS = 24 * 3_600_000
const cache = new Map<string, { at: number; answer: WebAnswer }>()

const languageName: Record<Locale, string> = { ka: 'Georgian', en: 'English', ru: 'Russian' }

// Grounding links are Google redirects; the user should see (and the favicon should come from) the real page.
async function resolve(source: WebSource): Promise<WebSource> {
  if (!source.url.includes('grounding-api-redirect')) return source
  try {
    const res = await fetch(source.url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3_000) })
    const location = res.headers.get('location')
    return location?.startsWith('https://') ? { title: source.title || new URL(location).hostname, url: location } : source
  } catch {
    return source
  }
}

export async function webSearch(query: string, locale: Locale, sessionId?: string): Promise<WebAnswer> {
  const key = `${locale}|${query}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.answer
  try {
    const res = await ai.searchWeb(
      `Answer briefly in ${languageName[locale]} with concrete figures and the year of each. Prefer official Georgian sources (Geostat, National Bank of Georgia, Revenue Service) when the question is about Georgia. Question: ${query}`,
      { sessionId },
    )
    const sources = await Promise.all(res.sources.slice(0, 5).map(resolve))
    const answer = { summary: res.text, sources: sources.filter((s, i) => sources.findIndex((x) => x.url === s.url) === i) }
    if (answer.summary) cache.set(key, { at: Date.now(), answer })
    return answer
  } catch (err) {
    logger.warn('web search unavailable', errorFields(err))
    return { summary: '', sources: [] }
  }
}
