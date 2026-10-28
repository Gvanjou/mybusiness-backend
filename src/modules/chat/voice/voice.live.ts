import { Behavior, Modality, StartSensitivity, Type, type FunctionDeclaration, type LiveConnectConfig } from '@google/genai'
import { z } from 'zod'
import { env } from '../../../pkg/env/env.js'
import { gemini } from '../../../pkg/gemini/gemini.js'
import { db } from '../../../pkg/supabase/supabase.js'
import { AppError } from '../../../shared/http/app-error.js'
import { logger, errorFields } from '../../../shared/logger/logger.js'
import { ai } from '../../ai/ai.gateway.js'
import { chainFor, KEY_ID } from '../../ai/ai.models.js'
import { catalog } from '../../catalog/catalog.service.js'
import type { Locale } from '../../../shared/i18n/locale.js'
import { nextSteps } from '../agent/agent.next.js'
import { agentContext, titleFrom } from '../agent/agent.service.js'
import { budgetPatch, emptyOutput, runTool, statedMoney, toolDeclarations, type ToolContext, type ToolOutput } from '../agent/agent.tools.js'
import { chatRepository, type Session } from '../chat.repository.js'
import { applyPatch } from '../profile/profile.merge.js'
import { val } from '../profile/profile.model.js'
import type { QuickReply } from '../planner/planner.service.js'
import { profileItems } from '../templates/templates.js'
import type { ListingCard } from '../tools/cards.js'
import { voiceSystem } from './voice.prompt.js'

// Voice calls with Gemini Live (a spike). The browser streams audio to Google itself, with a one-time token this
// backend creates and locks to our model, brief and tools, so the browser cannot change them and never sees the key.
// The tools still run here (/voice/tool), on the same chat state as text, so a call and the chat share the listing
// numbers, the fact sheets and the profile. What the tools put on screen is kept here and saved with the turn.

// A Live connection lasts about 10 minutes; the spike ends the call there instead of resuming it.
export const CALL_SECONDS = 10 * 60

// The tools a call can use: what a spoken consultation needs. The slow ones run while the model keeps talking
// ("let me look…"); their result is read when the model is idle.
const VOICE_TOOLS = ['search_listings', 'get_listing', 'compare_listings', 'location_analysis', 'profit_scenarios', 'seller_message', 'update_profile']
const SLOW = new Set(['search_listings', 'compare_listings', 'location_analysis', 'profit_scenarios'])

const showNote: FunctionDeclaration = {
  name: 'show_note',
  description: 'Put written text on the client\'s screen instead of reading it out: a list of risks, the steps to check, questions. Markdown, in the reply language.',
  parameters: { type: Type.OBJECT, properties: { markdown: { type: Type.STRING, description: 'The text, short; "- " lists and **bold** only' } }, required: ['markdown'] },
}

export const voiceTools: FunctionDeclaration[] = [
  ...toolDeclarations.filter((t) => VOICE_TOOLS.includes(t.name ?? '')).map((t) => (SLOW.has(t.name ?? '') ? { ...t, behavior: Behavior.NON_BLOCKING } : t)),
  showNote,
]
const allowed = new Set([...VOICE_TOOLS, 'show_note'])

export const isSlowTool = (name: string) => SLOW.has(name)

// What the tools of the turn in progress put on screen, per chat, until the turn is saved. In memory: one server.
const pending = new Map<string, ToolOutput>()
// The whole call, per chat: when it began, every listing it found, what was said: for the summary card that closes
// it in the chat.
const calls = new Map<string, { startedAt: number; locale: Locale; cards: ListingCard[]; turns: number; lines: string[] }>()
// Recognition and the voice are locked to the call's language (final test: a silent room was transcribed as Uzbek
// and answered in Russian).
const BCP47: Record<Locale, string> = { ka: 'ka-GE', en: 'en-US', ru: 'ru-RU' }
// A call shorter than this that found nothing leaves no summary card: the messages alone are enough.
const SUMMARY_FROM_SECONDS = 10

// "Mhm. I have some experience…": fillers heard by the transcription are not part of what the client said. One at
// the start, or standing alone between sentences, in any of the three languages.
const FILLER = /(^|[.!?…]\s*)(?:m+h+m+|h+m+|u+h+|u+m+|e+r+m*|а+|э+|м+|ммм|ჰმ+|ჰ+მ|ა{2,}|ე{2,}|მ{2,}|ო{2,})[.,!…]*(?=\s|$)\s*/giu
export function cleanSpeech(text: string): string {
  return text.replace(FILLER, '$1').replace(/\s{2,}/g, ' ').trim()
}

const CALL_TITLE: Record<Locale, string> = { ka: 'ხმოვანი ჩატი', en: 'Voice chat', ru: 'Голосовой чат' }

// Minutes granted per user and day (in memory: a restart forgets, acceptable for a spike).
const minutes = new Map<string, { day: string; seconds: number }>()

