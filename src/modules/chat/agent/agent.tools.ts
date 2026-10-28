import { Type, type FunctionDeclaration } from '@google/genai'
import { pick, type Locale } from '../../../shared/i18n/locale.js'
import { categoryLabel, cityLabel, knownCategoryKeys, normalizeCity } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { catalog, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { analyzeArea, competitionBrief, locateAddress, locateListing } from '../../competition/area.service.js'
import { competitionSnapshot } from '../../competition/competition.service.js'
import { knowledge } from '../../knowledge/knowledge.service.js'
import { webSearch } from '../../web/web.service.js'
import { analyzeListing } from '../analysis/analysis.tool.js'
import type { SessionState } from '../chat.model.js'
import { applyPatch } from '../profile/profile.merge.js'
import { has, type Profile, type Track } from '../profile/profile.model.js'
import { deriveTrack } from '../profile/profile.track.js'
import type { Aspect } from '../router/router.schema.js'
import { toCard, type ListingCard } from '../tools/cards.js'
import { compareTable, listingFacts, marketFacts, scoreListings } from '../tools/facts.tool.js'
import { assetClassOf, relaxations, search } from '../tools/search.tool.js'
import type { QuickReply } from '../planner/planner.service.js'
import { intakeFields, type IntakeForm } from './agent.model.js'

// Everything the assistant can do besides talking: listings read live from mybusiness.ge, location and
// competition from Google Maps, our analysis, arithmetic, the web, and the UI (cards, chips, the intake form). Gemini decides when to call them; the results are
// facts it writes from. Tool output is kept compact: every token is paid for on the free tier.

export type ToolOutput = {
  cards: ListingCard[]
  compare: ReturnType<typeof compareTable> | null
  sources: { title: string; url: string }[]
  quickReplies: QuickReply[]
  form: IntakeForm | null
}

export type ToolContext = {
  s: CatalogSnapshot // replaced by a live snapshot when a tool fetches from the site
  sessionId: string
  turn: number
  locale: Locale
  profile: Profile
  state: SessionState
  out: ToolOutput
  progress: (step: string, count?: number) => Promise<void>
}

const GOALS = ['passive_income', 'own_job', 'growth', 'diversification', 'unsure'] as const
const INVOLVEMENT = ['hands_off', 'part_time', 'full_time'] as const
const EXPERIENCE = ['none', 'some', 'experienced'] as const
const RISK = ['low', 'medium', 'high'] as const
const ASPECTS: Aspect[] = ['overview', 'price', 'risks', 'missing', 'seller_questions', 'similar']

const str = (description: string, enumValues?: readonly string[]) => ({ type: Type.STRING, description, ...(enumValues ? { enum: [...enumValues] } : {}) })
const num = (description: string) => ({ type: Type.NUMBER, description })
const list = (items: object, description: string) => ({ type: Type.ARRAY, items, description })

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_listings',
    description:
      'Businesses for sale on mybusiness.ge right now, ranked for this user. Use when they want options or recommendations. Filters are optional; the stored profile (budget, cities, sectors) always applies. Shows the listings as cards: refer to them by title, do not list their fields.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        categories: list(str('Category key', knownCategoryKeys), 'Business types to search, by key'),
        cities: list(str('City in English, e.g. Tbilisi'), 'Cities to search'),
        max_price_gel: num('Upper price limit in GEL (defaults to the profile budget)'),
        exclude_shown: { type: Type.BOOLEAN, description: 'true to skip listings already shown ("show me more")' },
      },
    },
  },
  {
    name: 'get_listing',
    description: 'One listing as the site shows it now: the seller\'s full description, figures, address and our analysis (price vs similar listings, risks, what is missing). ref = listing id, URL, or "#2" for the 2nd listing on screen. Shows its card.',
    parameters: { type: Type.OBJECT, properties: { ref: str('Listing id, mybusiness.ge URL, or #N') }, required: ['ref'] },
  },
  {
    name: 'analyze_listing',
    description:
      'Deeper analysis of one listing for one question: price (vs market, per m², payback), risks, missing (information gaps), seller_questions (what to ask, with a draft message), similar (comparable listings, shown as cards). For location and competition use location_analysis.',
    parameters: { type: Type.OBJECT, properties: { ref: str('Listing id, URL or #N'), aspect: str('What to analyse', ASPECTS) }, required: ['ref', 'aspect'] },
  },
  {
    name: 'compare_listings',
    description: 'Side-by-side comparison of 2–3 listings (price, size, financials, fit). Shows a comparison table.',
    parameters: { type: Type.OBJECT, properties: { refs: list(str('Listing id, URL or #N'), '2 to 3 listings') }, required: ['refs'] },
  },
  {
    name: 'market_stats',
    description: 'Listing counts and asking-price statistics (median, range) on mybusiness.ge by business type and city.',
    parameters: {
      type: Type.OBJECT,
      properties: { categories: list(str('Category key', knownCategoryKeys), 'Business types (empty = all)'), cities: list(str('City in English'), 'Cities (empty = all)') },
    },
  },
  {
    name: 'location_analysis',
    description:
      'The place and its local competition: where exactly it is, the direct and related competitors around it by name and distance (from the map shown on the listing page), what else is within 500 m (offices, schools, hotels, transport, homes), how busy it looks, which uses are rare or saturated for a space, similar businesses for sale and the rent a space could earn; plus ratings and reviews from Google Maps when available. Use it for any listing with a place whenever location, competition or "will it work there" matters, for "would X work at <address>", and before suggesting what to open in a commercial space.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: str('Listing id, URL or #N (omit when judging an address)'),
        address: str('A street address or place, when there is no listing'),
        city: str('City in English, for an address'),
        business_type: str('Category key of the business to judge here (default: the listing\'s own; for a space, the use the client has in mind)', knownCategoryKeys),
        location_hint: str('A street, landmark or neighbourhood the seller names in the description, when the listing has no exact address'),
      },
    },
  },
  {
    name: 'calculate',
    description: 'Exact payback and return from figures. Use for any payback / ROI / yield question instead of doing the arithmetic yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        price_gel: num('Price of the business or property'),
        profit_monthly_gel: num('Net profit per month, after all costs'),
        rent_monthly_gel: num('Monthly rent income (for property)'),
        revenue_monthly_gel: num('Revenue per month (if profit is unknown)'),
        extra_gel: num('Extra investment: renovation, stock, working capital'),
        owner_salary_monthly_gel: num('Salary the buyer would pay themselves if they work in the business'),
      },
      required: ['price_gel'],
    },
  },
  {
    name: 'web_search',
    description: 'Google Search for current facts about Georgia or a market (tourism, population, inflation, wages, rents, sector size, laws, taxes). Not for general business knowledge you already have. Returns a short answer with sources; cite them as [1], [2].',
    parameters: { type: Type.OBJECT, properties: { query: str('The question to search, in any language') }, required: ['query'] },
  },
  {
    name: 'site_help',
    description: 'How mybusiness.ge works: posting a listing, packages and fees, contacting sellers, favourites, AI analysis. Use for questions about the site itself.',
    parameters: { type: Type.OBJECT, properties: { query: str('The question, in any language') }, required: ['query'] },
  },
  {
    name: 'update_profile',
    description: 'Remember what the user told you about themselves. Call it whenever they state or clearly imply any of these. Values must be exactly as listed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        budget_gel: num('Money they have to invest, in GEL (convert from USD/EUR). Never a listing price or a business figure'),
        goal: str('What they want from the business', GOALS),
        involvement: str('Time they can give', INVOLVEMENT),
        experience: str('Business experience', EXPERIENCE),
        experience_sectors: list(str('Category key', knownCategoryKeys), 'Sectors they have worked in'),
        risk: str('Risk appetite', RISK),
        capital_share: str('all = most of their savings, part = a part of their capital', ['all', 'part']),
        cities: list(str('City in English'), 'Preferred cities'),
        location_flexible: { type: Type.BOOLEAN, description: 'true when location does not matter' },
        sectors: list(str('Category key', knownCategoryKeys), 'Business types they want (empty list = open to anything)'),
        asset_openness: str('Whether rental property is also an option', ['business_only', 'open_to_property']),
        interest: str('Free-text description of what attracts them, in English'),
      },
    },
  },
  {
    name: 'suggest_replies',
    description: 'Offer up to 4 one-tap answers to the single question you end with (e.g. "Yes, show me", "Risks first"). Call it together with your final text. Ends your turn.',
    parameters: { type: Type.OBJECT, properties: { options: list(str('Short reply, max 6 words, in the reply language'), '2 to 4 options') }, required: ['options'] },
  },
  {
    name: 'show_form',
    description:
      'Ask several intake questions at once as a form (budget, time, goal, risk, location, business type…). Use it on the first turn with a new buyer who shared little, after a short intro text. Each option value must be from the allowed values of its field: budget = upper bound in GEL as a number string; capital_source = savings|loan|partner|mixed; involvement = hands_off|part_time|full_time; goal = passive_income|own_job|growth|diversification|unsure; risk = low|medium|high; experience = none|some|experienced; location = city in English, any, or online; sector = category key or any. Ends your turn.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: str('Short heading for the form, in the reply language'),
        questions: list(
          {
            type: Type.OBJECT,
            properties: {
              field: str('Which fact the question fills', intakeFields),
              question: str('The question, in the reply language'),
              options: list({ type: Type.OBJECT, properties: { value: str('Allowed value for the field'), label: str('Option text in the reply language') }, required: ['value', 'label'] }, '2 to 6 options'),
            },
            required: ['field', 'question', 'options'],
          },
          '3 to 7 questions, each field at most once',
        ),
        note_label: str('Label for an optional free-text field, e.g. "Anything else that matters?"'),
        submit_label: str('Submit button text, in the reply language'),
      },
      required: ['questions', 'submit_label'],
    },
  },
]

