import type { Localized } from '../../shared/i18n/locale.js'

export type AssetClass = 'operating_business' | 'real_estate' | 'land' | 'commercial_space' | 'partnership' | 'other'
export type OperatingModel = 'passive' | 'semi_passive' | 'hands_on' | 'unknown'

// min/max are per month. stated keeps the figure as the seller wrote it when that was per day, week or year
// ("700–800 ₾ a day"), so the reply and the table can show both and never pass a daily figure off as monthly.
export type Money = { min: number; max: number; currency: string; evidence: string; stated?: { min: number; max: number; period: 'day' | 'week' | 'year' } } | null

export type CatalogListing = {
  id: string
  shortId: string
  title: Localized
  category: string
  dealType: string
  price: number | null
  currency: string | null
  priceGel: number | null
  negotiable: boolean
  city: string | null
  district: string | null
  area: number | null
  ownerType: string | null
  coverImage: string | null
  images: string[]
  createdAt: string | null
  address: string | null
  latitude: number | null
  longitude: number | null
  description: { original: string; en: string | null }
  insights: {
    source?: 'llm' | 'text' // text: read from the listing text by rules, while the AI notes are pending
    assetClass: AssetClass
    isOperating: boolean | null
    operatingModel: OperatingModel
    skills: string[]
    financials: { revenue_monthly: Money; profit_monthly: Money; rent_income_monthly: Money; other_figures: string[] }
    premises: { tenure: string; rent_monthly: Money; lease_terms: string | null; area_m2: number | null }
    staff: { count: number | null; stays: boolean | null }
    includedAssets: string[]
    locationHint: string | null
    seasonality: string | null
    reasonForSale: string | null
    yearsOperating: number | null
    strengths: string[]
    // What the seller states in the text, structured for display (text source only).
    highlights?: { ratings: { platform: string; value: string }[]; repeatPct: number | null; sites: { count: number; kind: string }[]; onRequest: boolean }
    risks: string[]
    redFlags: string[]
    missingInfo: string[]
    sellerQuestions: string[]
    summary: Localized
    completeness: number
  } | null
  detailed: boolean // full details read from the site (description, address, coordinates)
}

export type CategoryStats = { count: number; medianGel: number | null; p25Gel: number | null; p75Gel: number | null }

export type FinancialsLevel = 'stated' | 'vague' | 'none'
