import type { Content, Part } from '@google/genai'
import { formatGel, pick, type Locale } from '../../../shared/i18n/locale.js'
import { logger, errorFields } from '../../../shared/logger/logger.js'
import { AppError } from '../../../shared/http/app-error.js'
import { ai } from '../../ai/ai.gateway.js'
import { chainFor, chatModels, MODEL_INFO, modelChains } from '../../ai/ai.models.js'
import { quota } from '../../ai/ai.quota.js'
import { categoriesNamed, categoryLabel } from '../../catalog/catalog.labels.js'
import { catalog } from '../../catalog/catalog.service.js'
import type { Emit, SendMessage } from '../chat.model.js'
import { chatRepository, type Session, type StoredMessage } from '../chat.repository.js'
import { looksLikeCode, screenMessage } from '../guard/guard.service.js'
import { optionPatch, showResultsReply, type QuickReply } from '../planner/planner.service.js'
import type { QuestionId } from '../planner/planner.questions.js'
import { applyPatch } from '../profile/profile.merge.js'
import { has, val } from '../profile/profile.model.js'
import { detectLanguage } from '../router/router.rules.js'
import { entryQuickReplies, profileItems, texts } from '../templates/templates.js'
import { collectNumbers, validateReply } from '../validator/validator.service.js'
import { agentSystem } from './agent.prompt.js'
import { factSheet, refOf, shortName } from './agent.facts.js'
import { applyFormAnswers, emptyOutput, profileFacts, runTool, terminalTools, toolDeclarations, type ToolContext, type ToolOutput } from './agent.tools.js'
import { missingKeyFacts, promisesForm, promisesListings, standardForm } from './agent.fallback.js'
import { clickedKey, mergeChips, nextSteps, offeredFrom } from './agent.next.js'
import { createTextFilter } from './agent.text.js'

// Every answer comes from Gemini: it answers from its own knowledge and calls tools for anything about real
// businesses, numbers or the site. Up to MAX_STEPS model calls per message; the last one may not call tools, so an
// answer always arrives. An answer that stops mid-way (the length limit, a stream gone quiet) is carried on in up to
// MAX_CONTINUATIONS more calls, and if it still is not finished it is saved as unfinished, so the client can continue
// it. When no model can answer, the client is told to try again: there is no answer without AI.

const MAX_STEPS = 3
const MAX_CONTINUATIONS = 2
const HISTORY = 8
// Time to START model calls in one turn, tool calls included. Past this the client has waited long enough.
const TURN_BUDGET_MS = 55_000
// Slow failed requests one message may afford across all its steps and fallbacks (see CallMeta.attempts).
const MAX_ATTEMPTS = 4

const showResultsText = { ka: 'მაჩვენე ვარიანტები', en: 'Show me options', ru: 'Покажи варианты' }

type Params = { session: Session; input: SendMessage; emit: Emit; signal: AbortSignal }
type StepResult = { parts: Part[]; calls: { name?: string; args?: Record<string, unknown> }[]; cut?: 'length' | 'stalled' }

