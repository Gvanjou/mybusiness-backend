import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { env } from '../../pkg/env/env.js'
import { AppError } from '../../shared/http/app-error.js'
import { sameOrigin } from '../../shared/http/origin.js'
import { RateLimiter } from '../../shared/http/rate-limit.js'
import { localeSchema, pick } from '../../shared/i18n/locale.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { AiUnavailableError } from '../ai/ai.gateway.js'
import { chatModels, MODEL_INFO, modelChains } from '../ai/ai.models.js'
import { quota } from '../ai/ai.quota.js'
import { requireUser, type User } from '../auth/auth.service.js'
import { clearOpenConversation, openConversationId, setOpenConversation } from './chat.cookie.js'
import { z } from 'zod'
import { alerts } from '../alerts/alerts.service.js'
import { catalog } from '../catalog/catalog.service.js'
import { normalizeCity, knownCategoryKeys } from '../catalog/catalog.labels.js'
import { applyPatch } from './profile/profile.merge.js'
import { agentTurn } from './agent/agent.service.js'
import { cardFor } from './agent/agent.facts.js'
import { AUDIO_TYPES, MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, transcribe } from './voice/voice.service.js'
import { callTool, isSlowTool, saveTurn, startCall } from './voice/voice.live.js'
import { createSessionSchema, feedbackSchema, sendMessageSchema, sessionStateSchema } from './chat.model.js'
import { chatRepository, type Session } from './chat.repository.js'
import { profileItems, entryQuickReplies, texts } from './templates/templates.js'

// Limits per signed-in user (every chat request has one).
const chatsPerUser = new RateLimiter(env.SESSIONS_PER_HOUR, 60 * 60_000)
const messagesPerSession = new RateLimiter(env.CHAT_MESSAGES_PER_MINUTE, 60_000)
const messagesPerUser = new RateLimiter(env.CHAT_MESSAGES_PER_DAY, 24 * 60 * 60_000)
const inFlight = new Set<string>()
const voicePerSession = new RateLimiter(6, 60_000)
const callsPerUser = new RateLimiter(10, 60 * 60_000)
const voiceToolBusy = new Set<string>() // one tool at a time per chat: they change its state
const PING_MS = 5_000

const profileEditSchema = z.object({
  key: z.enum(['budgetGel', 'cities', 'sectors', 'involvement', 'goal']),
  value: z.union([z.number(), z.string().max(40), z.array(z.string().max(40)).max(5)]).optional(),
  remove: z.boolean().optional(),
})

const limit = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new AppError('payload_too_large', 'Request body too large')
  },
})

// The open conversation of the signed-in user (from the mb_chat cookie). 404 no_session when none is open.
async function requireConversation(c: Context): Promise<{ user: User; session: Session }> {
  const user = await requireUser(c)
  const id = openConversationId(c)
  const session = id ? await chatRepository.findForUser(id, user.id) : null
  if (!session) {
    clearOpenConversation(c)
    throw new AppError('no_session', 'No conversation')
  }
  return { user, session }
}

// Today's use of the free Gemini allowance, shared by everyone: answered requests out of the daily total of all the
// models the chat uses. Everyone sees the same figure; at 100% the chat waits for Google's reset.
function usage() {
  const { used, total, resetsAt } = quota.usage(chatModels())
  return { requestsUsed: used, requestsTotal: total, usedPct: total ? Math.min(100, Math.round((used / total) * 100)) : 0, resetsAt }
}

async function json<T>(c: Context, parse: (v: unknown) => T): Promise<T> {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    throw new AppError('bad_request', 'Invalid JSON')
  }
  try {
    return parse(body)
  } catch {
    throw new AppError('bad_request', 'Invalid request')
  }
}

