import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import { env } from '../../pkg/env/env.js'
import { AppError } from '../../shared/http/app-error.js'
import { sameOrigin } from '../../shared/http/origin.js'
import { RateLimiter } from '../../shared/http/rate-limit.js'
import { pick } from '../../shared/i18n/locale.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { AiUnavailableError } from '../ai/ai.gateway.js'
import { chatModels, MODEL_INFO, modelChains } from '../ai/ai.models.js'
import { quota } from '../ai/ai.quota.js'
import { requireUser, type User } from '../auth/auth.service.js'
import { clearOpenConversation, openConversationId, setOpenConversation } from './chat.cookie.js'
import { z } from 'zod'
import { agentTurn } from './agent/agent.service.js'
import { AUDIO_TYPES, MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, transcribe } from './voice/voice.service.js'
import { createSessionSchema, feedbackSchema, sendMessageSchema } from './chat.model.js'
import { chatRepository, type Session } from './chat.repository.js'
import { profileItems, entryQuickReplies, texts } from './templates/templates.js'

// Limits per signed-in user (every chat request has one).
const chatsPerUser = new RateLimiter(env.SESSIONS_PER_HOUR, 60 * 60_000)
const messagesPerSession = new RateLimiter(env.CHAT_MESSAGES_PER_MINUTE, 60_000)
const messagesPerUser = new RateLimiter(env.CHAT_MESSAGES_PER_DAY, 24 * 60 * 60_000)
const inFlight = new Set<string>()
const voicePerSession = new RateLimiter(6, 60_000)

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
    })
  })

  .get('/usage', async (c) => {
    await requireUser(c)
    return c.json(usage())
  })

  // Chat history.
  .get('/conversations', async (c) => {
    const user = await requireUser(c)
    return c.json({ items: await chatRepository.listForUser(user.id) })
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

  .post('/feedback', limit, async (c) => {
    const { session } = await requireConversation(c)
    const body = await json(c, (b) => feedbackSchema.parse(b))
    const ok = await chatRepository.addFeedback(session.id, body.messageId, body.rating, body.comment)
    if (!ok) throw new AppError('not_found', 'Message not found')
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
        try {
          await agentTurn({
            session,
            input,
            signal: controller.signal,
            emit: (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) }),
          })
        } catch (err) {
          const safe = err instanceof AppError ? err : new AppError('internal', 'Something went wrong. Please try again.')
          if (!(err instanceof AppError)) logger.error('chat turn failed', { session: session.id, ...errorFields(err) })
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: safe.code, message: safe.message, ...safe.details }) })
        } finally {
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
