import { z } from 'zod'
import { localeSchema } from '../../shared/i18n/locale.js'
import { formAnswersSchema } from './agent/agent.model.js'

export const createSessionSchema = z.object({ locale: localeSchema.default('ka') })

export const sendMessageSchema = z
  .object({
    text: z.string().trim().min(1).max(1000).optional(),
    quickReply: z
      .object({
        questionId: z.string().max(40),
        optionId: z.string().max(80),
        label: z.string().max(120),
      })
      .optional(),
    // show_results: the "show me options" chip · continue: carry on the last answer, which stopped before its end
    action: z.enum(['show_results', 'continue']).optional(),
    form: formAnswersSchema.optional(), // answers to the intake form the assistant showed
    context: z
      .object({
        listingId: z.string().max(200).optional(),
        saved: z.array(z.string().max(40)).max(20).optional(), // listings the client saved in this browser (ids)
      })
      .optional(),
    locale: localeSchema.optional(),
    model: z.string().max(60).optional(), // a model the client picked; absent or 'auto' = the best available
  })
  .refine((b) => Boolean(b.text || b.quickReply || b.action || b.form), 'text, quickReply, action or form is required')

export type SendMessage = z.infer<typeof sendMessageSchema>

// Sends one server-sent event to the client.
export type Emit = (event: string, data: unknown) => Promise<void>

export const feedbackSchema = z.object({
  messageId: z.number().int().positive(),
  rating: z.union([z.literal(1), z.literal(-1)]),
  comment: z.string().max(500).optional(),
})

// Per-session conversation state, persisted in chat_sessions.state.
export const sessionStateSchema = z.object({
  lastShown: z.array(z.string()).default([]), // the listings on screen now (the latest set), in order
  lastIntent: z.string().optional(),
  contextListingId: z.string().optional(),
  cardsShown: z.array(z.string()).default([]), // listings whose card is already in the conversation: not shown again
  // Every listing this chat has shown, in order of first appearance: listing #n is refs[n - 1], on its card and in
  // the text alike, for the whole chat.
  refs: z.array(z.string()).default([]),
  // What the map showed around a listing, kept so every later answer quotes the same competitors and counts.
  places: z
    .record(z.string(), z.object({ radiusM: z.number(), direct: z.number(), within150m: z.number(), nearest: z.array(z.string()), precision: z.string() }))
    .default({}),
  topics: z.record(z.string(), z.array(z.string())).default({}), // listing id → topics already answered (risks, location…)
  nextShown: z.array(z.object({ key: z.string(), text: z.string() })).default([]), // next-step chips offered last turn
  askedRecently: z.array(z.string()).default([]), // the closing questions of the last two answers (never asked again)
  profileEdited: z.array(z.string()).default([]), // facts the client changed in the memory strip since the last answer
  saved: z.array(z.string()).default([]), // listings the client saved (ids), as the browser last reported them
  chipTexts: z.array(z.string()).default([]), // what the chips offered last turn send: the app's own words skip the topic guard
})

export type SessionState = z.infer<typeof sessionStateSchema>
