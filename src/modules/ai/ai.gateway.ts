import { ApiError, type Content, type FunctionCall, type FunctionDeclaration, type GenerateContentResponse, type Part, type Tool } from '@google/genai'
import { z } from 'zod'
import { gemini } from '../../pkg/gemini/gemini.js'
import { db } from '../../pkg/supabase/supabase.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { sleep } from '../../shared/utils/async.js'
import { EMBEDDING_DIMENSIONS, KEY_ID, modelChains, thinkingByTask, type AiTask } from './ai.models.js'
import { quota } from './ai.quota.js'

export class AiUnavailableError extends Error {
  constructor(readonly task: AiTask) {
    super(`No Gemini model available for task "${task}"`)
    this.name = 'AiUnavailableError'
  }
}

type Outcome = 'ok' | 'rate_limited' | 'error' | 'fallback'

// prefer: try this model first (an agent's later steps must stay on the model that started the answer).
// only: the client picked this model: use it and nothing else, so a busy or used-up model is reported, not hidden.
// chain: this call's own model order (e.g. light models first for a quick question).
// attempts: slow failed requests this user turn may still afford, shared by all its steps. A failed request that reached
// Google can still count against the daily allowance, so a turn never walks the whole chain. Answers don't count:
// a turn that looks something up and then writes needs two good requests.
type CallMeta = { sessionId?: string; maxWaitMs?: number; userSignal?: AbortSignal; prefer?: string; only?: string; chain?: readonly string[]; attempts?: { left: number } }

// Per-call limits: a model slower than this is skipped in favour of the next one in the chain.
// For the responder it is the time to the FIRST streamed chunk.
// Time for a model to start answering. Usually 3–10 s, but when the free tier is busy every model is slow (20 s for
// a two-word reply was measured): giving up early only sends the same slow request to the next model and spends its
// allowance too. So the responder waits up to 30 s, and after a timeout at most one other model is tried.
const callTimeoutMs: Record<AiTask, number> = { responder: 30_000, search: 25_000, transcribe: 25_000, embedding: 15_000 }
const STREAM_TOTAL_TIMEOUT_MS = 90_000
// Once a stream has started, only silence ends it: a model still sending text or a tool call is never cut.
const STREAM_IDLE_TIMEOUT_MS = 15_000

// Users come first: background jobs (no session) may use at most this share of a model's daily quota,
// so a background job can never leave the chat without answers.
const JOB_QUOTA_SHARE = 0.5

function logUsage(task: AiTask, model: string, outcome: Outcome, started: number, meta: CallMeta, usage?: { promptTokenCount?: number; candidatesTokenCount?: number }) {
  const row = {
    task,
    model,
    outcome,
    input_tokens: usage?.promptTokenCount ?? null,
    output_tokens: usage?.candidatesTokenCount ?? null,
    latency_ms: Date.now() - started,
    session_id: meta.sessionId ?? null,
  }
  void db
    .from('llm_usage')
    .insert({ ...row, key_id: KEY_ID })
    .then(async ({ error }) => {
      // Before migration 014 the column is missing: keep logging without it.
      if (error && /key_id/.test(error.message)) ({ error } = await db.from('llm_usage').insert(row))
      if (error) logger.warn('llm_usage insert failed', errorFields(error))
    })
}

// The SDK's abortSignal does not always stop a hung request: measured calls to an overloaded model that ran for
// 17 minutes despite a 20 s signal. Every model call is raced against our own timer so a turn cannot stall.
function deadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException(`${what} exceeded ${ms} ms`, 'TimeoutError')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status >= 500
  return err instanceof TypeError || isTimeout(err) // network failure or a model that is too slow
}

// Zod → JSON Schema for Gemini structured output.
function toGeminiSchema(schema: z.ZodType): unknown {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>
  delete json.$schema
  return json
}

// Google returns 500/503 when a model is temporarily overloaded; those are worth retrying on the same model.
function isOverloaded(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 503 || err.status === 500)
}

