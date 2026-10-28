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
import { chatRepository, type Session } from '../chat.repository.js'
import { looksLikeCode, screenMessage } from '../guard/guard.service.js'
import { optionPatch, showResultsReply, type QuickReply } from '../planner/planner.service.js'
import type { QuestionId } from '../planner/planner.questions.js'
import { applyPatch } from '../profile/profile.merge.js'
import { has, val } from '../profile/profile.model.js'
import { detectLanguage } from '../router/router.rules.js'
import { entryQuickReplies, profileItems, texts } from '../templates/templates.js'
import { collectNumbers, validateReply } from '../validator/validator.service.js'
import { agentSystem } from './agent.prompt.js'
import { applyFormAnswers, profileFacts, runTool, terminalTools, toolDeclarations, type ToolContext, type ToolOutput } from './agent.tools.js'
import { defaultIntakeForm, promisesForm, promisesListings } from './agent.fallback.js'
import { clickedKey, mergeChips, nextSteps, offeredFrom } from './agent.next.js'
import { createTextFilter } from './agent.text.js'

// Every answer comes from Gemini: it answers from its own knowledge and calls tools for anything about real
// businesses, numbers or the site. Up to MAX_STEPS model calls per message; the last one may not call tools,
// so an answer always arrives. When no model can answer, the user is told to try again: there is no answer
// without AI.

const MAX_STEPS = 3
const HISTORY = 8
// The whole turn, including tool calls. Past this the user has waited long enough.
const TURN_BUDGET_MS = 55_000
// Slow failed requests one message may afford across all its steps and fallbacks (see CallMeta.attempts).
const MAX_ATTEMPTS = 4

const showResultsText = { ka: 'მაჩვენე ვარიანტები', en: 'Show me options', ru: 'Покажи варианты' }