function grant(userId: string): number {
  const day = new Date().toISOString().slice(0, 10)
  const used = minutes.get(userId)
  const spent = used?.day === day ? used.seconds : 0
  const left = env.VOICE_MINUTES_PER_DAY * 60 - spent
  if (left < 60) throw new AppError('daily_limit', 'Today’s voice minutes are used up. You can keep typing.')
  const seconds = Math.min(CALL_SECONDS, left)
  minutes.set(userId, { day, seconds: spent + seconds })
  return seconds
}

async function toolContext(session: Session): Promise<ToolContext> {
  const state = structuredClone(session.state)
  const s = await catalog.withDetails(await catalog.get(), [...state.lastShown, ...(state.contextListingId ? [state.contextListingId] : [])])
  return { s, sessionId: session.id, userId: session.userId, turn: session.turnCount, locale: session.locale, profile: session.profile, state, out: emptyOutput(), progress: async () => {}, userText: '', earlier: [] }
}

// The locked configuration of a call: model, brief with this chat's CONTEXT, tools, voice, transcripts both ways.
export async function liveConfig(session: Session): Promise<LiveConnectConfig> {
  const ctx = await toolContext(session)
  const language = BCP47[session.locale]
  return {
    responseModalities: [Modality.AUDIO],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.GEMINI_LIVE_VOICE } }, languageCode: language },
    systemInstruction: voiceSystem(session.locale, agentContext(ctx)),
    tools: [{ functionDeclarations: voiceTools }],
    inputAudioTranscription: { languageCodes: [language] },
    outputAudioTranscription: { languageCodes: [language] },
    // The browser reconnects with the handle Google gives it when the network drops.
    sessionResumption: {},
    // End of the client's turn after 0.7 s of silence (Google's default cuts a slow sentence off sooner), and a start
    // of speech that needs real speech, not a chair creaking (Gemini Live's default sensitivity is high).
    realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 700, prefixPaddingMs: 200, startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW } },
  }
}

// locale: the language the client sees the app in, which the call follows (the chat's stored language may lag behind
// a switch of the interface).
export async function startCall(session: Session, userId: string, locale: Locale = session.locale): Promise<{ token: string; model: string; expiresAt: string; maxSeconds: number; listings: number }> {
  const maxSeconds = grant(userId)
  const started = Date.now()
  const listings = (await catalog.get()).listings.length
  if (locale !== session.locale) {
    session = { ...session, locale }
    await chatRepository.saveSession(session)
  }
  const expiresAt = new Date(started + (maxSeconds + 60) * 1000).toISOString()
  const token = await gemini.authTokens.create({
    config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(started + 60_000).toISOString(),
      // With no lockAdditionalFields the whole setup is locked: the browser can change nothing. (An empty list makes
      // the SDK send a field mask Google rejects: "field_mask is invalid for BidiGenerateContentSetup".)
      liveConnectConstraints: { model: env.GEMINI_LIVE_MODEL, config: await liveConfig(session) },
      httpOptions: { apiVersion: 'v1alpha' }, // ephemeral tokens exist in v1alpha only
    },
  })
  if (!token.name) throw new AppError('ai_unavailable', 'Voice is not available right now.', 30)
  pending.delete(session.id)
  calls.set(session.id, { startedAt: started, locale, cards: [], turns: 0, lines: [] })
  logCall(session.id, Date.now() - started)
  return { token: token.name, model: env.GEMINI_LIVE_MODEL, expiresAt, maxSeconds, listings }
}

// One row per call in the usage log, so voice use is visible next to the chat's.
function logCall(sessionId: string, ms: number): void {
  void db
    .from('llm_usage')
    .insert({ task: 'voice', model: env.GEMINI_LIVE_MODEL, outcome: 'ok', latency_ms: ms, session_id: sessionId, key_id: KEY_ID })
    .then(({ error }) => {
      if (error) logger.warn('voice usage insert failed', errorFields(error))
    })
}

// A tool the model called during the call: run on this chat's state, which is saved; what it shows is kept for the
// turn, with up to two next-step chips the client can tap instead of saying them.
export async function callTool(session: Session, name: string, args: Record<string, unknown>): Promise<{ result: unknown; ui: Partial<ToolOutput> & { chips: QuickReply[] } }> {
  if (!allowed.has(name)) return { result: { error: `Unknown tool ${name}` }, ui: { chips: [] } }
  const ctx = await toolContext(session)
  const result = await runTool(name, args, ctx)
  const chips = nextSteps(ctx, [name], null, []).filter((q) => q.kind === 'message').slice(0, 2)
  await chatRepository.saveSession({ ...session, profile: ctx.profile, state: ctx.state })
  const turn = pending.get(session.id) ?? emptyOutput()
  const out = ctx.out
  const call = calls.get(session.id)
  if (call) call.cards = [...call.cards, ...out.cards.filter((c) => !call.cards.some((x) => x.id === c.id))]
  pending.set(session.id, {
    ...turn,
    cards: [...turn.cards, ...out.cards.filter((c) => !turn.cards.some((x) => x.id === c.id))],
    compare: out.compare ?? turn.compare,
    handoff: out.handoff ?? turn.handoff,
    sources: [...turn.sources, ...out.sources],
    note: [turn.note, out.note].filter(Boolean).join('\n\n') || null,
  })
  return { result, ui: { cards: out.cards, compare: out.compare, handoff: out.handoff, sources: out.sources, note: out.note, chips } }
}