// Runs `call` against each model in the task's chain until one succeeds.
// Overload errors are retried on the same model with backoff (more patiently for background jobs);
// quota (429) and other retryable errors move straight to the next model.
async function withFallback<T>(task: AiTask, meta: CallMeta, call: (model: string) => Promise<T>): Promise<T> {
  const chain = meta.chain ?? modelChains[task]
  const maxWaitMs = meta.maxWaitMs ?? 3_000
  // Someone is waiting in the chat: a busy model is not retried, the next one is tried at once. Jobs can wait.
  const overloadRetries = meta.sessionId ? 0 : 3
  const ordered = meta.only ? [meta.only] : quota.order(chain, task)
  const models = meta.prefer && ordered.includes(meta.prefer) ? [meta.prefer, ...ordered.filter((m) => m !== meta.prefer)] : ordered
  let timedOut = false
  for (const model of models) {
    if (meta.attempts && meta.attempts.left <= 0) break
    if (!(await quota.acquire(model, maxWaitMs, meta.sessionId ? 1 : JOB_QUOTA_SHARE))) continue
    for (let attempt = 0; ; attempt++) {
      const started = Date.now()
      try {
        const result = await call(model)
        // For the chat `call` resolves at the first streamed chunk: this is the wait the client feels.
        quota.recordSuccess(model, Date.now() - started, task)
        quota.recordOk(model)
        return result
      } catch (err) {
        const status = err instanceof ApiError ? err.status : undefined
        // A daily limit ("retry in 21h…", "per day") is out until the reset; a per-minute one cools down briefly.
        if (status === 429) {
          if (/per ?day|PerDay|retry in \d+h/i.test(err instanceof Error ? err.message : String(err))) quota.markExhausted(model)
          else quota.coolDown(model)
        }
        logUsage(task, model, status === 429 ? 'rate_limited' : 'error', started, meta)
        // A quick refusal ("limit reached" in 0.3 s, "high demand" in 1 s) did no work and costs nothing; a slow
        // failure may have been processed and counted.
        if (meta.attempts && Date.now() - started > 5_000) meta.attempts.left--
        logger.warn('gemini call failed', { task, model, status, attempt, ...errorFields(err) })
        if (meta.userSignal?.aborted) throw err // the user left; don't try other models
        if (!isRetryable(err)) throw err
        // Overloaded (503), too slow or unreachable: tried after the healthy models for a while. A 429 is not the
        // model's health: the per-minute and daily limits above handle it.
        if (status !== 429) quota.recordFailure(model)
        if (isTimeout(err)) {
          // A second timeout means Google is slow for every model: stop instead of spending more allowance.
          if (timedOut) throw new AiUnavailableError(task)
          timedOut = true
        }
        // A timeout already cost a lot of time: go to the next model instead of waiting again.
        if (!isOverloaded(err) || attempt >= overloadRetries) break
        await sleep((meta.sessionId ? 600 : 2_000) * 2 ** attempt)
      }
    }
  }
  throw new AiUnavailableError(task)
}

// One answer grounded in Google Search or Google Maps; the sources are the pages or places it used.
function grounded(tool: Tool, prompt: string, at: { lat: number; lon: number } | undefined, meta: CallMeta): Promise<{ text: string; sources: { title: string; url: string }[] }> {
  const task = 'search' as const
  return withFallback(task, meta, async (model) => {
    const started = Date.now()
    const res = await deadline(
      gemini.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [tool],
          toolConfig: at ? { retrievalConfig: { latLng: { latitude: at.lat, longitude: at.lon } } } : undefined,
          thinkingConfig: { thinkingLevel: thinkingByTask[task] },
          abortSignal: AbortSignal.timeout(callTimeoutMs[task]),
        },
      }),
      callTimeoutMs[task],
      `${task} on ${model}`,
    )
    logUsage(task, model, 'ok', started, meta, res.usageMetadata)
    const sources = (res.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
      .map((c) => c.web ?? c.maps)
      .filter((w): w is { uri: string; title?: string } => Boolean(w?.uri))
      .map((w) => ({ title: w.title ?? '', url: w.uri }))
    return { text: res.text ?? '', sources }
  })
}