export async function agentTurn(params: { session: Session; input: SendMessage; emit: Emit; signal: AbortSignal }): Promise<void> {
  const { session, input, emit, signal } = params
  let s = await catalog.get()
  const turn = session.turnCount + 1
  const state = structuredClone(session.state)
  let profile = session.profile
  let locale: Locale = input.locale ?? session.locale

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

  // 2. Clear off-topic (code) or jailbreak attempts never reach a model.
  if (screenMessage(userText)) {
    await emit('meta', { intent: 'off_topic' })
    const text = offTopicReply(profile, locale)
    await emit('token', { text: text.reply })
    await emit('quick_replies', { items: text.quickReplies })
    await chatRepository.addMessage(session.id, { role: 'user', content: userText, intent: 'off_topic' })
    const messageId = await chatRepository.addMessage(session.id, { role: 'assistant', content: text.reply, intent: 'off_topic', payload: { quickReplies: text.quickReplies } })
    await chatRepository.saveSession({ ...session, title: session.title ?? titleFrom(userText), locale, profile, state, turnCount: turn })
    await emit('done', { messageId })
    return
  }

  // 3. The conversation so far, as text (tool calls from earlier turns are not replayed).
  const loaded = await chatRepository.recentMessages(session.id, HISTORY + 2)
  // A retry replaces the unanswered copy of the message, so it is not in the conversation twice.
  const lastFailed = loaded.at(-1)
  if (lastFailed?.role === 'user' && lastFailed.payload.failed) await chatRepository.deleteMessage(session.id, lastFailed.id)
  const history = loaded.filter((m) => !m.payload.failed)
  const contents: Content[] = [
    ...history
      .filter((m) => m.content)
      .slice(-HISTORY)
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content.slice(0, 2500) }] })),
    { role: 'user', parts: [{ text: userText }] },
  ]

  await emit('status', { step: 'understanding' })
  await emit('meta', { intent: 'chat' })

  const out: ToolOutput = { cards: [], compare: null, sources: [], quickReplies: [], form: null }
  const ctx: ToolContext = {
    s,
    sessionId: session.id,
    turn,
    locale,
    profile,
    state,
    out,
    progress: (step, count) => emit('status', count === undefined ? { step } : { step, count }),
    userText,
  }
  const toolResults: unknown[] = []
  const calledTools: string[] = []
  // A model the client picked is used alone; one already used up for today is reported before trying.
  const only = input.model && input.model !== 'auto' && modelChains.responder.includes(input.model) ? input.model : undefined
  if (only && quota.status(only).status === 'limit') {
    if (input.form) await chatRepository.saveSession({ ...session, locale, profile, state })
    await keepFailed(session.id, userText)
    throw modelUnavailable(only)
  }
  const justClicked = clickedKey(state.nextShown, userText)
  const endsAt = Date.now() + TURN_BUDGET_MS
  const stop = new AbortController()
  const stepSignal = AbortSignal.any([signal, stop.signal])
  let reply = ''
  let model: string | undefined
  let continuing = false // the previous step was cut at the output limit: this one carries on the same sentence
  // Auto: Flash-Lite first for quick questions, the Flash models first for comparisons, risk, location and profit.
  const chain = only ? undefined : chainFor(userText)
  const attempts = { left: MAX_ATTEMPTS }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const left = endsAt - Date.now()
      if (left < 3_000) {
        if (!reply) throw new Error('agent turn out of time before any text')
        logger.warn('agent turn out of time; answering with what is written', { session: session.id, step })
        break
      }
      // The last step must answer in text: with nothing written yet it gets no tools at all, otherwise only chips.
      const last = step === MAX_STEPS - 1
      const tools = !last ? toolDeclarations : reply.trim() || out.quickReplies.length ? [] : toolDeclarations.filter((t) => t.name === 'suggest_replies')
      const system = agentSystem(locale, agentContext(ctx))
      const filter = createTextFilter()
      let stepText = ''
      let result: { parts: Part[]; calls: { name?: string; args?: Record<string, unknown> }[]; cut?: boolean } | undefined
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
        const text = reply && !stepText && !continuing ? `\n\n${visible}` : visible
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
      if (options.length && out.quickReplies.length === 0) out.quickReplies = options.slice(0, 4).map((o, i) => ({ kind: 'message', id: `ai:${i}`, label: o, text: o }))
      if (stop.signal.aborted || !result) break
      // Google stopped at the output limit mid-answer: continue the same answer in the next step.
      continuing = false
      if (result.cut && result.calls.length === 0 && !last) {
        logger.info('answer cut at the output limit; continuing', { session: session.id, step })
        contents.push({ role: 'model', parts: result.parts }, { role: 'user', parts: [{ text: CONTINUE }] })
        continuing = true
        continue
      }
      if (result.calls.length === 0) {
        // A reply that ends by announcing a search or check ("let's see what is available…") without doing it
        // leaves the client waiting for nothing: have the model do it now and continue the same answer.
        if (!last && announcesAction(stepText)) {
          logger.info('agent announced an action without doing it; continuing', { session: session.id, step })
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
      // Chips or a form complete the turn only when the reply already has text and the UI really got them. A model
      // often calls them first and writes after it sees the result; and a failed show_form must not end the turn
      // with "fill in the form below" and no form: the model sees the error and tries again or asks in text.
      const delivered = Boolean(out.form) || out.quickReplies.length > 0
      if (reply.trim() && delivered && result.calls.every((c) => terminalTools.has(c.name ?? ''))) break
      contents.push({ role: 'model', parts: result.parts }, { role: 'user', parts: responses })
    }
  } catch (err) {
    if (signal.aborted) {
      logger.info('client disconnected mid-reply', { session: session.id })
      return
    }
    if (stop.signal.aborted) {
      // stopped on purpose (code in the output): the note is already out
    } else if (!reply) {
      // Nothing written (no model, or the budget ran out). Form answers already gathered are kept.
      logger.warn('agent produced nothing', { session: session.id, ...errorFields(err) })
      return unavailable(session, profile, state, locale, only, userText)
    } else {
      logger.warn('agent failed mid-reply', errorFields(err))
      const note = `${reply ? '\n\n' : ''}${pick(texts.cutOff, locale)}`
      reply += note
      await emit('token', { text: note })
    }
  }

  // What the reply promised is on screen, whatever the model did: a form it announced but never delivered (or got
  // wrong) is built here from what the profile still lacks; listings it announced without searching are searched.
  if (!signal.aborted && !stop.signal.aborted && reply.trim()) {
    // A form only early on (budget, goal or time still unknown) and never on a turn that worked on listings: a
    // location or comparison answer that mentions questions is not a questionnaire.
    const early = !has(ctx.profile, 'budgetGel') || !(has(ctx.profile, 'goal') || has(ctx.profile, 'involvement'))
    const listingWork = calledTools.some((t) => ['search_listings', 'get_listing', 'analyze_listing', 'location_analysis', 'compare_listings', 'calculate', 'market_stats'].includes(t))
    if (!out.form && early && !listingWork && promisesForm(reply)) {
      const named = has(ctx.profile, 'sectors') ? [] : categoriesNamed(userText)
      if (named.length) ctx.profile = applyPatch(ctx.profile, { sectors: named }, ctx.turn).profile
      out.form = defaultIntakeForm(ctx.profile, locale, ctx.s)
      if (out.form) logger.info('form promised but not delivered; the app built it', { session: session.id })
    } else if (!out.form && !out.cards.length && !calledTools.includes('search_listings') && promisesListings(reply) && announcesAction(reply)) {
      logger.info('listings promised but not searched; the app searched', { session: session.id })
      calledTools.push('search_listings')
      toolResults.push(await runTool('search_listings', {}, ctx).catch(() => null))
      profile = ctx.profile
    }
  }

  // A turn with a form or listings but no words still says something, so the conversation history has no gap
  // (an empty answer makes the model think the previous question is still open).
  if (!reply.trim() && !signal.aborted) {
    const line = out.form ? pick(texts.formIntro, locale) : out.cards.length ? pick(texts.resultsIntro, locale) : ''
    if (!line) {
      logger.warn('agent wrote nothing', { session: session.id })
      return unavailable(session, profile, state, locale, only, userText)
    }
    reply = line
    await emit('token', { text: line })
  }

  // 5. What the tools produced goes out after the text.
  const { needsDisclaimer } = validateReply(reply, collectNumbers(toolResults))
  if (needsDisclaimer) {
    const note = `\n\n${pick(texts.disclaimer, locale)}`
    reply += note
    await emit('token', { text: note })
  }
  if (out.cards.length) await emit('listings', { cards: out.cards })
  if (out.compare) await emit('compare', out.compare)
  if (out.sources.length) await emit('sources', { items: out.sources })
  if (out.form) await emit('form', out.form)
  // The app's next steps go after the model's answers; what was offered is remembered for the next turn.
  out.quickReplies = mergeChips(out.quickReplies, nextSteps(ctx, calledTools, justClicked))
  state.nextShown = offeredFrom(out.quickReplies)
  await emit('quick_replies', { items: out.quickReplies })
  await emit('profile', { items: profileItems(profile, locale) })

  await chatRepository.addMessage(session.id, { role: 'user', content: userText, intent: 'chat' })
  const messageId = await chatRepository.addMessage(session.id, {
    role: 'assistant',
    content: reply,
    intent: 'chat',
    payload: { cards: out.cards, compare: out.compare, sources: out.sources, quickReplies: out.quickReplies, form: out.form ?? undefined, model: model ? (MODEL_INFO[model]?.name ?? model) : undefined },
  })
  state.lastIntent = 'chat'
  state.cardsShown = [...new Set([...state.cardsShown, ...out.cards.map((c) => c.id)])].slice(-60)
  await chatRepository.saveSession({ ...session, title: session.title ?? titleFrom(userText), locale, profile, state, turnCount: turn })
  await emit('done', { messageId, model: model ? (MODEL_INFO[model]?.name ?? model) : undefined })
}

