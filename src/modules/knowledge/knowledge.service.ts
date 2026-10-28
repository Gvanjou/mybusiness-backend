import { readdir, readFile } from 'node:fs/promises'
import { db } from '../../pkg/supabase/supabase.js'
import type { Locale } from '../../shared/i18n/locale.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { chunk } from '../../shared/utils/async.js'
import { sha256 } from '../../shared/utils/crypto.js'
import { cosine, parseVector, toPgVector } from '../../shared/utils/vector.js'
import { ai } from '../ai/ai.gateway.js'

// backend/knowledge/<lang>/*.md — same relative path from src/ and dist/.
// Every language has the same files with the same sections in the same order.
const CONTENT_DIR = new URL('../../../knowledge/', import.meta.url)
const LANGUAGES: Locale[] = ['en', 'ka', 'ru']

export type KnowledgeChunk = {
  id: string
  language: Locale
  source: string
  topic: string
  title: string
  content: string
  url: string | null
  embedding: Float32Array | null
}

// confident: the match answers the query (semantic ≥ 0.5 cosine, keyword ≥ 0.5 of the query's weight), not stray words.
export type KnowledgeHit = KnowledgeChunk & { score: number; confident: boolean }

let chunks: KnowledgeChunk[] = []

export function parseFile(language: Locale, file: string, text: string): Omit<KnowledgeChunk, 'embedding'>[] {
  const meta: Record<string, string> = {}
  let body = text
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/)
  if (fm) {
    for (const line of fm[1]!.split('\n')) {
      const [k, ...v] = line.split(':')
      if (k) meta[k.trim()] = v.join(':').trim()
    }
    body = text.slice(fm[0].length)
  }
  return body
    .split(/^## /m)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((section, index) => {
      const [title, ...rest] = section.split('\n')
      return {
        // Section index (not the title) keeps ids aligned across languages.
        id: `${language}/${file.replace(/\.md$/, '')}#${index}`,
        language,
        source: meta.source ?? file,
        topic: meta.topic ?? 'general',
        title: title!.trim(),
        content: rest.join('\n').trim(),
        url: meta.url || null,
      }
    })
}

// Lexical fallback when the embedding model is unavailable. Unicode-aware (Georgian, Cyrillic), prefix-based so
// inflected forms still match ("ყიდვის" ~ "ყიდვა", "покупки" ~ "покупка"), ignores question words, and weights
// rare words higher than common ones (IDF), so "ROI" outweighs "business".
const STOPWORDS = new Set([
  'what', 'how', 'does', 'work', 'works', 'which', 'should', 'could', 'would', 'about', 'there', 'this', 'that', 'with', 'from', 'have', 'your', 'the', 'and', 'for', 'can',
  'როგორ', 'რა', 'არის', 'რომ', 'თუ', 'და', 'რამდენი', 'რატომ', 'შეიძლება', 'შემიძლია', 'ჩემი', 'მინდა', 'ვიცი', 'მუშაობს', 'ხდება', 'ხორციელდება',
  'что', 'такое', 'как', 'какие', 'какой', 'это', 'для', 'если', 'можно', 'меня', 'есть', 'хочу', 'работает', 'происходит',
])

function stems(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map((w) => (w.length > 5 ? w.slice(0, w.length - 2) : w)),
    ),
  ]
}

export function keywordScore(query: string, c: KnowledgeChunk, idf: (stem: string) => number = () => 1): number {
  const qs = stems(query)
  if (qs.length === 0) return 0
  const title = c.title.toLowerCase()
  const body = c.content.toLowerCase()
  let hit = 0
  let total = 0
  for (const s of qs) {
    const w = idf(s)
    total += 2 * w
    hit += title.includes(s) ? 2 * w : body.includes(s) ? w : 0
  }
  return total === 0 ? 0 : hit / total
}

export function idfFor(pool: KnowledgeChunk[]): (stem: string) => number {
  const texts = pool.map((c) => `${c.title} ${c.content}`.toLowerCase())
  const cache = new Map<string, number>()
  return (stem) => {
    let v = cache.get(stem)
    if (v === undefined) {
      const df = texts.filter((t) => t.includes(stem)).length
      v = df === 0 ? 0 : Math.log(1 + pool.length / df)
      cache.set(stem, v)
    }
    return v
  }
}

async function readSections(): Promise<Omit<KnowledgeChunk, 'embedding'>[]> {
  const out: Omit<KnowledgeChunk, 'embedding'>[] = []
  for (const language of LANGUAGES) {
    const dir = new URL(`${language}/`, CONTENT_DIR)
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
    for (const f of files) out.push(...parseFile(language, f, await readFile(new URL(f, dir), 'utf8')))
  }
  return out
}