export const ai = {
  // Structured output validated against a Zod schema.
  async generateJson<S extends z.ZodType>(
    task: Exclude<AiTask, 'embedding'>,
    params: { system: string; contents: Content[] | string; schema: S; temperature?: number } & CallMeta,
  ): Promise<z.infer<S>> {
    const responseJsonSchema = toGeminiSchema(params.schema)
    return withFallback(task, params, async (model) => {
      const started = Date.now()
      const res = await deadline(
        gemini.models.generateContent({
        model,
        contents: params.contents,
        config: {
          systemInstruction: params.system,
          responseMimeType: 'application/json',
          responseJsonSchema,
          temperature: params.temperature ?? 0.2,
          thinkingConfig: { thinkingLevel: thinkingByTask[task] },
          abortSignal: AbortSignal.timeout(callTimeoutMs[task]),
        },
        }),
        callTimeoutMs[task],
        `${task} on ${model}`,
      )
      const text = res.text ?? ''
      const parsed = params.schema.safeParse(JSON.parse(text))
      if (!parsed.success) {
        throw new Error(`Schema mismatch from ${model}: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
      }
      logUsage(task, model, 'ok', started, params, res.usageMetadata)
      return parsed.data
    })
  },

  // One step of a tool-using answer. Streams the visible text as it arrives and, at the end, returns the model's
  // full reply (every part, including thought signatures, which must be sent back unchanged in the next step)
  // and the tools it wants called. Falls back to the next model only before the first chunk.
  // budgetMs caps the whole step, so a slow model cannot eat the turn.
  async *agentStep(
    params: { system: string; contents: Content[]; tools: FunctionDeclaration[]; signal?: AbortSignal; budgetMs?: number } & CallMeta,
  ): AsyncGenerator<{ type: 'text'; text: string } | { type: 'done'; model: string; parts: Part[]; calls: FunctionCall[]; cut?: 'length' | 'stalled' }> {
    const task = 'responder' as const
    // budgetMs limits how long we wait for a model to START answering; a started answer may run to the hard cap.
    const startBy = Date.now() + Math.min(params.budgetMs ?? STREAM_TOTAL_TIMEOUT_MS, STREAM_TOTAL_TIMEOUT_MS)
    const endsAt = Date.now() + STREAM_TOTAL_TIMEOUT_MS
    const stream = await withFallback(task, { ...params, userSignal: params.signal }, async (model) => {
      const started = Date.now()
      const signal = AbortSignal.any([...(params.signal ? [params.signal] : []), AbortSignal.timeout(Math.max(1_000, endsAt - Date.now()))])
      const firstChunkMs = Math.min(callTimeoutMs.responder, Math.max(1_000, startBy - Date.now()))
      const iterator = await deadline(
        gemini.models.generateContentStream({
          model,
          contents: params.contents,
          config: {
            systemInstruction: params.system,
            tools: params.tools.length ? [{ functionDeclarations: params.tools }] : undefined,
            temperature: 0.5,
            // Georgian text takes many tokens per word, and thinking counts too: a full comparison needs room.
            // An answer cut at the limit is continued in the next step.
            maxOutputTokens: 12_000,
            thinkingConfig: { thinkingLevel: thinkingByTask[task] },
            abortSignal: signal,
          },
        }),
        firstChunkMs,
        `stream setup on ${model}`,
      )
      const first = await deadline(iterator.next(), firstChunkMs, `first chunk from ${model}`)
      return { model, started, firstChunkMs: Date.now() - started, iterator, first }
    })

    const parts: Part[] = []
    let usage: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number } | undefined
    let finish: string | undefined
    // The stream stopped before Google said it was finished (silence, the hard cap, a broken connection).
    let stalled = false
    const take = (chunk: GenerateContentResponse) => {
      usage = chunk.usageMetadata ?? usage
      finish = chunk.candidates?.[0]?.finishReason ?? finish
      const texts: string[] = []
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        parts.push(part)
        if (part.text && !part.thought) texts.push(part.text)
      }
      return texts
    }
    try {
      if (!stream.first.done) for (const text of take(stream.first.value)) yield { type: 'text', text }
      for (;;) {
        const left = endsAt - Date.now()
        // Past the hard cap: keep what was written instead of failing the whole turn.
        if (left <= 0) {
          logger.warn('agent step hit the hard cap; using the partial answer', { model: stream.model })
          stalled = true
          break
        }
        const chunk = await deadline(stream.iterator.next(), Math.min(STREAM_IDLE_TIMEOUT_MS, left), `chunk from ${stream.model}`)
        if (chunk.done) break
        for (const text of take(chunk.value)) yield { type: 'text', text }
      }
      logUsage(task, stream.model, 'ok', stream.started, params, usage)
      // How much of the prompt Google served from its implicit cache: the evidence for (or against) moving CONTEXT
      // out of the system instruction so the fixed rules and tools form a longer stable prefix.
      logger.info('agent step', { model: stream.model, firstChunkMs: stream.firstChunkMs, promptTokens: usage?.promptTokenCount, cachedTokens: usage?.cachedContentTokenCount ?? 0, outputTokens: usage?.candidatesTokenCount })
    } catch (err) {
      logUsage(task, stream.model, 'error', stream.started, params, usage)
      if (parts.length === 0) throw err
      logger.warn('agent step failed after streaming; using the partial answer', { model: stream.model, ...errorFields(err) })
      stalled = true
    }
    const calls = parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []))
    // cut: the answer stopped mid-way, at the output limit or because the stream went quiet; the caller continues it
    // or marks it unfinished, so a half sentence is never saved as a finished answer.
    // A stream that simply ended without a finish reason was cut off too.
    const cut = finish === 'MAX_TOKENS' ? 'length' : (stalled || !finish) && !params.signal?.aborted ? 'stalled' : undefined
    yield { type: 'done', model: stream.model, parts, calls, cut }
  },

  // A short answer from Gemini with Google Search, plus the pages it used.
  async searchWeb(prompt: string, meta: CallMeta = {}): Promise<{ text: string; sources: { title: string; url: string }[] }> {
    return grounded({ googleSearch: {} }, prompt, undefined, meta)
  },

  // A short report from Gemini with Google Maps around a point, plus the places it used.
  async searchMaps(prompt: string, at: { lat: number; lon: number }, meta: CallMeta = {}): Promise<{ text: string; sources: { title: string; url: string }[] }> {
    return grounded({ googleMaps: {} }, prompt, at, meta)
  },

  // Embeddings for documents (stored) or queries (search). Batched in one request.
  async embed(texts: string[], kind: 'document' | 'query', meta: CallMeta = {}): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    // gemini-embedding-2 takes the task as a text prefix instead of a task_type parameter.
    // Each text must be its own Content: a plain string array is treated as ONE multi-part input (one vector).
    const contents = texts.map((t) => ({
      parts: [{ text: kind === 'query' ? `task: search result | query: ${t}` : `title: none | text: ${t}` }],
    }))
    return withFallback('embedding', meta, async (model) => {
      const started = Date.now()
      const res = await gemini.models.embedContent({
        model,
        contents,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS, abortSignal: AbortSignal.timeout(callTimeoutMs.embedding) },
      })
      const vectors = (res.embeddings ?? []).map((e) => Float32Array.from(e.values ?? []))
      if (vectors.length !== texts.length) throw new Error('Embedding count mismatch')
      logUsage('embedding', model, 'ok', started, meta)
      return vectors
    })
  },
}