export async function agentTurn(params: Params): Promise<void> {
  if (params.input.action === 'continue') return continueAnswer(params)
  const { session, input, emit, signal } = params
  let s = await catalog.get()
  const turn = session.turnCount + 1
  const state = structuredClone(session.state)
  let profile = session.profile
  let locale: Locale = input.locale ?? session.locale
  if (input.context?.saved) state.saved = input.context.saved.filter((id) => /^[0-9a-f-]{8,36}$/i.test(id)).slice(0, 20)

  if (input.context?.listingId) {
    const l = catalog.resolve(s, input.context.listingId)
    if (l) state.contextListingId = l.id
  }
  // A pasted mybusiness.ge listing link becomes the listing in focus, read from the site now.
  // Short (8-character) and full ids both work: mybusiness.ge/ka/listing/9d281948
  const pasted = input.text?.match(/mybusiness\.ge\/\S*?listing\/([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)/i)?.[1]
  if (pasted) {
    const found = await catalog.fetch(s, pasted).catch(() => 'unavailable' as const)
    if (found && found !== 'unavailable') {
      s = found.snapshot
      state.contextListingId = found.listing.id
    }
  }

  // 1. The message as text. Form answers and tapped options fill the profile without a model call.
  let userText: string
  if (input.form) {
    profile = applyFormAnswers(profile, input.form.answers, s.cities, s.categories, turn)
    userText = [input.form.answers.map((a) => a.label).join(', '), input.form.note].filter(Boolean).join('. ')
  } else if (input.quickReply) {
    const patch = optionPatch(input.quickReply.questionId as QuestionId, input.quickReply.optionId, profile)
    if (patch) profile = applyPatch(profile, patch, turn).profile
    userText = input.quickReply.label
  } else if (input.action === 'show_results') {
    userText = pick(showResultsText, locale)
  } else {
    userText = input.text!
    if (/\p{L}{3,}/u.test(userText.replace(/https?:\/\/\S+/g, ''))) locale = detectLanguage(userText, locale)
  }
  // The UI follows the language of the conversation: a Russian question gets Russian buttons and labels too.
  await emit('meta', { intent: 'chat', locale })

  // 2. Clear off-topic (code) or jailbreak attempts never reach a model.
  if (screenMessage(userText)) {
    await emit('meta', { intent: 'off_topic', locale })
    const text = offTopicReply(profile, locale)
    await emit('token', { text: text.reply })
    await emit('quick_replies', { items: text.quickReplies })
    await chatRepository.addMessage(session.id, { role: 'user', content: userText, intent: 'off_topic' })
    const messageId = await chatRepository.addMessage(session.id, { role: 'assistant', content: text.reply, intent: 'off_topic', payload: { quickReplies: text.quickReplies } })
    await chatRepository.saveSession({ ...session, title: session.title ?? titleFrom(userText), locale, profile, state, turnCount: turn })
    await emit('done', { messageId })
    return
  }

  // 3. The client's message is saved now: it stays in the chat if the answer fails or the page is reloaded.
  const loaded = await chatRepository.recentMessages(session.id, HISTORY + 2)
  // A retry replaces the unanswered copy of the message, so it is not in the conversation twice.
  const lastFailed = loaded.at(-1)
  if (lastFailed?.role === 'user' && lastFailed.payload.failed) await chatRepository.deleteMessage(session.id, lastFailed.id)
  const history = loaded.filter((m) => !m.payload.failed)
  const userMessageId = await chatRepository.addMessage(session.id, { role: 'user', content: userText, intent: 'chat' })
  const title = session.title ?? titleFrom(userText)
  // The chat is in the history from its first message on, even before (or without) an answer.
  if (!session.title) await chatRepository.saveSession({ ...session, title, locale }).catch((err) => logger.warn('could not title the chat', errorFields(err)))

  // The conversation so far, as text (tool calls from earlier turns are not replayed; the fact sheets carry them).
  const contents: Content[] = [...toContents(history), { role: 'user', parts: [{ text: userText }] }]

  await emit('status', { step: 'understanding' })
  // The listings this chat is about, read in full, so their fact sheets have the rent, turnover and address.
  s = await catalog.withDetails(s, [...state.lastShown, ...(state.contextListingId ? [state.contextListingId] : [])])

  const out: ToolOutput = emptyOutput()
  const ctx: ToolContext = {
    s,
    sessionId: session.id,
    userId: session.userId,
    turn,
    locale,
    profile,
    state,
    out,
    progress: (step, count) => emit('status', count === undefined ? { step } : { step, count }),
    userText,
    // Other chats are only counted for the model here; their content is read when it asks (recall_previous_chats).
    earlier: session.userId ? await chatRepository.earlierForUser(session.userId, session.id).catch((err) => (logger.warn('earlier chats unavailable', errorFields(err)), [])) : [],
  }
  const toolResults: unknown[] = []
  const calledTools: string[] = []
  // A model the client picked is used alone; one already used up for today is reported before trying.
  const only = input.model && input.model !== 'auto' && modelChains.responder.includes(input.model) ? input.model : undefined
  if (only && quota.status(only).status === 'limit') return unavailable(session, { title, profile, state, locale, only, userMessageId })
  const justClicked = clickedKey(state.nextShown, userText)
  const endsAt = Date.now() + TURN_BUDGET_MS
  const stop = new AbortController()
  const stepSignal = AbortSignal.any([signal, stop.signal])
  let reply = ''
  let model: string | undefined
  let continuing = false // the previous step stopped mid-answer: this one carries on the same sentence
  let continuations = 0
  let mainSteps = 0
  let incomplete = false
  // Auto: Flash-Lite first for quick questions, the Flash models first for comparisons, risk, location and profit.
  const chain = only ? undefined : chainFor(userText)
  const attempts = { left: MAX_ATTEMPTS }
  const started = Date.now()

  // Cards and the table go out as soon as a tool has them, so the client sees the listings while the text is written.
  let sentCards: unknown = null
  let sentCompare: unknown = null
  const sendResults = async () => {
    if (out.cards.length && out.cards !== sentCards) {
      sentCards = out.cards
      await emit('listings', { cards: out.cards })
    }
    if (out.compare && out.compare !== sentCompare) {
      sentCompare = out.compare
      await emit('compare', out.compare)
    }
  }

  try {
    for (;;) {
      const left = endsAt - Date.now()
      if (left < 3_000) {
        if (!reply) throw new Error('agent turn out of time before any text')
        logger.warn('agent turn out of time; answering with what is written', { session: session.id })
        incomplete = true
        break
      }
      const isContinuation = continuing
      if (!isContinuation) mainSteps++
      const last = mainSteps >= MAX_STEPS
      // The last step must answer in text: with nothing written yet it gets no tools at all, otherwise only chips.
      const chipsOnly = reply.trim() && !out.quickReplies.length ? toolDeclarations.filter((t) => t.name === 'suggest_replies') : []
      const tools = isContinuation || last ? chipsOnly : toolDeclarations
      const system = agentSystem(locale, agentContext(ctx))
      const filter = createTextFilter()
      let stepText = ''
      let result: StepResult | undefined
      for await (const ev of ai.agentStep({ system, contents, tools, signal: stepSignal, sessionId: session.id, maxWaitMs: 2_000, prefer: model, only, chain, attempts, budgetMs: left })) {
        if (ev.type === 'done') {
          result = ev
          model = ev.model
          continue
        }
        // A model sometimes writes its options as a hidden JSON/HTML block instead of calling suggest_replies:
        // that part is held back here and turned into chips below.
        const visible = filter.push(ev.text)
        if (!visible) continue
        if (!reply && !stepText) await emit('status', { step: 'writing' })
        // Never let the model stream code, whatever it was asked: stop before the chunk goes out.
        if (looksLikeCode(reply + stepText + visible)) {
          logger.warn('agent produced code; stopped', { session: session.id })
          const note = `${reply ? '\n\n' : ''}${pick(texts.offTopic, locale)}`
          reply += note
          await emit('token', { text: note })
          stop.abort()
          break
        }
        const text = reply && !stepText && !isContinuation ? `\n\n${visible}` : visible
        stepText += visible
        reply += text
        await emit('token', { text })
      }
      // Text held back at the very end (a "<" that was not a hidden block after all) goes out now.
      const { rest, options } = filter.end()
      if (rest && !stop.signal.aborted) {
        reply += rest
        await emit('token', { text: rest })
      }
      if (options.length && out.quickReplies.length === 0) out.quickReplies = options.slice(0, 3).map((o, i) => ({ kind: 'message', id: `ai:${i}`, label: o, text: o }))
      if (signal.aborted || stop.signal.aborted || !result) break
      continuing = false
      // The answer stopped mid-way: carry it on in the next call, or keep it as unfinished.
      if (result.cut && result.calls.length === 0) {
        if (continuations < MAX_CONTINUATIONS && endsAt - Date.now() > 8_000) {
          logger.info('answer stopped mid-way; continuing', { session: session.id, cut: result.cut })
          // A stream that went quiet may end in a half-sent part: only its text is replayed.
          const parts = result.cut === 'length' ? result.parts : result.parts.filter((p) => p.text && !p.thought)
          contents.push({ role: 'model', parts: parts.length ? parts : [{ text: stepText }] }, { role: 'user', parts: [{ text: CONTINUE }] })
          continuations++
          continuing = true
          continue
        }
        incomplete = true
        break
      }
      if (result.calls.length === 0) {
        // A reply that ends by announcing a search or check ("let's see what is available…") without doing it
        // leaves the client waiting for nothing: have the model do it now and continue the same answer.
        if (!last && announcesAction(stepText)) {
          logger.info('agent announced an action without doing it; continuing', { session: session.id })
          contents.push({ role: 'model', parts: result.parts }, { role: 'user', parts: [{ text: DO_IT_NOW }] })
          continue
        }
        break
      }

      // 4. Run what the model asked for; the results become its next input.
      const responses: Part[] = []
      for (const call of result.calls) {
        const name = call.name ?? ''
        calledTools.push(name)
        const value = await runTool(name, call.args ?? {}, ctx)
        toolResults.push(value)
        responses.push({ functionResponse: { name, response: { result: value } } })
      }
      profile = ctx.profile
      await sendResults()
      if (signal.aborted) break
      // Chips or a form complete the turn only when the reply already has text and the UI really gets them. A model
      // often calls them first and writes after it sees the result; and a refused show_form must not end the turn
      // with "fill in the form below" and no form: the model sees the error and asks in text.
      const delivered = Boolean(out.formRequested) || out.quickReplies.length > 0
      if (reply.trim() && delivered && result.calls.every((c) => terminalTools.has(c.name ?? ''))) break
      if (last) break
      contents.push({ role: 'model', parts: result.parts }, { role: 'user', parts: responses })
    }
  } catch (err) {
    if (signal.aborted) return saveInterrupted(session, { title, profile: ctx.profile, state, locale, turn, userMessageId, reply, out, model })
    if (stop.signal.aborted) {
      // stopped on purpose (code in the output): the note is already out
    } else if (!reply) {
      // Nothing written (no model, or the budget ran out). Form answers already gathered are kept.
      logger.warn('agent produced nothing', { session: session.id, ...errorFields(err) })
      return unavailable(session, { title, profile: ctx.profile, state, locale, only, userMessageId })
    } else {
      // Something was written: it is kept as an unfinished answer the client can continue.
      logger.warn('agent failed mid-reply', { session: session.id, ...errorFields(err) })
      incomplete = true
    }
  }
  // The client left (closed the tab, pressed Stop): keep what was written so they can continue it later.
  if (signal.aborted) return saveInterrupted(session, { title, profile: ctx.profile, state, locale, turn, userMessageId, reply, out, model })

  // What the reply promised is on screen, whatever the model did: a form it announced but never asked for is shown
  // while two or more key facts are still unknown; listings it announced without searching are searched.
  if (!stop.signal.aborted && reply.trim()) {
    const named = has(ctx.profile, 'sectors') ? [] : categoriesNamed(userText)
    if (named.length && (out.formRequested || promisesForm(reply))) ctx.profile = applyPatch(ctx.profile, { sectors: named }, ctx.turn).profile
    const listingWork = calledTools.some((t) => ['search_listings', 'get_listing', 'analyze_listing', 'location_analysis', 'compare_listings', 'profit_scenarios', 'calculate', 'market_stats', 'recall_previous_chats'].includes(t))
    if (!out.formRequested && !listingWork && missingKeyFacts(ctx.profile).length >= 2 && promisesForm(reply)) {
      out.formRequested = true
      logger.info('form promised but not asked for; the app shows it', { session: session.id })
    } else if (!out.formRequested && !out.cards.length && !calledTools.includes('search_listings') && promisesListings(reply) && announcesAction(reply)) {
      logger.info('listings promised but not searched; the app searched', { session: session.id })
      calledTools.push('search_listings')
      toolResults.push(await runTool('search_listings', {}, ctx).catch(() => null))
    }
  }
  profile = ctx.profile
  // The form is the standard one, built last, so it pre-selects everything the client said in this turn too.
  if (out.formRequested) out.form = standardForm(profile, locale)

  // A turn with a form or listings but no words still says something, so the conversation history has no gap
  // (an empty answer makes the model think the previous question is still open).
  if (!reply.trim()) {
    const line = out.form ? pick(texts.formIntro, locale) : out.cards.length ? pick(texts.resultsIntro, locale) : ''
    if (!line) {
      logger.warn('agent wrote nothing', { session: session.id })
      return unavailable(session, { title, profile, state, locale, only, userMessageId })
    }
    reply = line
    await emit('token', { text: line })
  }

  // 5. What the tools produced goes out after the text (cards and tables already went out as they came).
  const { needsDisclaimer } = validateReply(reply, collectNumbers(toolResults))
  if (needsDisclaimer) {
    const note = `\n\n${pick(texts.disclaimer, locale)}`
    reply += note
    await emit('token', { text: note })
  }
  await sendResults()
  if (out.sources.length) await emit('sources', { items: out.sources })
  if (out.form) await emit('form', out.form)
  if (out.handoff) await emit('handoff', out.handoff)
  if (out.checklist) await emit('checklist', out.checklist)
  if (out.alert) await emit('alert', out.alert)
  // The app's next steps go after the model's answers; what was offered is remembered for the next turn.
  out.quickReplies = mergeChips(out.quickReplies, nextSteps(ctx, calledTools, justClicked, out.quickReplies))
  state.nextShown = offeredFrom(out.quickReplies)
  await emit('quick_replies', { items: out.quickReplies })
  await emit('profile', { items: profileItems(profile, locale) })

  state.lastIntent = 'chat'
  state.profileEdited = []
  const asked = closingQuestion(reply)
  if (asked) state.askedRecently = [...state.askedRecently, asked].slice(-2)
  const messageId = await saveAnswer(session, { title, profile, state, locale, turn, reply, out, model, incomplete })
  logger.info('turn', { session: session.id, model, steps: mainSteps, continuations, ms: Date.now() - started, tools: calledTools, incomplete })
  await emit('done', { messageId, model: modelName(model), incomplete: incomplete || undefined })
}

// "Continue": the last answer stopped before its end (the client pressed Stop, the connection broke, or the length
// limit was reached twice). The model carries on from the last word; the text is added to the same message.
async function continueAnswer(params: Params): Promise<void> {
  const { session, input, emit, signal } = params
  const loaded = await chatRepository.recentMessages(session.id, HISTORY + 2)
  const target = loaded.at(-1)
  if (!target || target.role !== 'assistant' || !target.payload.incomplete) {
    // Nothing unfinished: the client's last message never got an answer, so it is answered now.
    if (target?.role === 'user') {
      await chatRepository.deleteMessage(session.id, target.id)
      return agentTurn({ ...params, input: { text: target.content, locale: input.locale } })
    }
    throw new AppError('bad_request', 'Nothing to continue')
  }
  const locale: Locale = input.locale ?? session.locale
  const state = structuredClone(session.state)
  await emit('meta', { intent: 'continue', locale, messageId: target.id })
  const ctx: ToolContext = { s: await catalog.get(), sessionId: session.id, userId: session.userId, turn: session.turnCount, locale, profile: session.profile, state, out: emptyOutput(), progress: async () => {}, userText: '' }
  const contents: Content[] = [...toContents(loaded.filter((m) => !m.payload.failed), target.id), { role: 'user', parts: [{ text: CONTINUE_LATER }] }]
  const only = input.model && input.model !== 'auto' && modelChains.responder.includes(input.model) ? input.model : undefined
  const attempts = { left: MAX_ATTEMPTS }
  let added = ''
  let model: string | undefined
  let incomplete = false
  try {
    for (let step = 0; step <= MAX_CONTINUATIONS; step++) {
      let result: StepResult | undefined
      let stepText = ''
      const tools = ctx.out.quickReplies.length ? [] : toolDeclarations.filter((t) => t.name === 'suggest_replies')
      for await (const ev of ai.agentStep({ system: agentSystem(locale, agentContext(ctx)), contents, tools, signal, sessionId: session.id, maxWaitMs: 2_000, prefer: model, only, chain: chainFor(target.content), attempts, budgetMs: TURN_BUDGET_MS })) {
        if (ev.type === 'done') {
          result = ev
          model = ev.model
          continue
        }
        if (!added && !stepText) await emit('status', { step: 'writing' })
        stepText += ev.text
        added += ev.text
        await emit('token', { text: ev.text })
      }
      if (!result || signal.aborted) break
      for (const call of result.calls) await runTool(call.name ?? '', call.args ?? {}, ctx)
      incomplete = Boolean(result.cut)
      if (!result.cut) break
      const parts = result.cut === 'length' ? result.parts : result.parts.filter((p) => p.text && !p.thought)
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: stepText }] }, { role: 'user', parts: [{ text: CONTINUE }] })
    }
  } catch (err) {
    if (!added && !signal.aborted) {
      logger.warn('continuation produced nothing', { session: session.id, ...errorFields(err) })
      throw new AppError('ai_unavailable', 'The AI could not answer right now. Please try again.', 30)
    }
    incomplete = true
  }
  if (signal.aborted) incomplete = true
  const payload = { ...target.payload, incomplete: incomplete || undefined, quickReplies: ctx.out.quickReplies.length ? ctx.out.quickReplies : target.payload.quickReplies, model: modelName(model) ?? target.payload.model }
  await chatRepository.updateMessage(session.id, target.id, { content: target.content + added, payload })
  if (signal.aborted) return
  if (ctx.out.quickReplies.length) await emit('quick_replies', { items: payload.quickReplies })
  await emit('done', { messageId: target.id, model: modelName(model), incomplete: incomplete || undefined, continued: true })
}