export const knowledge = {
  // Reads backend/knowledge/<lang>/*.md, upserts chunks, embeds new or changed ones, removes deleted ones.
  async ingest(): Promise<{ total: number; embedded: number; removed: number }> {
    const parsed = await readSections()

    const { data: existing, error } = await db.from('knowledge_chunks').select('id, content_hash, embedding')
    if (error) throw error
    const prev = new Map(existing.map((e) => [e.id as string, e]))

    const rows = parsed.map((p) => ({ ...p, content_hash: sha256(`${p.title}\n${p.content}`), updated_at: new Date().toISOString() }))
    const changed = rows.filter((r) => {
      const e = prev.get(r.id)
      return !e || e.content_hash !== r.content_hash || e.embedding === null
    })

    let embedded = 0
    for (const part of chunk(changed, 50)) {
      const vectors = await ai.embed(part.map((r) => `${r.title}\n${r.content}`), 'document', { maxWaitMs: 70_000 })
      const { error: upsertError } = await db
        .from('knowledge_chunks')
        .upsert(part.map((r, i) => ({ ...r, embedding: toPgVector(Array.from(vectors[i]!)) })))
      if (upsertError) throw upsertError
      embedded += part.length
    }

    const keep = new Set(rows.map((r) => r.id))
    const removedIds = [...prev.keys()].filter((id) => !keep.has(id))
    if (removedIds.length) await db.from('knowledge_chunks').delete().in('id', removedIds)

    await this.load()
    const result = { total: rows.length, embedded, removed: removedIds.length }
    logger.info('knowledge ingested', result)
    return result
  },

  // Content always comes from backend/knowledge/*.md, so answers never depend on the database, a migration
  // or the AI. The database only adds embeddings (for smarter search) where they exist.
  async load(): Promise<void> {
    const sections = await readSections()
    const vectors = new Map<string, Float32Array | null>()
    try {
      const { data, error } = await db.from('knowledge_chunks').select('id, content_hash, embedding')
      if (error) throw error
      const hashes = new Map(sections.map((x) => [x.id, sha256(`${x.title}\n${x.content}`)]))
      // An embedding is used only if it was made from the current text of that section.
      for (const r of data) if (hashes.get(r.id) === r.content_hash) vectors.set(r.id, parseVector(r.embedding))
    } catch (err) {
      logger.warn('knowledge embeddings unavailable; using keyword search', errorFields(err))
    }
    chunks = sections.map((x) => ({ ...x, embedding: vectors.get(x.id) ?? null }))
    logger.info('knowledge loaded', { chunks: chunks.length, withEmbeddings: [...vectors.values()].filter(Boolean).length })
  },

  // One section by id, e.g. 'ka/competition#1' (falls back to English).
  section(id: string): KnowledgeChunk | undefined {
    return chunks.find((c) => c.id === id) ?? chunks.find((c) => c.id === id.replace(/^(ka|ru)\//, 'en/'))
  },

  // Best sections in the user's language (English if that language has none).
  async search(query: string, k = 4, sessionId?: string, locale: Locale = 'en', topic?: string): Promise<KnowledgeHit[]> {
    const inTopic = topic ? chunks.filter((c) => c.topic === topic) : chunks
    const inLanguage = inTopic.filter((c) => c.language === locale)
    const pool = inLanguage.length ? inLanguage : inTopic.filter((c) => c.language === 'en')
    if (pool.length === 0) return []
    // Embeddings where this language has them (better for paraphrases); keyword search otherwise,
    // so answers never depend on embeddings existing or the embedding model being available.
    if (pool.some((c) => c.embedding)) {
      try {
        const [q] = await ai.embed([query], 'query', { sessionId, maxWaitMs: 1_500 })
        const semantic = pool
          .filter((c) => c.embedding)
          .map((c) => {
            const score = cosine(q!, c.embedding!)
            return { ...c, score, confident: score >= 0.5 }
          })
          .sort((a, b) => b.score - a.score)
          .filter((h) => h.score > 0.35)
          .slice(0, k)
        if (semantic.length) return semantic
      } catch (err) {
        logger.warn('knowledge embed failed; using keyword search', errorFields(err))
      }
    }
    const idf = idfFor(pool)
    return pool
      .map((c) => {
        const score = keywordScore(query, c, idf)
        return { ...c, score, confident: score >= 0.5 }
      })
      .sort((a, b) => b.score - a.score)
      .filter((h) => h.score > 0.2)
      .slice(0, k)
  },
}
