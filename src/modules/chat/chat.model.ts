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
    action: z.enum(['show_results']).optional(),
    form: formAnswersSchema.optional(), // answers to the intake form the assistant showed
    context: z.object({ listingId: z.string().max(200).optional() }).optional(),
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
  asked: z.array(z.string()).default([]),
  discoveryTurns: z.number().int().default(0),
  lastShown: z.array(z.string()).default([]),
  shownCount: z.number().int().default(0),
  budgetRealityShown: z.boolean().default(false),
  lastIntent: z.string().optional(),
  contextListingId: z.string().optional(),
  cardsShown: z.array(z.string()).default([]), // listings whose card is already in the conversation: not shown again
  nextShown: z.array(z.object({ key: z.string(), text: z.string() })).default([]), // next-step chips offered last turn
  aspectsAsked: z.array(z.string()).default([]), // aspects already analysed for the listing in focus
  plannedUse: z.string().optional(), // what the user plans to open in the space in focus (a category key)
  reasked: z.array(z.string()).default([]), // goal / sector questions asked a second time (never a third)
  lastTopics: z.array(z.string()).default([]), // knowledge sections answered last turn (not repeated next time)
  pending: z.object({ questionId: z.string() }).optional(), // the discovery question asked last turn, awaiting an answer
  // A new budget far from the stated one, waiting for the user to confirm it.
  pendingBudget: z.object({ gel: z.number(), amount: z.number(), currency: z.string() }).optional(),
})

export type SessionState = z.infer<typeof sessionStateSchema>
