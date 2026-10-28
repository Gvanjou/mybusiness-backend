import { z } from 'zod'

export const localeSchema = z.enum(['ka', 'en', 'ru'])
export type Locale = z.infer<typeof localeSchema>

export type Localized = Record<Locale, string>

export function pick(text: Localized, locale: Locale): string {
  return text[locale] || text.en
}

const grouped = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

// Whole numbers as each language writes them: "60,000" in English, "60 000" in Georgian and Russian. Georgian
// number data leaves four-digit numbers ungrouped ("2600"), so the grouping is done here, the same for every size.
export function formatNumber(n: number, locale: Locale): string {
  const s = grouped.format(Math.round(n))
  return locale === 'en' ? s : s.replace(/,/g, '\u00a0')
}

export function formatGel(amount: number, locale: Locale): string {
  return `${formatNumber(amount, locale)} ₾`
}