// One spoken exchange, saved as a normal pair of chat messages; the chat goes on by typing after the call. The last
// one (ended) is followed by the call's summary card: its length, what was learned about the client, the listings
// found.
export async function saveTurn(session: Session, spoken: string, assistantText: string, ended = false, extra: { userSeconds?: number; interrupted?: boolean; locale?: Locale } = {}): Promise<void> {
  const out = pending.get(session.id) ?? emptyOutput()
  pending.delete(session.id)
  const call = calls.get(session.id)
  const locale = call?.locale ?? extra.locale ?? session.locale
  const userText = cleanSpeech(spoken)
  // A budget said in the call goes to the memory strip as said ("$150 000"), like one typed in the chat.
  let profile = session.profile
  if (userText) {
    const money = statedMoney(userText, (await catalog.get()).rates)
    if (money && money.gel !== val(profile, 'budgetGel')) profile = applyPatch(profile, budgetPatch(money), session.turnCount + 1).profile
  }
  if (userText) {
    await chatRepository.addMessage(session.id, { role: 'user', content: userText, intent: 'voice', payload: { voice: true, ...(extra.userSeconds ? { voiceSeconds: extra.userSeconds } : {}) } })
    call?.lines.push(`Client: ${userText}`)
  }
  if (assistantText || out.cards.length || out.compare || out.handoff || out.note) {
    await chatRepository.addMessage(session.id, {
      role: 'assistant',
      content: assistantText,
      intent: 'voice',
      payload: { cards: out.cards, compare: out.compare, handoff: out.handoff ?? undefined, sources: out.sources, note: out.note ?? undefined, voice: true, ...(extra.interrupted ? { interrupted: true } : {}) },
    })
    if (call) {
      call.turns++
      if (assistantText) call.lines.push(`Consultant: ${assistantText}`)
    }
  }
  const state = { ...session.state, cardsShown: [...new Set([...session.state.cardsShown, ...out.cards.map((c) => c.id)])].slice(-60) }
  const updated: Session = { ...session, locale, profile, state, title: session.title ?? (userText ? titleFrom(userText) : ended ? CALL_TITLE[locale] : null), turnCount: session.turnCount + 1 }
  if (ended && call) {
    calls.delete(session.id)
    const seconds = Math.round((Date.now() - call.startedAt) / 1000)
    if ((call.turns || call.cards.length) && (seconds >= SUMMARY_FROM_SECONDS || call.cards.length)) {
      const facts = profileItems(profile, locale).map((i) => i.value)
      const [summary, chips] = await Promise.all([summarizeCall(session.id, call.lines, locale), nextStepsAfterCall(updated)])
      await chatRepository.addMessage(session.id, {
        role: 'assistant',
        content: '',
        intent: 'voice',
        payload: { callSummary: { seconds, at: new Date().toISOString(), facts, ...(summary ? { summary } : {}) }, cards: call.cards, quickReplies: chips, voice: true },
      })
    }
  }
  await chatRepository.saveSession(updated)
}

// Two or three sentences on what the call was about, written by a light model from what was said; the facts list
// stands in when it cannot be had (one request per call, nothing when the call said nothing).
const summarySchema = z.object({ summary: z.string() })
const LANGUAGE: Record<Locale, string> = { ka: 'Georgian', en: 'English', ru: 'Russian' }
async function summarizeCall(sessionId: string, lines: string[], locale: Locale): Promise<string | null> {
  if (!lines.length) return null
  try {
    const { summary } = await ai.generateJson('responder', {
      system: `Summarise this voice call between the business consultant of MyBusiness.ge and a client in two or three short sentences, in ${LANGUAGE[locale]}: what the client is looking for (budget, city, kind of business, how involved they want to be) and the main conclusion or next step. Plain words, no markdown, no figures the transcript does not contain.`,
      contents: lines.join('\n').slice(-6_000),
      schema: summarySchema,
      sessionId,
      maxWaitMs: 1_500,
      chain: chainFor(''),
    })
    return summary.trim().slice(0, 600) || null
  } catch (err) {
    logger.warn('call summary not written', errorFields(err))
    return null
  }
}

// The next-step chips under the summary card, by the chat's own rules (the listings on screen, what was done).
async function nextStepsAfterCall(session: Session): Promise<QuickReply[]> {
  try {
    const ctx = await toolContext(session)
    return nextSteps(ctx, [], null, []).slice(0, 3)
  } catch {
    return []
  }
}