const CONTINUE = '(Instruction from the app, not from the client.) Your answer was cut off. Continue exactly where it stopped, mid-sentence if needed, without repeating anything.'
const CONTINUE_LATER = '(Instruction from the app, not from the client.) Your last answer above stopped before its end. Continue it exactly where it stopped, mid-sentence if needed, without repeating anything or starting over.'

const DO_IT_NOW =
  '(Instruction from the app, not from the client.) Your reply ended by announcing something you did not do (a search, a check, or a form to fill in). Do it now: call the tool (show_form for a form; search_listings, location_analysis, compare_listings… for the rest), then continue the answer with the result. Do not repeat what you already wrote.'

// "Let's see / I'll check / fill in the form below…" at the end of a reply, in Georgian, English or Russian.
const ANNOUNCES =
  /(მოდით|ახლა|მაშ)[,\s]+(ვნახოთ|გავარკვიოთ|მოვძებნოთ|შევამოწმოთ|გადავხედოთ|შევარჩიოთ)|(ვნახავ|მოვძებნი|შევამოწმებ|გადავხედავ|შეგირჩევთ)|ფორმა|კითხვ(ებ)?ს\s+დაგისვამ|\b(let me|let's|let us|i'll|i will|now i'll)\s+(look|check|search|find|see|pull|browse|ask)|\bform\b|(давайте|сейчас)\s+(посмотрим|проверим|найд[её]м|подберём|подберем)|(посмотрю|проверю|найду|подберу)|форм[ау]/i

export function announcesAction(text: string): boolean {
  const tail = text.trim().slice(-220)
  return tail.length > 0 && !tail.endsWith('?') && ANNOUNCES.test(tail)
}

// The last question of a reply, remembered so the next answers do not ask it again.
export function closingQuestion(reply: string): string | null {
  const last = reply.trim().split(/\n+/).at(-1) ?? ''
  if (!last.endsWith('?')) return null
  const sentence = last.split(/(?<=[.!])\s+/).at(-1) ?? last
  return sentence.replace(/[*_#>]/g, '').trim().slice(0, 200) || null
}

// The stored conversation as model input. Earlier answers are cut to keep the prompt small; the one being continued
// is given whole, so the model sees exactly where it stopped.
function toContents(history: StoredMessage[], whole?: number): Content[] {
  return history
    .filter((m) => m.content)
    .slice(-HISTORY)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.id === whole ? m.content.slice(-8_000) : m.content.slice(0, 2500) }] }))
}