// /api/assistant: the chat. Sign-in is required; conversations belong to the user and stay in the history.
export const chatRoutes = new Hono()
  .use(sameOrigin)
  // The models the chat can use, with today's state, for the model picker.
  .get('/models', async (c) => {
    await requireUser(c)
    return c.json({
      models: modelChains.responder.map((id) => ({ id, name: MODEL_INFO[id]?.name ?? id, tier: MODEL_INFO[id]?.tier ?? 'flash', ...quota.status(id) })),
      resetsAt: quota.usage(chatModels()).resetsAt,
      voice: env.VOICE_ENABLED, // the UI shows the call button only then
    })
  })

  .get('/usage', async (c) => {
    await requireUser(c)
    return c.json(usage())
  })

  // Chat history: every chat except the one in progress. The open chat is in progress when it is the user's newest;
  // it joins the history once they start a new chat. A chat reopened from the history stays listed (and deleting
  // it starts a new chat, see the client).
  .get('/conversations', async (c) => {
    const user = await requireUser(c)
    const [items, newest] = await Promise.all([chatRepository.listForUser(user.id), chatRepository.newestForUser(user.id)])
    const open = openConversationId(c)
    return c.json({ items: items.filter((i) => !(i.id === open && i.id === newest)) })
  })

  // Deletes one chat from the history (on the user's request only).
  .delete('/conversations/:id', async (c) => {
    const user = await requireUser(c)
    const session = await chatRepository.findForUser(c.req.param('id'), user.id)
    if (!session) throw new AppError('not_found', 'Conversation not found')
    await chatRepository.deleteSession(session.id)
    if (openConversationId(c) === session.id) clearOpenConversation(c)
    return c.body(null, 204)
  })

  // The open conversation (history + profile).
  .get('/session', async (c) => {
    const { session } = await requireConversation(c)
    const messages = await chatRepository.recentMessages(session.id, 60)
    return c.json({
      id: session.id,
      title: session.title,
      locale: session.locale,
      profile: profileItems(session.profile, session.locale),
      messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, payload: m.payload, createdAt: m.createdAt })),
      voice: env.VOICE_ENABLED, // with the chat itself, so the voice button is there on a fresh chat too
    })
  })

  // A new chat; earlier ones stay in the history.
  .post('/session', limit, async (c) => {
    const user = await requireUser(c)
    chatsPerUser.hit(user.id)
    const { locale } = await json(c, (b) => createSessionSchema.parse(b))
    const session = await chatRepository.createSession(locale, user.id)
    const greeting = pick(texts.greeting, locale)
    await chatRepository.addMessage(session.id, { role: 'assistant', content: greeting, intent: 'greeting', payload: { quickReplies: entryQuickReplies(locale) } })
    setOpenConversation(c, session.id)
    return c.json({ locale }, 201)
  })

  // Opens a chat from the history.
  .put('/session', limit, async (c) => {
    const user = await requireUser(c)
    const { id } = await json(c, (b) => z.object({ id: z.uuid() }).parse(b))
    if (!(await chatRepository.findForUser(id, user.id))) throw new AppError('not_found', 'Conversation not found')
    setOpenConversation(c, id)
    return c.body(null, 204)
  })

  // Voice message → text. The client puts the text in the input box; it is then sent like any typed message.
  .post(
    '/transcribe',
    bodyLimit({
      maxSize: MAX_AUDIO_BYTES,
      onError: () => {
        throw new AppError('payload_too_large', 'Recording is too long')
      },
    }),
    async (c) => {
      const { user, session } = await requireConversation(c)
      voicePerSession.hit(session.id)
      messagesPerUser.hit(user.id)
      const mimeType = (c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!AUDIO_TYPES.has(mimeType)) throw new AppError('bad_request', 'Unsupported audio format')
      const audio = new Uint8Array(await c.req.arrayBuffer())
      if (audio.byteLength < MIN_AUDIO_BYTES) throw new AppError('bad_request', 'Recording is too short')
      try {
        const result = await transcribe(audio, mimeType, session.id)
        return c.json(result ?? { text: '', language: session.locale })
      } catch (err) {
        if (err instanceof AiUnavailableError) throw new AppError('rate_limited', 'Voice input is busy right now, please type your message.', 30)
        throw err
      }
    },
  )

  // Voice calls (Gemini Live, behind VOICE_ENABLED). A locked one-time token for the browser's audio connection to
  // Google; the model's tool calls come back here; each finished exchange is saved as two chat messages.
  .post('/voice/session', limit, async (c) => {
    if (!env.VOICE_ENABLED) throw new AppError('not_found', 'Not found')
    const { user, session } = await requireConversation(c)
    const { locale } = await json(c, (b) => z.object({ locale: localeSchema.optional() }).parse(b ?? {}))
    callsPerUser.hit(user.id)
    return c.json(await startCall(session, user.id, locale ?? session.locale), 201)
  })

  .post('/voice/tool', limit, async (c) => {
    if (!env.VOICE_ENABLED) throw new AppError('not_found', 'Not found')
    const { session } = await requireConversation(c)
    const { name, args } = await json(c, (b) => z.object({ name: z.string().max(60), args: z.record(z.string(), z.unknown()).default({}) }).parse(b))
    if (voiceToolBusy.has(session.id)) throw new AppError('rate_limited', 'Another tool is still running.', 1)
    voiceToolBusy.add(session.id)
    try {
      return c.json({ ...(await callTool(session, name, args)), slow: isSlowTool(name) })
    } finally {
      voiceToolBusy.delete(session.id)
    }
  })

  .post('/voice/turn', limit, async (c) => {
    if (!env.VOICE_ENABLED) throw new AppError('not_found', 'Not found')
    const { user, session } = await requireConversation(c)
    const body = await json(c, (b) => z.object({ userText: z.string().max(4_000).default(''), assistantText: z.string().max(8_000).default(''), ended: z.boolean().default(false), userSeconds: z.number().int().min(0).max(3_600).optional(), interrupted: z.boolean().optional(), locale: localeSchema.optional() }).parse(b))
    if (body.userText.trim() || body.assistantText.trim()) messagesPerUser.hit(user.id)
    await saveTurn(session, body.userText.trim(), body.assistantText.trim(), body.ended, { userSeconds: body.userSeconds, interrupted: body.interrupted, locale: body.locale })
    return c.body(null, 204)
  })

  .post('/feedback', limit, async (c) => {
    const { session } = await requireConversation(c)
    const body = await json(c, (b) => feedbackSchema.parse(b))
    const ok = await chatRepository.addFeedback(session.id, body.messageId, body.rating, body.comment)
    if (!ok) throw new AppError('not_found', 'Message not found')
    return c.body(null, 204)
  })

  // The memory strip: the client corrects or removes something the assistant remembers. The next answer confirms it
  // in one line.
  .patch('/profile', limit, async (c) => {
    const { session } = await requireConversation(c)
    const body = await json(c, (b) => profileEditSchema.parse(b))
    let profile = structuredClone(session.profile)
    const state = structuredClone(session.state)
    if (body.remove) {
      delete profile[body.key]
      if (body.key === 'cities') delete profile.locationFlexible
    } else {
      const s = await catalog.get()
      const v = body.value
      const patch: Record<string, unknown> = {}
      if (body.key === 'budgetGel' && typeof v === 'number' && v >= 500) patch.budgetGel = Math.round(v)
      if (body.key === 'cities' && Array.isArray(v)) {
        const cities = v.map((x) => normalizeCity(String(x), s.cities)).filter((x): x is string => x !== null)
        if (cities.length) Object.assign(patch, { cities, locationFlexible: false })
        else if (v.length === 0) patch.locationFlexible = true
      }
      if (body.key === 'sectors' && Array.isArray(v)) patch.sectors = v.map(String).filter((x) => knownCategoryKeys.includes(x))
      if ((body.key === 'involvement' || body.key === 'goal') && typeof v === 'string') patch[body.key] = v
      if (!Object.keys(patch).length) throw new AppError('bad_request', 'Invalid value')
      profile = applyPatch(profile, patch, session.turnCount).profile
    }
    state.profileEdited = [...new Set([...state.profileEdited, body.key])]
    await chatRepository.saveSession({ ...session, profile, state })
    return c.json({ items: profileItems(profile, session.locale) })
  })

  // Saved searches with listings published since the client last looked.
  .get('/alerts', async (c) => {
    const user = await requireUser(c)
    const [s, list] = await Promise.all([catalog.get(), alerts.listForUser(user.id)])
    const open = openConversationId(c)
    const locale = (open && (await chatRepository.findForUser(open, user.id))?.locale) || 'ka'
    return c.json({
      items: list.map((a) => {
        const fresh = alerts.newMatches(a, s)
        // These cards are not numbered: they belong to no chat yet.
        const cards = fresh.slice(0, 3).map((l) => ({ ...cardFor(l, s, sessionStateSchema.parse({}), locale), n: undefined }))
        return { id: a.id, label: a.label, newCount: fresh.length, cards }
      }),
    })
  })

  .post('/alerts/:id/seen', limit, async (c) => {
    const user = await requireUser(c)
    await alerts.markSeen(user.id, c.req.param('id'))
    return c.body(null, 204)
  })

  .delete('/alerts/:id', async (c) => {
    const user = await requireUser(c)
    if (!(await alerts.remove(user.id, c.req.param('id')))) throw new AppError('not_found', 'Alert not found')
    return c.body(null, 204)
  })

  .post('/messages', limit, async (c) => {
    const { user, session } = await requireConversation(c)
    const input = await json(c, (b) => sendMessageSchema.parse(b))
    messagesPerSession.hit(session.id)
    messagesPerUser.hit(user.id)
    if (usage().usedPct >= 100) throw new AppError('daily_limit', 'Today’s free AI allowance is used up. It renews when Google resets the daily limits.')
    if (inFlight.has(session.id)) throw new AppError('rate_limited', 'Please wait for the current answer to finish.', 2)
    inFlight.add(session.id)

    return streamSSE(
      c,
      async (stream) => {
        const controller = new AbortController()
        stream.onAbort(() => controller.abort())
        // A comment line every few seconds: proxies keep the connection open while a tool runs or a model thinks,
        // and the client can tell a slow answer from a dead stream.
        const ping = setInterval(() => {
          if (!stream.aborted && !stream.closed) void stream.write(': ping\n\n').catch(() => undefined)
        }, PING_MS)
        try {
          await agentTurn({
            session,
            input,
            signal: controller.signal,
            emit: async (event, data) => {
              if (stream.aborted || stream.closed) return
              await stream.writeSSE({ event, data: JSON.stringify(data) })
            },
          })
        } catch (err) {
          const safe = err instanceof AppError ? err : new AppError('internal', 'Something went wrong. Please try again.')
          if (!(err instanceof AppError)) logger.error('chat turn failed', { session: session.id, ...errorFields(err) })
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: safe.code, message: safe.message, ...safe.details }) })
        } finally {
          clearInterval(ping)
          inFlight.delete(session.id)
        }
      },
      async (err, stream) => {
        inFlight.delete(session.id)
        logger.error('sse stream error', errorFields(err))
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'internal', message: 'Stream failed' }) })
      },
    )
  })