// Tools that end the turn: the UI shows their result, nothing more needs writing.
export const terminalTools = new Set(['suggest_replies', 'show_form'])

const fill = (text: string, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, String(v)), text)
const round = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n))

// "#2" → the 2nd listing on screen; otherwise an id or URL.
function resolveRef(ctx: ToolContext, ref: string): CatalogListing | undefined {
  const pos = ref.trim().match(/^#?(\d)$/)
  if (pos) {
    const id = ctx.state.lastShown[Number(pos[1]) - 1]
    return id ? ctx.s.byId.get(id) : undefined
  }
  return catalog.resolve(ctx.s, ref) ?? (ctx.state.contextListingId && /this|current|focus/i.test(ref) ? ctx.s.byId.get(ctx.state.contextListingId) : undefined)
}

// The listing as the site shows it right now; a removed one says so.
async function liveRef(ctx: ToolContext, ref: string): Promise<{ listing?: CatalogListing; error?: string }> {
  const known = resolveRef(ctx, ref)
  const live = await catalog.fetch(ctx.s, known?.id ?? ref)
  if (live === null) return { error: 'This listing is no longer on mybusiness.ge (sold, removed or expired).' }
  if (live !== 'unavailable') {
    ctx.s = live.snapshot
    return { listing: live.listing }
  }
  return known ? { listing: known } : { error: `No listing matches "${ref}". Ask the user for the listing link.` }
}

function compactListing(l: CatalogListing, ctx: ToolContext, ref: number, fit?: { score: number; reasons: string[] }) {
  const i = l.insights
  const f = i?.financials
  const money = (m: { min: number; max: number; currency: string } | null | undefined) => (m ? `${m.min === m.max ? m.min : `${m.min}-${m.max}`} ${m.currency}/month` : null)
  return {
    ref: `#${ref}`,
    id: l.shortId,
    title: pick(l.title, ctx.locale),
    category: categoryLabel(l.category, ctx.locale),
    city: cityLabel(l.city, ctx.locale),
    district: l.district,
    address: l.address,
    price_gel: round(l.priceGel),
    area_m2: l.area,
    asset_class: assetClassOf(l),
    seller_claims: {
      revenue: money(f?.revenue_monthly),
      profit: money(f?.profit_monthly),
      rent_income: money(f?.rent_income_monthly),
      staff: i?.staff.count ?? null,
      years_operating: i?.yearsOperating ?? null,
      premises: i?.premises.tenure ?? 'unknown',
      summary: i ? pick(i.summary, ctx.locale) : null,
      strengths: i?.strengths.slice(0, 4) ?? [],
    },
    our_notes: { red_flags: i?.redFlags.slice(0, 3) ?? [], missing: i?.missingInfo.slice(0, 4) ?? [], completeness: i?.completeness ?? 0 },
    fit: fit ? { score: fit.score, reasons: fit.reasons } : undefined,
    competition: competitionSnapshot(l, ctx.s, ctx.locale),
  }
}

function profileFacts(p: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) if (v && k !== 'budgetOriginal') out[k] = v.status === 'inferred' ? { value: v.value, inferred: true } : v.value
  return out
}

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>