const modelName = (model: string | undefined) => (model ? (MODEL_INFO[model]?.name ?? model) : undefined)

type Saved = { title: string; profile: Session['profile']; state: Session['state']; locale: Locale; turn: number; reply: string; out: ToolOutput; model?: string; incomplete: boolean }

async function saveAnswer(session: Session, a: Saved): Promise<number> {
  const messageId = await chatRepository.addMessage(session.id, {
    role: 'assistant',
    content: a.reply,
    intent: 'chat',
    payload: {
      cards: a.out.cards,
      compare: a.out.compare,
      sources: a.out.sources,
      quickReplies: a.out.quickReplies,
      form: a.out.form ?? undefined,
      handoff: a.out.handoff ?? undefined,
      checklist: a.out.checklist ?? undefined,
      alert: a.out.alert ?? undefined,
      model: modelName(a.model),
      incomplete: a.incomplete || undefined,
    },
  })
  a.state.cardsShown = [...new Set([...a.state.cardsShown, ...a.out.cards.map((c) => c.id)])].slice(-60)
  await chatRepository.saveSession({ ...session, title: a.title, locale: a.locale, profile: a.profile, state: a.state, turnCount: a.turn })
  return messageId
}

// The client left mid-answer. What was written is kept as an unfinished answer they can continue; with nothing
// written, their message stays as unanswered, with a retry.
async function saveInterrupted(session: Session, a: Omit<Saved, 'incomplete'> & { userMessageId: number }): Promise<void> {
  logger.info('client left mid-reply', { session: session.id, written: a.reply.length })
  try {
    if (a.reply.trim()) await saveAnswer(session, { ...a, incomplete: true })
    else {
      await chatRepository.updateMessage(session.id, a.userMessageId, { payload: { failed: true } })
      await chatRepository.saveSession({ ...session, title: a.title, locale: a.locale, profile: a.profile, state: a.state })
    }
  } catch (err) {
    logger.warn('could not keep the interrupted answer', errorFields(err))
  }
}

