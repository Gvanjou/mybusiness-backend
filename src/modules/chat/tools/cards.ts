import { env } from '../../../pkg/env/env.js'
import { pick, type Locale } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel, districtLabel } from '../../catalog/catalog.labels.js'
import { placeHints } from '../../competition/area.service.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { financialsLevel } from '../../catalog/catalog.service.js'
import { reasonLabel } from '../templates/templates.js'
import { assetClassOf, type ReasonCode, type Scored } from './search.tool.js'

// What the chat UI renders for a listing.
export type ListingCard = {
  id: string
  shortId: string
  url: string
  title: string
  category: string
  categoryLabel: string
  city: string
  priceGel: number | null
  price: number | null
  currency: string | null
  negotiable: boolean
  coverImage: string | null
  images: string[]
  priceUsd: number | null
  district: string | null
  area: number | null
  ownerType: string | null
  createdAt: string | null
  assetClass: string
  operatingModel: string
  financials: 'stated' | 'vague' | 'none'
  completeness: number
  summary: string
  reasons: { code: ReasonCode; label: string; tone: 'good' | 'warn' | 'info' }[]
  wildcard: boolean
}

const tone: Partial<Record<ReasonCode, 'good' | 'warn'>> = {
  FITS_BUDGET: 'good',
  FITS_HANDS_OFF: 'good',
  HAS_MANAGER_OR_TENANT: 'good',
  MATCHES_EXPERIENCE: 'good',
  IN_PREFERRED_CITY: 'good',
  MATCHES_SECTOR: 'good',
  MATCHES_INTEREST: 'good',
  FINANCIALS_STATED: 'good',
  BELOW_CATEGORY_MEDIAN: 'good',
  NEGOTIATION_NEEDED: 'warn',
  NEEDS_OWNER_DAILY: 'warn',
  NO_FINANCIALS: 'warn',
  RED_FLAGS: 'warn',
  ABOVE_CATEGORY_MEDIAN: 'warn',
  PRICE_ON_REQUEST: 'warn',
}

export function listingUrl(l: CatalogListing, locale: Locale): string {
  return new URL(`/${locale}/listing/${l.shortId}`, env.SOURCE_BASE_URL).toString()
}

export function toCard(l: CatalogListing, locale: Locale, scored?: Scored, usdRate?: number): ListingCard {
  const reasons = (scored?.reasons ?? []).filter((r) => r !== 'WILDCARD')
  return {
    id: l.id,
    shortId: l.shortId,
    url: listingUrl(l, locale),
    title: pick(l.title, locale),
    category: l.category,
    categoryLabel: categoryLabel(l.category, locale),
    city: cityLabel(l.city, locale),
    priceGel: l.priceGel === null ? null : Math.round(l.priceGel),
    price: l.price,
    currency: l.currency,
    negotiable: l.negotiable,
    coverImage: l.coverImage,
    images: l.images.length ? l.images : l.coverImage ? [l.coverImage] : [],
    priceUsd: l.priceGel !== null && usdRate ? Math.round(l.priceGel / usdRate) : null,
    // Many listings leave the district empty but name it in the title or text ("ვაკეში").
    district: districtLabel(l.district ?? placeHints(`${l.title.ka ?? ''} ${l.title.en ?? ''} ${l.description.original}`).neighbourhood, locale) || null,
    area: l.area,
    ownerType: l.ownerType,
    createdAt: l.createdAt,
    assetClass: assetClassOf(l),
    operatingModel: l.insights?.operatingModel ?? 'unknown',
    financials: financialsLevel(l),
    completeness: l.insights?.completeness ?? 0,
    summary: l.insights ? pick(l.insights.summary, locale) : '',
    reasons: reasons.slice(0, 4).map((code) => ({ code, label: reasonLabel(code, locale), tone: tone[code] ?? 'info' })),
    wildcard: scored?.reasons.includes('WILDCARD') ?? false,
  }
}
