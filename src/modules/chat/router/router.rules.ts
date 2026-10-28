import type { Locale } from '../../../shared/i18n/locale.js'

export function detectLanguage(raw: string, fallback: Locale): Locale {
  // Links and listing ids are not language: a pasted URL alone keeps the current language.
  const text = raw.replace(/https?:\/\/\S+/g, ' ').replace(/\b[0-9a-f]{8}\b/gi, ' ')
  if (/[Ⴀ-ჿ]/.test(text)) return 'ka'
  if (/[Ѐ-ӿ]/.test(text)) return 'ru'
  if (/[a-z]{2,}/i.test(text)) return 'en'
  return fallback
}