function modelUnavailable(model: string): AppError {
  const { status } = quota.status(model)
  const reason = status === 'limit' ? 'limit' : 'busy'
  const name = MODEL_INFO[model]?.name ?? model
  return new AppError('model_unavailable', `${name} is ${reason === 'limit' ? 'used up for today' : 'busy right now'}. Pick another model.`, undefined, { model, reason, resetsAt: quota.usage([model]).resetsAt })
}

// The chat's name in the history: the first thing the user wrote, shortened.
function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57).trimEnd()}…` : t
}

// No answer this time: keep what the client told us, mark their message as unanswered and let the UI offer a retry.
async function unavailable(
  session: Session,
  a: { title: string; profile: Session['profile']; state: Session['state']; locale: Locale; only: string | undefined; userMessageId: number },
): Promise<never> {
  await chatRepository.saveSession({ ...session, title: a.title, locale: a.locale, profile: a.profile, state: a.state })
  await chatRepository.updateMessage(session.id, a.userMessageId, { payload: { failed: true } }).catch((err) => logger.warn('could not mark the message unanswered', errorFields(err)))
  logger.error('turn failed: no model answered', { session: session.id, only: a.only })
  if (a.only) throw modelUnavailable(a.only)
  const { used, total } = quota.usage(chatModels())
  if (total && used >= total) throw new AppError('daily_limit', 'Today’s free AI allowance is used up. It renews when Google resets the daily limits.')
  throw new AppError('ai_unavailable', 'The AI could not answer right now. Please try again.', 30)
}

// What the model knows about this session besides the conversation: the listings with their fact sheets, the profile,
// what it asked recently and what the client changed in the memory strip.
function agentContext(ctx: ToolContext) {
  const { state, s, locale } = ctx
  const onScreen = state.lastShown.map((id) => s.byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  const focus = state.contextListingId ? s.byId.get(state.contextListingId) : undefined
  // Fact sheets for what is on screen and in focus, and the few listings discussed just before.
  const recent = state.refs.slice(-6).map((id) => s.byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  const sheets = [...new Map([...onScreen, ...(focus ? [focus] : []), ...recent].map((l) => [l.id, l])).values()].slice(0, 8)
  const saved = state.saved.map((id) => s.byId.get(id)).filter((l): l is NonNullable<typeof l> => Boolean(l))
  return {
    today: new Date().toISOString().slice(0, 10),
    profile: profileFacts(ctx.profile),
    changed_by_client: state.profileEdited.length ? state.profileEdited : undefined,
    listings_on_screen: onScreen.map((l) => `#${refOf(state, l.id)} ${shortName(l, locale)}`),
    listing_in_focus: focus ? `#${refOf(state, focus.id)} ${shortName(focus, locale)}` : null,
    fact_sheets: sheets.map((l) => factSheet(l, s, state, locale)),
    saved_listings: saved.length ? saved.map((l) => ({ id: l.shortId, name: shortName(l, locale), price_gel: l.priceGel && Math.round(l.priceGel) })) : undefined,
    recent_questions: state.askedRecently,
    earlier_chats: ctx.earlier?.length ?? 0,
    site: { active_listings: s.listings.length, usd_to_gel: s.rates.USD },
  }
}

// One polite line that leads back to the search in progress.
function offTopicReply(profile: Session['profile'], locale: Locale): { reply: string; quickReplies: QuickReply[] } {
  const sectors = (val(profile, 'sectors') ?? []).map((c) => categoryLabel(c, locale))
  const budget = val(profile, 'budgetGel')
  if (sectors.length || budget) {
    const resume = [sectors.slice(0, 2).join(' / '), budget ? `≤ ${formatGel(budget, locale)}` : null].filter(Boolean).join(', ')
    return { reply: pick(texts.offTopicResume, locale).replace('{resume}', resume), quickReplies: [showResultsReply(locale)] }
  }
  return { reply: pick(texts.offTopic, locale), quickReplies: entryQuickReplies(locale) }
}
