import type { Locale } from '../../../shared/i18n/locale.js'

export function detectLanguage(raw: string, fallback: Locale): Locale {
  // Links and listing ids are not language: a pasted URL alone keeps the current language.
  const text = raw.replace(/https?:\/\/\S+/g, ' ').replace(/\b[0-9a-f]{8}\b/gi, ' ')
  if (/[Ⴀ-ჿ]/.test(text)) return 'ka'
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'
  // Latin letters alone are not English: "rogor xdeba?" is Georgian on a Latin keyboard and stays in the conversation's
  // language. English needs an English word.
  if (ENGLISH_WORD.test(text)) return 'en'
  return fallback
}

const ENGLISH_WORD = /\b(the|is|are|was|what|how|where|which|who|why|want|need|buy|sell|price|business|shop|cafe|café|restaurant|a|an|in|for|to|and|of|my|me|can|do|does|show|find|much|many|with|about|this|that|have|would|like|please|hello|hi|thanks|yes|no|budget|rent|profit|compare|best|risk|city|tbilisi|batumi|kutaisi)\b/i