const executors: Record<string, Executor> = {
  async search_listings(args, ctx) {
    const turn = ctx.turn
    const categories = ((args.categories as string[] | undefined) ?? []).filter((c) => ctx.s.categories.includes(c) || ['land', 'real_estate', 'commercial_space'].includes(c))
    const cities = ((args.cities as string[] | undefined) ?? []).map((c) => normalizeCity(c, ctx.s.cities)).filter((c): c is string => c !== null)
    const maxPrice = typeof args.max_price_gel === 'number' && args.max_price_gel > 0 ? args.max_price_gel : undefined
    // This search's filters on top of the stored profile.
    const p: Profile = { ...ctx.profile }
    if (categories.length) p.sectors = { value: categories, status: 'known', turn }
    if (cities.length) p.cities = { value: cities, status: 'known', turn }
    if (maxPrice) p.budgetGel = { value: maxPrice, status: 'known', turn }
    const track: Track = deriveTrack(p)

    await ctx.progress('live')
    ctx.s = await catalog.get()
    await ctx.progress('searching', ctx.s.listings.length)
    const exclude = args.exclude_shown ? new Set(ctx.state.lastShown) : undefined
    const options = { track, exclude, strictSectors: categories.length > 0 }
    // The best candidates are read in full (description, figures, address) and ranked again with what they say.
    const first = search(ctx.s, p, options)
    ctx.s = await catalog.withDetails(ctx.s, first.ranked.slice(0, 8).map((r) => r.listing.id))
    const result = search(ctx.s, p, options)
    const top = result.ranked.slice(0, 3)
    if (result.wildcard) top.push(result.wildcard)
    await ctx.progress('found', top.length)

    ctx.out.cards = top.map((r) => toCard(r.listing, ctx.locale, r, ctx.s.rates.USD))
    ctx.out.compare = null
    ctx.state.lastShown = top.map((r) => r.listing.id)
    ctx.state.contextListingId = undefined
    if (top.length === 0) {
      const options = relaxations(ctx.s, p, { track, strictSectors: categories.length > 0 }, result.pool.length)
      return { matches: 0, ways_to_widen: options.map((o) => ({ option: o.kind, extra_listings: o.extra })), note: 'Nothing matches all criteria right now. Offer the widening options.' }
    }
    return {
      matches: result.ranked.length + (result.wildcard ? 1 : 0),
      data_source: `live from mybusiness.ge (${ctx.s.loadedAt.toISOString().slice(11, 16)} UTC)`,
      shown: top.map((r, i) => compactListing(r.listing, ctx, i + 1, { score: r.score, reasons: r.reasons })),
      note: 'The cards are on screen. WILDCARD = a type they did not ask for but that fits.',
    }
  },

  async get_listing(args, ctx) {
    await ctx.progress('reading_listing')
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    const track = deriveTrack(ctx.profile)
    const fit = scoreListings([l], ctx.s, ctx.profile, track).get(l.id)
    const { facts } = analyzeListing({ listing: l, snapshot: ctx.s, profile: ctx.profile, track, locale: ctx.locale, aspect: 'overview' })
    // A card already in the conversation is not shown again: the answer is the new information.
    const onScreen = ctx.state.cardsShown.includes(l.id)
    if (!onScreen) ctx.out.cards = [toCard(l, ctx.locale, fit, ctx.s.rates.USD)]
    ctx.out.compare = null
    if (ctx.state.contextListingId !== l.id) ctx.state.aspectsAsked = [] // a different listing: its aspects start fresh
    ctx.state.contextListingId = l.id
    if (!ctx.state.lastShown.includes(l.id)) ctx.state.lastShown = [l.id]
    return {
      card: onScreen ? 'already on screen earlier in the conversation; not shown again' : 'shown',
      listing: listingFacts(l, ctx.s, ctx.locale, 1, fit),
      location: { city: l.city, district: l.district, address: l.address, exact_coordinates: l.latitude !== null },
      analysis: facts,
      seller_text: (l.description.original || l.description.en || '').slice(0, 2500),
    }
  },

  async analyze_listing(args, ctx) {
    const aspect = (ASPECTS.includes(args.aspect as Aspect) ? args.aspect : 'overview') as Aspect
    await ctx.progress(aspect === 'similar' || aspect === 'price' ? 'comparing' : 'reading_listing')
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    const track = deriveTrack(ctx.profile)
    const { analysis, facts } = analyzeListing({ listing: l, snapshot: ctx.s, profile: ctx.profile, track, locale: ctx.locale, aspect })
    ctx.state.contextListingId = l.id
    if (!ctx.state.aspectsAsked.includes(aspect)) ctx.state.aspectsAsked.push(aspect)
    if (aspect === 'similar' && analysis.comparables) {
      ctx.out.cards = analysis.comparables.cards
      ctx.state.lastShown = [l.id, ...analysis.comparables.cards.map((c) => c.id)]
    }
    return { listing: { id: l.shortId, title: pick(l.title, ctx.locale), url: analysis.questions?.listingUrl }, analysis: facts, draft_message_to_seller: analysis.questions?.draft }
  },

  async compare_listings(args, ctx) {
    await ctx.progress('comparing')
    const refs = ((args.refs as string[] | undefined) ?? []).slice(0, 3)
    const found: CatalogListing[] = []
    for (const r of refs) {
      const { listing } = await liveRef(ctx, r)
      if (listing && !found.some((x) => x.id === listing.id)) found.push(listing)
    }
    if (found.length < 2) return { error: 'Need at least two existing listings to compare.' }
    const track = deriveTrack(ctx.profile)
    const fits = scoreListings(found, ctx.s, ctx.profile, track)
    ctx.out.cards = found.map((l) => toCard(l, ctx.locale, fits.get(l.id), ctx.s.rates.USD))
    ctx.out.compare = compareTable(found, ctx.s, fits, ctx.locale)
    ctx.state.lastShown = found.map((l) => l.id)
    await ctx.progress('competition')
    const briefs = await Promise.all(found.map((l) => competitionBrief(l)))
    return {
      listings: found.map((l, i) => ({
        ...compactListing(l, ctx, i + 1, fits.get(l.id)),
        rent_monthly: l.insights?.premises.rent_monthly ?? null,
        premises: l.insights?.premises ?? null,
        risks_in_text: l.insights?.risks ?? [],
        competition_nearby: briefs[i],
        seller_text: (l.description.original || l.description.en || '').slice(0, 1200),
      })),
      note: 'A comparison table is on screen with the raw numbers. Write the full breakdown: per option price, size and rent, advantages, disadvantages and risks, a score out of 10 with its reason; then the best fit for this client and what to verify.',
    }
  },

  async market_stats(args, ctx) {
    await ctx.progress('market', ctx.s.listings.length)
    const cats = ((args.categories as string[] | undefined) ?? []).filter((c) => ctx.s.categories.includes(c))
    const cities = ((args.cities as string[] | undefined) ?? []).map((c) => normalizeCity(c, ctx.s.cities)).filter((c): c is string => c !== null)
    return marketFacts(ctx.s, cats, cities, ctx.locale)
  },

  async location_analysis(args, ctx) {
    await ctx.progress('competition')
    const ref = typeof args.ref === 'string' && args.ref.trim() ? args.ref : null
    const address = typeof args.address === 'string' ? args.address.trim() : ''
    const hint = typeof args.location_hint === 'string' ? args.location_hint : undefined
    let listing: CatalogListing | undefined
    if (ref) {
      const found = await liveRef(ctx, ref)
      if (!found.listing) return { error: found.error }
      listing = found.listing
    }
    const city = typeof args.city === 'string' ? normalizeCity(args.city, ctx.s.cities) : (listing?.city ?? null)
    const at = address ? await locateAddress(address, city) : listing ? await locateListing(listing, hint) : null
    if (!at) return { error: listing ? 'The listing has no usable location. Ask the user for the street or address.' : 'Give a listing or an address to analyse.' }
    const type = typeof args.business_type === 'string' && knownCategoryKeys.includes(args.business_type) ? args.business_type : (listing && !['commercial_space', 'real_estate', 'offices', 'warehouse', 'land'].includes(listing.category) ? listing.category : null)
    const { facts, sources } = await analyzeArea({ at, listing, businessType: type, s: ctx.s, locale: ctx.locale, sessionId: ctx.sessionId })
    if (sources.length) ctx.out.sources = sources
    if (listing) {
      if (ctx.state.contextListingId !== listing.id) ctx.state.aspectsAsked = []
      ctx.state.contextListingId = listing.id
      if (!ctx.state.aspectsAsked.includes('competition')) ctx.state.aspectsAsked.push('competition')
    }
    return {
      listing: listing && { id: listing.shortId, title: pick(listing.title, ctx.locale), category: categoryLabel(listing.category, ctx.locale), area_m2: listing.area, price_gel: round(listing.priceGel) },
      ...facts,
      note: 'Judge from these facts as a critical advisor: competition level and the strongest competitors by name, who the customers are, place-specific risks, and a plain verdict (good / workable with conditions / bad idea) with reasons. Map counts are a minimum (small or new places can be missing); say what to verify on site.',
    }
  },

  async calculate(args) {
    const price = Number(args.price_gel)
    const extra = Number(args.extra_gel ?? 0) || 0
    const salary = Number(args.owner_salary_monthly_gel ?? 0) || 0
    const total = price + extra
    const profit = Number(args.profit_monthly_gel ?? 0) || 0
    const rent = Number(args.rent_monthly_gel ?? 0) || 0
    const revenue = Number(args.revenue_monthly_gel ?? 0) || 0
    const monthly = (profit || rent) - salary
    if (!(price > 0)) return { error: 'price_gel must be positive' }
    if (monthly <= 0) {
      if (revenue > 0) {
        return {
          note: 'Payback needs net profit; these are illustrations at typical small-business margins, not facts',
          at_margin: [10, 15, 20].map((pct) => ({ margin_pct: pct, profit_monthly_gel: Math.round((revenue * pct) / 100), payback_months: Math.round(total / ((revenue * pct) / 100)) })),
        }
      }
      return { error: 'Need profit_monthly_gel or rent_monthly_gel (positive, after the owner salary) to calculate payback' }
    }
    const pm = (m: number) => ({ payback_months: Math.round(total / m), payback_years: Math.round((total / (m * 12)) * 10) / 10, annual_return_pct: Math.round(((m * 12) / total) * 100) })
    return {
      inputs: { price_gel: price, extra_investment_gel: extra, total_investment_gel: total, monthly_income_gel: monthly, owner_salary_deducted_gel: salary },
      result: pm(monthly),
      if_income_20pct_lower: pm(monthly * 0.8),
      if_income_20pct_higher: pm(monthly * 1.2),
      benchmark: 'Small businesses usually sell for 1–3 years of owner profit; rental property usually yields 6–10% a year',
    }
  },

  async web_search(args, ctx) {
    await ctx.progress('web')
    const a = await webSearch(String(args.query ?? '').slice(0, 300), ctx.locale, ctx.sessionId)
    ctx.out.sources = a.sources
    if (!a.summary) return { error: 'Search is unavailable right now; answer from your own knowledge and say the figures are approximate.' }
    return { answer: a.summary, sources: a.sources.map((x, i) => ({ n: i + 1, title: x.title })), note: 'Use these facts in your own words. Cite as [n]; the sources are listed under your answer automatically.' }
  },

  async site_help(args, ctx) {
    await ctx.progress('knowledge')
    const hits = await knowledge.search(String(args.query ?? ''), 3, ctx.sessionId, ctx.locale, 'site_help')
    return { sections: hits.map((h) => ({ title: h.title, content: h.content.slice(0, 1200), url: h.url })) }
  },

  async update_profile(args, ctx) {
    const patch: Record<string, unknown> = {}
    const enumOk = <T extends readonly string[]>(v: unknown, allowed: T): v is T[number] => typeof v === 'string' && allowed.includes(v)
    if (typeof args.budget_gel === 'number' && args.budget_gel >= 500) {
      // A stated budget far from the one on file is kept aside until confirmed (the classic flow asks); here we
      // trust the model's reading but never let a listing price slip in: it must not equal a shown price.
      const shownPrices = ctx.state.lastShown.map((id) => ctx.s.byId.get(id)?.priceGel ?? -1)
      if (!shownPrices.some((p) => Math.abs(p - Number(args.budget_gel)) < 1)) patch.budgetGel = Math.round(args.budget_gel)
    }
    if (enumOk(args.goal, GOALS)) patch.goal = args.goal
    if (enumOk(args.involvement, INVOLVEMENT)) patch.involvement = args.involvement
    if (enumOk(args.experience, EXPERIENCE)) patch.experience = args.experience
    if (enumOk(args.risk, RISK)) patch.risk = args.risk
    if (enumOk(args.capital_share, ['all', 'part'] as const)) patch.capitalShare = args.capital_share
    if (enumOk(args.asset_openness, ['business_only', 'open_to_property'] as const)) patch.assetOpenness = args.asset_openness
    if (Array.isArray(args.sectors)) patch.sectors = args.sectors.filter((c) => typeof c === 'string' && (ctx.s.categories.includes(c) || ['land', 'real_estate', 'commercial_space'].includes(c)))
    if (Array.isArray(args.experience_sectors)) patch.experienceSectors = args.experience_sectors.filter((c) => typeof c === 'string' && knownCategoryKeys.includes(c))
    if (Array.isArray(args.cities)) {
      const cities = args.cities.map((c) => normalizeCity(String(c), ctx.s.cities)).filter((c): c is string => c !== null)
      if (cities.length) {
        patch.cities = cities
        patch.locationFlexible = false
      }
    }
    if (args.location_flexible === true) patch.locationFlexible = true
    if (typeof args.interest === 'string' && args.interest.trim().length > 2) patch.interest = args.interest.trim().slice(0, 200)
    if (Object.keys(patch).length) ctx.profile = applyPatch(ctx.profile, patch, ctx.turn).profile
    return { profile: profileFacts(ctx.profile), ready_for_recommendations: has(ctx.profile, 'budgetGel') && (has(ctx.profile, 'goal') || has(ctx.profile, 'involvement')) }
  },

  async suggest_replies(args, ctx) {
    const options = ((args.options as string[] | undefined) ?? []).map((o) => String(o).trim()).filter((o) => o && o.length <= 60).slice(0, 4)
    ctx.out.quickReplies = options.map((o, i) => ({ kind: 'message', id: `ai:${i}`, label: o, text: o }))
    return { shown: options.length, note: 'The buttons appear under your reply. If you have not written the reply text yet, write it now.' }
  },

  async show_form(args, ctx) {
    const raw = args as { title?: string; questions?: { field?: string; question?: string; options?: { value?: string; label?: string }[] }[]; note_label?: string; submit_label?: string }
    // One question per field, each with at least two real options. The model sometimes names a field its own way
    // ("budget_gel", "city", "business_type"): those are mapped; truly unknown fields are dropped. An option that
    // has only a label uses it as the value too.
    const seen = new Set<string>()
    const questions: IntakeForm['questions'] = []
    const dropped: string[] = []
    for (const q of raw.questions ?? []) {
      const field = intakeField(q.field)
      if (!field || !q.question) {
        if (q.field) dropped.push(String(q.field))
        continue
      }
      if (seen.has(field)) continue
      const options = (q.options ?? [])
        .filter((o) => o.label || o.value)
        .slice(0, 6)
        .map((o) => ({ value: String(o.value ?? o.label).slice(0, 60), label: String(o.label ?? o.value).slice(0, 80) }))
      if (options.length < 2) continue
      seen.add(field)
      questions.push({ field, question: String(q.question).slice(0, 200), options })
      if (questions.length === 7) break
    }
    if (questions.length === 0) return { error: `No valid questions (unknown fields: ${dropped.join(', ') || 'none'}; allowed: ${intakeFields.join(', ')}). Call show_form again with these fields, or ask in plain text.` }
    ctx.out.form = {
      title: raw.title?.slice(0, 200),
      questions,
      noteLabel: raw.note_label?.slice(0, 120),
      submitLabel: (raw.submit_label ?? 'OK').slice(0, 40),
    }
    return { shown: questions.length, note: 'The form appears under your reply. If you have not written the short intro yet, write it now; do not repeat the questions.' }
  },
}

