import { z } from 'zod'

// The intake form the assistant can show instead of asking one question per turn. Each question fills one
// known profile fact, so the answers are applied in code, without another model call.
export const intakeFields = ['budget', 'capital_source', 'involvement', 'goal', 'risk', 'location', 'sector', 'experience'] as const

export const intakeFormSchema = z.object({
  title: z.string().max(200).optional(),
  questions: z
    .array(
      z.object({
        field: z.enum(intakeFields),
        question: z.string().max(200),
        options: z.array(z.object({ value: z.string().max(60), label: z.string().max(80) })).min(2).max(9),
        selected: z.string().max(60).optional(), // what the client already said: pre-selected, not asked again
      }),
    )
    .min(1)
    .max(7),
  noteLabel: z.string().max(120).optional(),
  submitLabel: z.string().max(40),
})
export type IntakeForm = z.infer<typeof intakeFormSchema>

// What the user sends back.
export const formAnswersSchema = z.object({
  answers: z.array(z.object({ field: z.enum(intakeFields), value: z.string().max(60), label: z.string().max(80) })).min(1).max(8),
  note: z.string().trim().max(300).optional(),
})