const CONTINUE = '(Instruction from the app, not from the client.) Your answer was cut off by the length limit. Continue exactly where it stopped, mid-sentence if needed, without repeating anything.'

const DO_IT_NOW =
  '(Instruction from the app, not from the client.) Your reply ended by announcing something you did not do (a search, a check, or a form to fill in). Do it now: call the tool (show_form for a form; search_listings, location_analysis, compare_listings… for the rest), then continue the answer with the result. Do not repeat what you already wrote.'

// "Let's see / I'll check / fill in the form below…" at the end of a reply, in Georgian, English or Russian.
const ANNOUNCES =
  /(მოდით|ახლა|მაშ)[,\s]+(ვნახოთ|გავარკვიოთ|მოვძებნოთ|შევამოწმოთ|გადავხედოთ|შევარჩიოთ)|(ვნახავ|მოვძებნი|შევამოწმებ|გადავხედავ|შეგირჩევთ)|ფორმა|კითხვ(ებ)?ს\s+დაგისვამ|\b(let me|let's|let us|i'll|i will|now i'll)\s+(look|check|search|find|see|pull|browse|ask)|\bform\b|(давайте|сейчас)\s+(посмотрим|проверим|найд[её]м|подберём|подберем)|(посмотрю|проверю|найду|подберу)|форм[ау]/i

export function announcesAction(text: string): boolean {
  const tail = text.trim().slice(-220)
  return tail.length > 0 && !tail.endsWith('?') && ANNOUNCES.test(tail)
}

// The message stays in the conversation, marked as unanswered, so the client sees what they wrote and can retry.
async function keepFailed(sessionId: string, userText: string): Promise<void> {
  await chatRepository.addMessage(sessionId, { role: 'user', content: userText, intent: 'failed', payload: { failed: true } }).catch((err) => logger.warn('could not keep the failed message', errorFields(err)))
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

// No answer this time: keep what the user told us and let the UI offer a retry — or, when the client picked a model,
// say which one and why, so the UI can offer to switch.
async function unavailable(session: Session, profile: Session['profile'], state: Session['state'], locale: Locale, only: string | undefined, userText: string): Promise<never> {
  await chatRepository.saveSession({ ...session, locale, profile, state })
  await keepFailed(session.id, userText)
  if (only) throw modelUnavailable(only)
  const { used, total } = quota.usage(chatModels())
  if (total && used >= total) throw new AppError('daily_limit', 'Today’s free AI allowance is used up. It renews when Google resets the daily limits.')
  throw new AppError('ai_unavailable', 'The AI could not answer right now. Please try again.', 30)
}

// What the model knows about this session besides the conversation.
function agentContext(ctx: ToolContext) {
  const shown = ctx.state.lastShown.map((id, i) => {
    const l = ctx.s.byId.get(id)
    return l ? { ref: `#${i + 1}`, id: l.shortId, title: pick(l.title, ctx.locale), price_gel: l.priceGel && Math.round(l.priceGel), category: categoryLabel(l.category, ctx.locale) } : null
  })
  const focus = ctx.state.contextListingId ? ctx.s.byId.get(ctx.state.contextListingId) : undefined
  return {
    today: new Date().toISOString().slice(0, 10),
    profile: profileFacts(ctx.profile),
    listings_on_screen: shown.filter(Boolean),
    listing_in_focus: focus ? { id: focus.shortId, title: pick(focus.title, ctx.locale), card_on_screen: ctx.state.cardsShown.includes(focus.id) } : null,
    site: { active_listings: ctx.s.listings.length, usd_to_gel: ctx.s.rates.USD },
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