// A field name as the model wrote it → one of ours.
function intakeField(raw: unknown): (typeof intakeFields)[number] | null {
  const key = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '')
  const aliases: Record<string, (typeof intakeFields)[number]> = {
    budget: 'budget', budgetgel: 'budget', budgetrange: 'budget', capital: 'budget', investment: 'budget', amount: 'budget',
    capitalsource: 'capital_source', source: 'capital_source', financing: 'capital_source', funding: 'capital_source',
    involvement: 'involvement', time: 'involvement', timecommitment: 'involvement', hours: 'involvement', availability: 'involvement',
    goal: 'goal', goals: 'goal', purpose: 'goal', objective: 'goal',
    risk: 'risk', riskappetite: 'risk', risklevel: 'risk', risktolerance: 'risk',
    location: 'location', city: 'location', cities: 'location', region: 'location', place: 'location',
    sector: 'sector', sectors: 'sector', businesstype: 'sector', category: 'sector', industry: 'sector', type: 'sector',
    experience: 'experience', experiencelevel: 'experience', background: 'experience',
  }
  return aliases[key] ?? null
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const exec = executors[name]
  if (!exec) return { error: `Unknown tool ${name}` }
  try {
    return await exec(args, ctx)
  } catch (err) {
    return { error: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// The user's intake-form answers → profile values, applied without a model call.
export function applyFormAnswers(profile: Profile, answers: { field: string; value: string }[], cities: string[], categories: string[], turn: number): Profile {
  const patch: Record<string, unknown> = {}
  for (const a of answers) {
    const v = a.value.trim()
    switch (a.field) {
      case 'budget': {
        const n = Number(v.replace(/[^\d.]/g, ''))
        if (n >= 500) patch.budgetGel = Math.round(n)
        break
      }
      case 'capital_source':
        if (['savings', 'loan', 'partner', 'mixed'].includes(v)) patch.capitalShare = v === 'savings' ? 'all' : 'part'
        break
      case 'involvement':
        if ((INVOLVEMENT as readonly string[]).includes(v)) patch.involvement = v
        break
      case 'goal':
        if ((GOALS as readonly string[]).includes(v)) patch.goal = v
        break
      case 'risk':
        if ((RISK as readonly string[]).includes(v)) patch.risk = v
        break
      case 'experience':
        if ((EXPERIENCE as readonly string[]).includes(v)) patch.experience = v
        break
      case 'location': {
        if (v === 'any' || v === 'online') patch.locationFlexible = true
        else {
          const c = normalizeCity(v, cities)
          if (c) {
            patch.cities = [c]
            patch.locationFlexible = false
          }
        }
        break
      }
      case 'sector':
        if (v === 'any') patch.sectors = []
        else if (categories.includes(v) || ['land', 'real_estate', 'commercial_space'].includes(v)) patch.sectors = [v]
        break
    }
  }
  return Object.keys(patch).length ? applyPatch(profile, patch, turn).profile : profile
}

export { profileFacts, fill }
