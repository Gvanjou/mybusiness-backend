import { logger } from '../../../shared/logger/logger.js'

const guaranteePatterns = [
  /guarantee[ds]?|risk[- ]free|you will (earn|make)|sure profit|can't lose/i,
  /გარანტირ|უსაფრთხო ინვესტიცია|აუცილებლად მოგებ|რისკის გარეშე/i,
  /гарантир|без риска|точно заработа|беспроигрыш/i,
]

// Post-checks on a finished reply. Problems are fixed by appending a correction,
// because the text has already been streamed to the user.
export function validateReply(text: string, knownNumbers: number[]): { needsDisclaimer: boolean } {
  const needsDisclaimer = guaranteePatterns.some((p) => p.test(text))

  // Log (not block) amounts that do not match any number we gave the model, to review prompts later.
  const amounts = [...text.matchAll(/(\d{1,3}(?:[ ,.]\d{3})+|\d{4,})\s*(?:₾|GEL|ლარ|лар|\$|USD)/gi)].map((m) => Number(m[1]!.replace(/[ ,.]/g, '')))
  const unknown = amounts.filter((a) => !knownNumbers.some((k) => Math.abs(k - a) <= Math.max(50, k * 0.03)))
  if (unknown.length) logger.warn('reply contains numbers not present in context', { count: unknown.length })

  return { needsDisclaimer }
}

// Collects every number in the context so the validator can compare against it.
export function collectNumbers(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number' && Number.isFinite(value)) out.push(value)
  else if (Array.isArray(value)) for (const v of value) collectNumbers(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectNumbers(v, out)
  else if (typeof value === 'string') for (const m of value.matchAll(/\d{4,}/g)) out.push(Number(m[0]))
  return out
}
