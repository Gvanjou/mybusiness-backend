import { z } from 'zod'

export const localeSchema = z.enum(['ka', 'en', 'ru'])
export type Locale = z.infer<typeof localeSchema>

export type Localized = Record<Locale, string>

export function pick(text: Localized, locale: Locale): string {
  return text[locale] || text.en
}

const gelFormat: Record<Locale, Intl.NumberFormat> = {
  ka: new Intl.NumberFormat('ka-GE', { maximumFractionDigits: 0 }),
  en: new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }),
  ru: new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }),
}

export function formatGel(amount: number, locale: Locale): string {
  return `${gelFormat[locale].format(Math.round(amount))} ₾`
}
