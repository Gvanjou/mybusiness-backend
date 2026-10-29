import { Type, type FunctionDeclaration } from '@google/genai'
import { formatGel, pick, type Locale } from '../../../shared/i18n/locale.js'
import { alerts } from '../../alerts/alerts.service.js'
import { categoriesNamed, categoryLabel, cityLabel, knownCategoryKeys, normalizeCity } from '../../catalog/catalog.labels.js'
import type { CatalogListing } from '../../catalog/catalog.model.js'
import { areaOf, catalog, type CatalogSnapshot } from '../../catalog/catalog.service.js'
import { analyzeArea, competitionBrief, locateAddress, locateListing } from '../../competition/area.service.js'
import { knowledge } from '../../knowledge/knowledge.service.js'
import { webSearch } from '../../web/web.service.js'
import { toGel, type FxRates } from '../../fx/fx.service.js'
import { extractAmounts } from '../../../shared/text/amounts.js'
import { analyzeListing } from '../analysis/analysis.tool.js'
import type { SessionState } from '../chat.model.js'
import type { EarlierChat } from '../chat.repository.js'
import { applyPatch } from '../profile/profile.merge.js'
import { has, val, type Profile, type Track } from '../profile/profile.model.js'
import { deriveTrack } from '../profile/profile.track.js'
import type { Aspect } from '../router/router.schema.js'
import { listingUrl, type ListingCard } from '../tools/cards.js'
import { marketFacts, scoreListings } from '../tools/facts.tool.js'
import { relaxations, search } from '../tools/search.tool.js'
import type { QuickReply } from '../planner/planner.service.js'
import { cardFor, compareTable, decimal, factSheet, idOfRef, refOf, rememberPlace, shortName, type CompareTable } from './agent.facts.js'
import { bucketFloor, formWanted, missingKeyFacts } from './agent.fallback.js'
import type { IntakeForm } from './agent.model.js'

// Everything the assistant can do besides talking: listings read live from mybusiness.ge, location and
// competition from the map, our analysis, arithmetic, the web, and the UI (cards, chips, the intake form, the
// message to the seller, the visit checklist, alerts). Gemini decides when to call them; the results are facts it
// writes from. Tool output is kept compact: every token is paid for.

export type Handoff = { listingId: string; n: number; name: string; url: string; text: string }
export type Checklist = { listingId: string; n: number; name: string; items: string[] }
export type AlertCard = { id: string; label: string }

export type ToolOutput = {
  cards: ListingCard[]
  compare: CompareTable | null
  sources: { title: string; url: string }[]
  quickReplies: QuickReply[]
  form: IntakeForm | null
  formRequested?: boolean // show_form was called: the standard form is built at the end of the turn
  handoff: Handoff | null // a ready message to the seller
  checklist: Checklist | null // what to check on site
  alert: AlertCard | null // a saved search was created
  note: string | null // voice calls: what the AI put on screen instead of reading it out (show_note)
}

export const emptyOutput = (): ToolOutput => ({ cards: [], compare: null, sources: [], quickReplies: [], form: null, handoff: null, checklist: null, alert: null, note: null })

export type ToolContext = {
  s: CatalogSnapshot // replaced by a live snapshot when a tool fetches from the site
  sessionId: string
  userId?: string | null
  turn: number
  locale: Locale
  profile: Profile
  state: SessionState
  out: ToolOutput
  progress: (step: string, count?: number) => Promise<void>
  userText?: string // the client's message this turn, for tools that must honour what it names
  earlier?: EarlierChat[] // the client's other conversations, newest first (read only by recall_previous_chats)
  discussed?: string[] // listings the last two answers named ("#4"), for the fact sheets in CONTEXT
}

const GOALS = ['passive_income', 'own_job', 'growth', 'diversification', 'unsure'] as const
const INVOLVEMENT = ['hands_off', 'part_time', 'full_time'] as const
const EXPERIENCE = ['none', 'some', 'experienced'] as const
const RISK = ['low', 'medium', 'high'] as const
const ASPECTS: Aspect[] = ['overview', 'price', 'risks', 'missing', 'seller_questions', 'similar']
const PROPERTY = ['land', 'real_estate', 'commercial_space']

const str = (description: string, enumValues?: readonly string[]) => ({ type: Type.STRING, description, ...(enumValues ? { enum: [...enumValues] } : {}) })
const num = (description: string) => ({ type: Type.NUMBER, description })
const list = (items: object, description: string) => ({ type: Type.ARRAY, items, description })
const refParam = str('"#2", an id, a URL or the name the client used')
// The declarations go with every model call, so they say only what the model needs to choose and call each tool
// (measured: 3 600 tokens before, most of the prompt). The 38 category keys are listed once, on search_listings;
// elsewhere a near miss ("cafe", "კაფე") is mapped to its key by categoryArgs.
const categoryList = (description: string) => list({ type: Type.STRING, enum: [...knownCategoryKeys] }, description)
const categoryKeys = (description: string) => list({ type: Type.STRING }, `${description}: category keys, as in search_listings`)
const cityList = list({ type: Type.STRING }, 'Cities, in English')
const scenarios = (description: string) => list({ type: Type.NUMBER }, `${description} for [cautious, realistic, optimistic]`)

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'search_listings',
    description: 'Businesses for sale on mybusiness.ge, ranked for this client and shown as numbered cards; returns their fact sheets. The profile (budget, cities, types) always applies.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        categories: categoryList('Business types'),
        cities: cityList,
        max_price_gel: num('Price limit in GEL (default: the budget)'),
        exclude_shown: { type: Type.BOOLEAN, description: 'true for "show me more"' },
      },
    },
  },
  {
    name: 'recall_previous_chats',
    description: "The client's earlier chats: titles, dates, facts learned, listings shown. Ask before using any of it here.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'get_listing',
    description: "One listing as the site shows it now: fact sheet, the seller's full text, risk notes. Shows its card if new.",
    parameters: { type: Type.OBJECT, properties: { ref: refParam }, required: ['ref'] },
  },
  {
    name: 'analyze_listing',
    description: 'One listing in depth: price (against the same type and size), risks, missing information, seller_questions, similar (shown as cards). Location: location_analysis; profit: profit_scenarios.',
    parameters: { type: Type.OBJECT, properties: { ref: refParam, aspect: str('What to analyse', ASPECTS) }, required: ['ref', 'aspect'] },
  },
  {
    name: 'compare_listings',
    description: 'The comparison table under your text, plus each fact sheet with its competitors. Omit refs for every listing on screen; ["saved"] for the saved ones.',
    parameters: { type: Type.OBJECT, properties: { refs: list(refParam, 'Only the listings the client named') } },
  },
  {
    name: 'market_stats',
    description: 'Listing counts and asking-price median and range on mybusiness.ge, by business type and city.',
    parameters: { type: Type.OBJECT, properties: { categories: categoryKeys('Business types (empty = all)'), cities: cityList } },
  },
  {
    name: 'location_analysis',
    description:
      'The place from the listing\'s map: where it is, competitors by name and distance, what is within 500 m, how busy it looks, which uses are rare or saturated for a space. Use whenever location, competition or "will it work there" matters, and before suggesting uses for a space.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: refParam,
        address: str('An address, when there is no listing'),
        city: str('City in English, with an address'),
        business_type: str("Category key to judge here (default: the listing's own; for a space, the client's idea)"),
        location_hint: str('A street or landmark the description names, when there is no exact address'),
      },
    },
  },
  {
    name: 'profit_scenarios',
    description: 'Cautious, realistic and optimistic profit computed exactly, with payback and yearly return. Use for every profit, income or payback question: pass your assumptions, never compute profit yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: refParam,
        price_gel: num('Price, when there is no listing'),
        extra_investment_gel: num('Renovation, stock, working capital'),
        revenue_monthly_gel: scenarios('Monthly revenue in GEL'),
        customers_per_day: scenarios('Customers a day, instead of revenue,'),
        average_check_gel: num('Spend per customer'),
        open_days_per_month: num('Default 30'),
        cost_of_goods_pct: num('% of revenue (café ≈ 30–35)'),
        rent_monthly_gel: num("Default: the listing's rent"),
        staff_monthly_gel: num('All wages a month'),
        owner_salary_monthly_gel: num('If the buyer works in it'),
        utilities_monthly_gel: num('Power, gas, water, internet a month'),
        other_monthly_gel: num('Accounting, marketing, delivery fees… a month'),
        tax_pct_of_revenue: num('Default 1 (small business status)'),
      },
    },
  },
  {
    name: 'calculate',
    description: 'Exact payback and yearly return from a price and a stated monthly profit, or rent income for property.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        price_gel: num('Price'),
        profit_monthly_gel: num('Net profit a month'),
        rent_monthly_gel: num('Rent income a month (property)'),
        extra_gel: num('Renovation, stock, working capital'),
        owner_salary_monthly_gel: num('If the buyer works in it'),
      },
      required: ['price_gel'],
    },
  },
  {
    name: 'web_search',
    description: 'Google Search for current facts about Georgia or a market (tourism, wages, rents, laws, taxes), not general knowledge. Cite its sources as [1], [2].',
    parameters: { type: Type.OBJECT, properties: { query: str('The question') }, required: ['query'] },
  },
  {
    name: 'site_help',
    description: 'How mybusiness.ge works: posting a listing, packages and fees, contacting sellers, favourites.',
    parameters: { type: Type.OBJECT, properties: { query: str('The question') }, required: ['query'] },
  },
  {
    name: 'update_profile',
    description: 'Remember what the client states or clearly implies about themselves. Values exactly as listed.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        budget_amount: num('Money they can invest, exactly as they said it (150000 for "$150 000"). Never a listing price'),
        budget_currency: str('The currency they said it in', ['GEL', 'USD', 'EUR']),
        budget_gel: num('Only when the client gave no currency: the budget in GEL'),
        goal: str('Goal', GOALS),
        involvement: str('Time they can give', INVOLVEMENT),
        experience: str('Business experience', EXPERIENCE),
        experience_sectors: categoryKeys('Sectors they worked in'),
        risk: str('Risk appetite', RISK),
        capital_share: str('all = most of their savings', ['all', 'part']),
        cities: cityList,
        location_flexible: { type: Type.BOOLEAN, description: 'true when location does not matter' },
        sectors: categoryKeys('Business types they want (empty = any)'),
        asset_openness: str('Is rental property also an option', ['business_only', 'open_to_property']),
        interest: str('What attracts them, in English'),
      },
    },
  },
  {
    name: 'suggest_replies',
    description: 'Up to 3 one-tap answers to your closing question. Call it with your final text; ends your turn.',
    parameters: { type: Type.OBJECT, properties: { options: list(str('Max 6 words, in the reply language'), '2 or 3') }, required: ['options'] },
  },
  {
    name: 'show_form',
    description: 'The fixed intake form (budget, goal, time, city, type), pre-filled with what is known. Only when two or more of budget, time, city and type are unknown. Ends your turn.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'seller_message',
    description: 'A ready message to the seller, shown with Copy and Open listing. Use when the client asks what to ask the seller, wants to contact them or asks for a phone number.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: refParam,
        message: str('In the reply language, formal and polite throughout (Georgian: "დაინტერესებული ვარ", "თქვენ"): greeting, which listing (by its type and street or district, never "#n": the seller does not know the chat\'s numbers), the open questions — only what the listing does not state (its sheet\'s not_stated and check lines: turnover, rent and lease, staff, debts…), never the reason for sale when the sheet has it — documents or a visit. Under 120 words, no placeholders.'),
      },
      required: ['ref', 'message'],
    },
  },
  {
    name: 'visit_checklist',
    description: 'A tickable on-site checklist kept with the listing. Use when the client plans a visit.',
    parameters: { type: Type.OBJECT, properties: { ref: refParam, items: list(str('Short, in the reply language'), '6 to 10, most important first') }, required: ['ref', 'items'] },
  },
  {
    name: 'create_alert',
    description: 'Save a search: a notice appears at the top of this chat when a new match is listed (nothing by email or phone). Only after the client said yes to being told. Defaults to the profile.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        categories: categoryKeys('Business types'),
        cities: cityList,
        max_price_gel: num('Price limit in GEL'),
        label: str('Short name in the reply language, e.g. "კაფე ბათუმში, 30 000 ₾-მდე"'),
      },
    },
  },
]

// The tools offered on a step. One its executor would refuse is left out, which saves its tokens and a refused call:
// the form when it is not the next step (see formWanted), earlier chats when there are none.
export function toolsFor(ctx: ToolContext): FunctionDeclaration[] {
  const named = has(ctx.profile, 'sectors') ? [] : categoriesNamed(ctx.userText ?? '')
  const profile = named.length ? applyPatch(ctx.profile, { sectors: named }, ctx.turn).profile : ctx.profile
  const formAllowed = formWanted(profile)
  return toolDeclarations.filter((t) => (t.name !== 'show_form' || formAllowed) && (t.name !== 'recall_previous_chats' || Boolean(ctx.earlier?.length)))
}

// Usual monthly costs, used for the lines the model leaves out of a profit calculation and marked "typical" in the
// table. Assumptions, not data: a service worker's wage (Geostat puts the average wage in accommodation and food
// service near 1 200 ₾), a manager's, utilities per m² (food businesses run ovens and fridges), and a fixed sum for
// accounting, the till and some marketing.
const STAFF_WAGE_GEL = 1_200
const MANAGER_WAGE_GEL = 2_000
const FOOD_SERVICE = ['restaurants', 'bakery', 'bar_nightclub', 'food_products']
const PROPERTY_TYPES = ['real_estate', 'commercial_space', 'offices', 'warehouse', 'land']

function typicalCosts(l: CatalogListing | undefined, passive: boolean): { staff: number; manager: number; utilities: number; other: number } {
  const food = Boolean(l && FOOD_SERVICE.includes(l.category))
  const area = l ? areaOf(l) : null
  const space = area ?? (food ? 50 : 40)
  const stated = l?.insights?.staff.count
  // The seller's staff count, unless it is not believable for the space (see the fact sheet's check line).
  const people = stated && stated > 0 && !(area && area / stated < 2) ? stated : Math.max(food ? 2 : 1, Math.ceil(space / (food ? 30 : 50)))
  return { staff: people * STAFF_WAGE_GEL, manager: passive ? MANAGER_WAGE_GEL : 0, utilities: Math.round(Math.max(food ? 400 : 200, space * (food ? 10 : 5))), other: 400 }
}

// The usual cost of goods, % of revenue, for the types that sell food or goods: used when the model gives none.
const TYPICAL_COGS_PCT: Partial<Record<string, number>> = { restaurants: 32, bakery: 35, bar_nightclub: 30, food_products: 45, supermarket: 75, retail: 60, clothing_store: 55, pharmacy: 70 }

// Tools that end the turn: the UI shows their result, nothing more needs writing.
export const terminalTools = new Set(['suggest_replies', 'show_form'])

const round = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n))

// Category keys from a tool call. Only search_listings lists the keys as an enum, so elsewhere the model may write a
// name instead ("cafe", "კაფე"): it is mapped to its key, and anything else is dropped.
function categoryArgs(values: unknown, allowed: (key: string) => boolean): string[] {
  if (!Array.isArray(values)) return []
  const keys = values.flatMap((v) => (typeof v !== 'string' ? [] : knownCategoryKeys.includes(v) || PROPERTY.includes(v) ? [v] : categoriesNamed(v)))
  return [...new Set(keys)].filter(allowed)
}

// "#2" → listing #2 of this chat; otherwise an id, a URL or a title.
function resolveRef(ctx: ToolContext, ref: string): CatalogListing | undefined {
  const r = ref.trim()
  if (!/[0-9a-f]{8}/i.test(r)) {
    const n = r.match(/^#?\s*(\d{1,3})(?!\d)/)
    if (n) {
      const id = idOfRef(ctx.state, Number(n[1]))
      return id ? ctx.s.byId.get(id) : undefined
    }
  }
  return catalog.resolve(ctx.s, r) ?? byTitle(ctx, r) ?? (ctx.state.contextListingId && /this|current|focus/i.test(r) ? ctx.s.byId.get(ctx.state.contextListingId) : undefined)
}

// A listing named by its title or short name, among those shown in this conversation first.
function byTitle(ctx: ToolContext, ref: string): CatalogListing | undefined {
  const name = ref.replace(/^#?\d{1,3}\s*/, '').replace(/[„“"«»'”]/g, '').trim().toLowerCase()
  if (name.length < 4) return undefined
  const seen = [...ctx.state.refs, ctx.state.contextListingId].filter((x): x is string => Boolean(x))
  const pool = [...seen.map((id) => ctx.s.byId.get(id)).filter((l): l is CatalogListing => Boolean(l)), ...ctx.s.listings]
  const names = (l: CatalogListing) => [l.title.ka, l.title.en, l.title.ru, shortName(l, ctx.locale)].filter(Boolean).map((t) => t!.toLowerCase())
  return pool.find((l) => names(l).some((t) => t === name)) ?? pool.find((l) => names(l).some((t) => t.includes(name) || name.includes(t)))
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
  return known ? { listing: known } : { error: `No listing matches "${ref}". Ask the client which one they mean (by its number) or for the link.` }
}

function profileFacts(p: Profile): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) if (v && k !== 'budgetOriginal') out[k] = v.status === 'inferred' ? { value: v.value, inferred: true } : v.value
  return out
}

// The cards that are new to this chat: one already shown is referred to by its number, not shown again.
function newCards(ctx: ToolContext, cards: ListingCard[]): ListingCard[] {
  const shown = new Set([...ctx.state.cardsShown, ...ctx.out.cards.map((c) => c.id)])
  return cards.filter((c) => !shown.has(c.id))
}

// Topics already answered for a listing, so the next-step chips do not offer them again.
export function markTopic(state: SessionState, id: string, topic: string): void {
  const done = state.topics[id] ?? []
  if (!done.includes(topic)) state.topics[id] = [...done, topic].slice(-8)
}

function focus(ctx: ToolContext, l: CatalogListing): void {
  ctx.state.contextListingId = l.id
  if (!ctx.state.lastShown.includes(l.id)) ctx.state.lastShown = [l.id]
}

// The buyer's budget, for "over budget" warnings on fact sheets and cards.
const budgetOf = (ctx: ToolContext) => val(ctx.profile, 'budgetGel')
const sheet = (ctx: ToolContext, l: CatalogListing) => factSheet(l, ctx.s, ctx.state, ctx.locale, budgetOf(ctx))
const card = (ctx: ToolContext, l: CatalogListing, scored?: Parameters<typeof cardFor>[4]) => cardFor(l, ctx.s, ctx.state, ctx.locale, scored, budgetOf(ctx))

const sellerText = (l: CatalogListing, max: number) => (l.description.original || l.description.en || '').slice(0, max)

type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>

const executors: Record<string, Executor> = {
  // Voice calls only (its declaration is in chat/voice): written text the client reads instead of hearing.
  async show_note(args, ctx) {
    const markdown = String(args.markdown ?? '').replace(/<[^>]*>/g, '').trim().slice(0, 3000)
    if (!markdown) return { error: 'Give the note as markdown.' }
    ctx.out.note = ctx.out.note ? `${ctx.out.note}\n\n${markdown}` : markdown
    return { shown: true, note: 'It is on the screen now: say so in a few words; do not read it out.' }
  },

  async search_listings(args, ctx) {
    const turn = ctx.turn
    const categories = categoryArgs(args.categories, (c) => ctx.s.categories.includes(c) || PROPERTY.includes(c))
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
    // With a budget, a listing without a price can't be judged against it ("price on request" cards were noise).
    const unpriced = val(p, 'budgetGel') ? ctx.s.listings.filter((l) => l.priceGel === null).map((l) => l.id) : []
    const exclude = new Set([...(args.exclude_shown ? ctx.state.refs : []), ...unpriced])
    const options = { track, exclude, strictSectors: categories.length > 0 }
    // The best candidates are read in full (description, figures, address) and ranked again with what they say.
    const first = search(ctx.s, p, options)
    ctx.s = await catalog.withDetails(ctx.s, first.ranked.slice(0, 8).map((r) => r.listing.id))
    const result = search(ctx.s, p, options)
    const top = result.ranked.slice(0, 3)
    if (result.wildcard) top.push(result.wildcard)
    if (top.length) await ctx.progress('found', top.length) // "matching options found" is said only when there are some

    // Numbers are given in rank order, so card #n and "#n" in the text are the same listing.
    const cards = top.map((r) => card(ctx, r.listing, r))
    const fresh = newCards(ctx, cards)
    ctx.out.cards = fresh
    ctx.out.compare = null
    ctx.state.lastShown = top.map((r) => r.listing.id)
    ctx.state.contextListingId = undefined
    if (top.length === 0) {
      const options = relaxations(ctx.s, p, { track, strictSectors: categories.length > 0 }, result.pool.length)
      return { matches: 0, ways_to_widen: options.map((o) => ({ option: o.kind, extra_listings: o.extra })), note: 'Nothing matches all criteria right now. Offer the widening options first; then ask whether to tell them when one appears (yes/no chips), and call create_alert only after a yes.' }
    }
    return {
      matches: result.ranked.length + (result.wildcard ? 1 : 0),
      data_source: `live from mybusiness.ge (${ctx.s.loadedAt.toISOString().slice(11, 16)} UTC)`,
      budget_note: top.some((r) => r.listing.priceGel !== null && budgetOf(ctx) && r.listing.priceGel > budgetOf(ctx)!) ? 'Some listings are over the budget (see each fact sheet\'s "budget" line): say so plainly, with the amount, before recommending one.' : undefined,
      shown: top.map((r) => ({
        ...sheet(ctx, r.listing),
        fit: { score: r.score, reasons: r.reasons },
        card: fresh.some((c) => c.id === r.listing.id) ? 'shown now' : 'already shown earlier in this chat: refer to it by its number',
        wildcard: r === result.wildcard || undefined,
      })),
      note: 'The cards are on screen, numbered as in "ref". WILDCARD = a type they did not ask for but that fits.',
    }
  },

  async recall_previous_chats(_args, ctx) {
    const chats = (ctx.earlier ?? []).map((c) => {
      const ids = [...new Set([c.state.contextListingId, ...c.state.cardsShown.slice().reverse()].filter((id): id is string => Boolean(id)))]
      const listings = ids.map((id) => ctx.s.byId.get(id)).filter((l): l is CatalogListing => Boolean(l))
      return {
        title: c.title,
        date: c.updatedAt.slice(0, 10),
        facts: profileFacts(c.profile),
        listings: listings.slice(0, 6).map((l) => ({ id: l.shortId, name: shortName(l, ctx.locale), price_gel: l.priceGel && Math.round(l.priceGel) })),
        listings_no_longer_on_site: ids.length - listings.length,
      }
    })
    if (!chats.length) return { chats: [], note: 'This client has no earlier chats. Say so if they asked, and ask for what you need.' }
    return {
      chats,
      note: 'From earlier chats, NOT applied to this one. Tell the client what you found and which chat it is from (the oldest answer first when they ask what they said "at the start"), and ask whether to use it now. Call update_profile only with facts they confirm. A listing can be opened with get_listing by its id.',
    }
  },

  async get_listing(args, ctx) {
    await ctx.progress('reading_listing')
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    const fit = scoreListings([l], ctx.s, ctx.profile, deriveTrack(ctx.profile)).get(l.id)
    const { facts } = analyzeListing({ listing: l, snapshot: ctx.s, profile: ctx.profile, track: deriveTrack(ctx.profile), locale: ctx.locale, aspect: 'overview' })
    const shown = newCards(ctx, [card(ctx, l, fit)])
    ctx.out.cards = [...ctx.out.cards, ...shown]
    ctx.out.compare = null
    focus(ctx, l)
    return {
      card: shown.length ? 'shown now' : 'already in this chat: refer to it by its number',
      fact_sheet: sheet(ctx, l),
      risk_notes: { risks: facts.risks, missing: facts.missing, red_flags_in_text: facts.seller_text_red_flags },
      location: { city: l.city, district: l.district, address: l.address, exact_coordinates: l.latitude !== null },
      seller_text: sellerText(l, 2500),
    }
  },

  async analyze_listing(args, ctx) {
    const aspect = (ASPECTS.includes(args.aspect as Aspect) ? args.aspect : 'overview') as Aspect
    await ctx.progress(aspect === 'similar' || aspect === 'price' ? 'comparing' : 'reading_listing')
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    const { analysis, facts } = analyzeListing({ listing: l, snapshot: ctx.s, profile: ctx.profile, track: deriveTrack(ctx.profile), locale: ctx.locale, aspect })
    focus(ctx, l)
    markTopic(ctx.state, l.id, aspect === 'seller_questions' ? 'seller' : aspect)
    if (aspect === 'similar' && analysis.comparables) {
      const similar = analysis.comparables.cards.map((c) => ctx.s.byId.get(c.id)).filter((x): x is CatalogListing => Boolean(x))
      ctx.out.cards = newCards(ctx, similar.map((x) => card(ctx, x)))
      ctx.state.lastShown = [l.id, ...similar.map((x) => x.id)]
      return { listing: sheet(ctx, l), similar: similar.map((x) => sheet(ctx, x)) }
    }
    return { listing: sheet(ctx, l), analysis: facts }
  },

  async compare_listings(args, ctx) {
    await ctx.progress('comparing')
    // "Compare them" means all the listings on screen; only a message that names some (by number, title, link,
    // "the first two"…) narrows it. The model tends to pass two refs even when three were shown.
    const asked = ((args.refs as string[] | undefined) ?? []).filter((r) => typeof r === 'string' && r.trim())
    const onScreen = ctx.state.lastShown.filter((id) => ctx.s.byId.has(id))
    const shownListings = onScreen.map((id) => ctx.s.byId.get(id)!)
    const wantsSaved = asked.some((r) => /^saved$/i.test(r.trim()))
    const all = !wantsSaved && onScreen.length > asked.length && !namesSpecificListings(ctx.userText ?? '', shownListings)
    // exact: the app itself asks for these listings (a comparison the model described but never ran).
    const refs = (wantsSaved ? ctx.state.saved : args.exact ? asked : all || asked.length === 0 ? onScreen : asked).slice(0, MAX_COMPARE)
    const found: CatalogListing[] = []
    for (const r of refs) {
      const { listing } = await liveRef(ctx, r)
      if (listing && !found.some((x) => x.id === listing.id)) found.push(listing)
    }
    if (found.length < 2) return { error: wantsSaved ? 'The client has fewer than two saved listings.' : 'Need at least two existing listings to compare.' }
    const fits = scoreListings(found, ctx.s, ctx.profile, deriveTrack(ctx.profile))
    found.forEach((l) => refOf(ctx.state, l.id))
    // The competitors around each place, once per listing for the whole chat: a comparison quotes the same counts
    // as an earlier location analysis.
    await ctx.progress('competition')
    const todo = found.filter((l) => !ctx.state.places[l.id])
    const briefs = await Promise.all(todo.map((l) => competitionBrief(l, ctx.locale).catch(() => null)))
    todo.forEach((l, i) => {
      const b = briefs[i] as { radius_m?: number | null; precision?: string; direct_competitors?: { within_150m: number; within_radius: number } | null; nearest?: string[] } | null
      if (b?.direct_competitors && b.radius_m) rememberPlace(ctx.state, l.id, { radiusM: b.radius_m, direct: b.direct_competitors.within_radius, within150m: b.direct_competitors.within_150m, nearest: (b.nearest ?? []).slice(0, 3), precision: b.precision ?? 'street' })
    })
    // A listing compared for the first time (a pasted link) also gets its card, for Open, Save and Compare; the ones
    // already in the chat are only in the table.
    ctx.out.cards = newCards(ctx, found.map((l) => card(ctx, l)))
    ctx.out.compare = compareTable(found, ctx.s, ctx.state, ctx.locale, (l) => listingUrl(l, ctx.locale), budgetOf(ctx))
    ctx.state.lastShown = found.map((l) => l.id)
    for (const l of found) markTopic(ctx.state, l.id, 'compare')
    return {
      listings: found.map((l) => ({
        ...sheet(ctx, l),
        fit: fits.get(l.id) ? { score: fits.get(l.id)!.score, reasons: fits.get(l.id)!.reasons } : undefined,
        seller_text: sellerText(l, 1200),
      })),
      note: 'The comparison table with these numbers is on screen under your text. Write: the verdict first (which one and why), then one short block per listing (price, rent, area, + / −, a score out of 10), then what to verify. Use only these numbers.',
    }
  },

  async market_stats(args, ctx) {
    await ctx.progress('market', ctx.s.listings.length)
    const cats = categoryArgs(args.categories, (c) => ctx.s.categories.includes(c))
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
    if (!at) return { error: listing ? 'The listing has no usable location. Ask the client for the street or address.' : 'Give a listing or an address to analyse.' }
    const type = categoryArgs([args.business_type], (c) => knownCategoryKeys.includes(c))[0] ?? (listing && !['commercial_space', 'real_estate', 'offices', 'warehouse', 'land'].includes(listing.category) ? listing.category : null)
    const { facts, sources } = await analyzeArea({ at, listing, businessType: type, s: ctx.s, locale: ctx.locale, sessionId: ctx.sessionId })
    if (sources.length) ctx.out.sources = sources
    if (listing) {
      focus(ctx, listing)
      markTopic(ctx.state, listing.id, 'location')
      const c = (facts.map as { competition?: { radius_m: number; direct_competitors: { within_150m: number; within_radius: number }; nearest_direct: { name: string; distance_m: number }[] } | null } | undefined)?.competition
      if (c && type === listing.category) {
        rememberPlace(ctx.state, listing.id, { radiusM: c.radius_m, direct: c.direct_competitors.within_radius, within150m: c.direct_competitors.within_150m, nearest: c.nearest_direct.slice(0, 3).map((n) => `${n.name} (${n.distance_m} m)`), precision: at.precision })
      }
    }
    return {
      listing: listing && sheet(ctx, listing),
      ...facts,
      note: 'Layout: where it is → what is around → competitors with distances → verdict → what to check on site. Quote the competitor count from the fact sheet\'s "map" line (one count, one radius). Map counts are a minimum (small or new places can be missing).',
    }
  },

  async profit_scenarios(args, ctx) {
    let listing: CatalogListing | undefined
    if (typeof args.ref === 'string' && args.ref.trim()) {
      const found = await liveRef(ctx, args.ref)
      listing = found.listing
    }
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
    const three = (v: unknown) => (Array.isArray(v) ? v.map(n).filter((x): x is number => x !== null).slice(0, 3) : [])
    const price = n(args.price_gel) ?? listing?.priceGel ?? null
    if (!price) return { error: 'Need the price (price_gel or a listing with a price).' }
    const extra = n(args.extra_investment_gel) ?? 0
    const days = n(args.open_days_per_month) || 30
    let revenue = three(args.revenue_monthly_gel)
    const customers = three(args.customers_per_day)
    const check = n(args.average_check_gel)
    if (revenue.length < 3 && customers.length === 3 && check) revenue = customers.map((c) => c * check * days)
    if (revenue.length !== 3) return { error: 'Give three monthly revenues (revenue_monthly_gel) or three customers_per_day with average_check_gel.' }
    revenue = [...revenue].sort((a, b) => a - b)
    const stated = listing?.insights?.premises.rent_monthly
    const statedRent = stated ? ((stated.min + stated.max) / 2) * (ctx.s.rates[stated.currency] ?? 1) : null
    const rent = n(args.rent_monthly_gel) ?? statedRent ?? 0
    // No cost of goods for a business that sells food or goods would overstate its profit many times over (round 6: a
    // café "earning" 58 000 ₾ a month, paid back in "0 months"): the type's usual share is used and says so.
    const typicalCogs = listing ? TYPICAL_COGS_PCT[listing.category] : undefined
    const cogsGiven = n(args.cost_of_goods_pct)
    const cogsPct = cogsGiven ?? typicalCogs ?? 0
    const taxPct = n(args.tax_pct_of_revenue) ?? 1
    // Every table has the whole cost template (production test, 29 Oct: a bakery with only cost of goods, rent and tax
    // showed a 52 % margin). A line the model leaves out gets the usual figure for this type and size, marked typical:
    // staff from the seller's count (when believable) or the floor area, a manager when the buyer wants passive income,
    // utilities by area, a fixed sum for accounting and the rest. A business is assumed; property has no such lines.
    const business = !listing || !PROPERTY_TYPES.includes(listing.category)
    const typical = business ? typicalCosts(listing, val(ctx.profile, 'goal') === 'passive_income' || val(ctx.profile, 'involvement') === 'hands_off') : { staff: 0, manager: 0, utilities: 0, other: 0 }
    const given = { staff: n(args.staff_monthly_gel), owner: n(args.owner_salary_monthly_gel), utilities: n(args.utilities_monthly_gel), other: n(args.other_monthly_gel) }
    const fixedCosts = {
      rent: Math.round(rent),
      staff: Math.round(given.staff ?? typical.staff),
      owner_salary: Math.round(given.owner ?? typical.manager),
      utilities: Math.round(given.utilities ?? typical.utilities),
      other: Math.round(given.other ?? typical.other),
    }
    const typicalLines = new Set([...(given.staff === null && typical.staff ? ['staff'] : []), ...(given.owner === null && typical.manager ? ['owner_salary'] : []), ...(given.utilities === null && typical.utilities ? ['utilities'] : []), ...(given.other === null && typical.other ? ['other'] : [])])
    const layout = { typical: typicalLines, manager: given.owner === null && typical.manager > 0, ownerWorks: business && !fixedCosts.owner_salary, rentUnknown: business && !fixedCosts.rent && listing?.insights?.premises.tenure !== 'owned' }
    const fixedTotal = Object.values(fixedCosts).reduce((a, b) => a + b, 0)
    const total = price + extra
    const names = ['cautious', 'realistic', 'optimistic'] as const
    const scenarios = revenue.map((rev, i) => {
      const cogs = Math.round((rev * cogsPct) / 100)
      const tax = Math.round((rev * taxPct) / 100)
      const profit = Math.round(rev - cogs - tax - fixedTotal)
      // Judged before rounding: 5.5 months is under six even though it reads "6" when rounded (final test, T3).
      const exact = profit > 0 ? total / profit : null
      const payback = exact === null ? null : paybackMonths(exact)
      return { scenario: names[i]!, revenue_monthly_gel: Math.round(rev), cost_of_goods_gel: cogs, tax_gel: tax, fixed_costs_gel: fixedTotal, net_profit_monthly_gel: profit, payback_months: payback, payback_fast: exact !== null && exact < 6, yearly_return_pct: profit > 0 ? Math.round(((profit * 12) / total) * 100) : null }
    })
    const warnings: string[] = []
    if (scenarios.some((x) => x.payback_fast)) warnings.push('Payback under 6 months is unusually fast for a business: say so plainly and tell the client to verify the revenue with bank statements and receipts before trusting it.')
    if (scenarios.some((x) => x.net_profit_monthly_gel <= 0)) warnings.push('At least one scenario loses money: say which.')
    if (!fixedCosts.staff && !fixedCosts.owner_salary) warnings.push('No staff or owner salary in the costs: the profit only holds if the owner works for free — say so, or recompute with staff.')
    if (typicalLines.size) warnings.push(`Usual figures were used for ${[...typicalLines].join(', ')} (the table marks them): say they are assumptions, and ask the seller for the real costs.`)
    if (layout.ownerWorks) warnings.push("No owner or manager salary: the profit includes the buyer's own work — say so.")
    if (layout.rentUnknown) warnings.push('The rent is not known and not in the costs: say the profit is before rent until the seller states it.')
    if (!cogsPct) warnings.push('No cost of goods given: profit is overstated for any business that sells goods or food.')
    else if (cogsGiven === null) warnings.push(`No cost of goods given: the usual ${cogsPct}% for this type was used — say it is an assumption.`)
    ctx.out.compare = profitTable(scenarios, fixedCosts, cogsPct, taxPct, total, ctx.locale, { ...layout, cogsTypical: cogsGiven === null && cogsPct > 0 })
    if (listing) markTopic(ctx.state, listing.id, 'profit')
    return {
      listing: listing && sheet(ctx, listing),
      investment_gel: { price, extra, total },
      same_cost_lines_in_every_scenario: { cost_of_goods_pct: cogsPct, cost_of_goods_source: cogsGiven !== null ? 'your assumption' : cogsPct ? 'usual for this type' : 'not given', tax_pct_of_revenue: taxPct, ...fixedCosts, usual_figures_used_for: [...typicalLines], owner_salary_is: layout.manager ? 'a manager (the buyer wants passive income)' : 'the owner', rent_source: n(args.rent_monthly_gel) !== null ? 'your assumption' : statedRent ? 'the listing (seller says)' : 'not given' },
      scenarios,
      warnings,
      note: 'The scenario table is on screen. Explain these numbers; do not recompute or change them. Label the revenue as your estimate and the rent by its source.',
    }
  },

  async calculate(args) {
    const price = Number(args.price_gel)
    const extra = Number(args.extra_gel ?? 0) || 0
    const salary = Number(args.owner_salary_monthly_gel ?? 0) || 0
    const total = price + extra
    const profit = Number(args.profit_monthly_gel ?? 0) || 0
    const rent = Number(args.rent_monthly_gel ?? 0) || 0
    const monthly = (profit || rent) - salary
    if (!(price > 0)) return { error: 'price_gel must be positive' }
    if (monthly <= 0) return { error: 'Need profit_monthly_gel or rent_monthly_gel (positive, after the owner salary). For a business without stated profit, use profit_scenarios.' }
    const pm = (m: number) => ({ payback_months: Math.round(total / m), payback_years: Math.round((total / (m * 12)) * 10) / 10, annual_return_pct: Math.round(((m * 12) / total) * 100) })
    const result = pm(monthly)
    return {
      inputs: { price_gel: price, extra_investment_gel: extra, total_investment_gel: total, monthly_income_gel: monthly, owner_salary_deducted_gel: salary },
      result,
      if_income_20pct_lower: pm(monthly * 0.8),
      if_income_20pct_higher: pm(monthly * 1.2),
      warning: total / monthly < 6 ? 'Payback under 6 months is unusually fast: tell the client to verify the income with documents.' : undefined,
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
    // The amount in the client's own currency ("$150 000") is kept as said and converted for the search; the strip
    // shows it as said, with the lari as a rounded hint (round 7: "150 000$" became "≤ 389 355 ₾").
    const amount = typeof args.budget_amount === 'number' && args.budget_amount > 0 ? args.budget_amount : null
    const currency = typeof args.budget_currency === 'string' && /^(GEL|USD|EUR)$/i.test(args.budget_currency) ? args.budget_currency.toUpperCase() : 'GEL'
    const asSaid = amount !== null ? toGel(amount, currency, ctx.s.rates) : null
    if (asSaid && asSaid >= 500) {
      patch.budgetGel = Math.round(asSaid)
      if (currency !== 'GEL') patch.budgetOriginal = { amount, currency }
    } else if (typeof args.budget_gel === 'number' && args.budget_gel >= 500) {
      // Never let a listing price slip in as the budget: it must not equal a shown price.
      const shownPrices = ctx.state.lastShown.map((id) => ctx.s.byId.get(id)?.priceGel ?? -1)
      if (!shownPrices.some((p) => Math.abs(p - Number(args.budget_gel)) < 1)) patch.budgetGel = Math.round(args.budget_gel)
    }
    if (enumOk(args.goal, GOALS)) patch.goal = args.goal
    if (enumOk(args.involvement, INVOLVEMENT)) patch.involvement = args.involvement
    if (enumOk(args.experience, EXPERIENCE)) patch.experience = args.experience
    if (enumOk(args.risk, RISK)) patch.risk = args.risk
    if (enumOk(args.capital_share, ['all', 'part'] as const)) patch.capitalShare = args.capital_share
    if (enumOk(args.asset_openness, ['business_only', 'open_to_property'] as const)) patch.assetOpenness = args.asset_openness
    if (Array.isArray(args.sectors)) patch.sectors = categoryArgs(args.sectors, (c) => ctx.s.categories.includes(c) || PROPERTY.includes(c))
    if (Array.isArray(args.experience_sectors)) patch.experienceSectors = categoryArgs(args.experience_sectors, (c) => knownCategoryKeys.includes(c))
    if (Array.isArray(args.cities)) {
      const cities = args.cities.map((c) => normalizeCity(String(c), ctx.s.cities)).filter((c): c is string => c !== null)
      if (cities.length) {
        patch.cities = cities
        patch.locationFlexible = false
      }
    }
    if (args.location_flexible === true) patch.locationFlexible = true
    if (typeof args.interest === 'string' && args.interest.trim().length > 2) patch.interest = args.interest.trim().slice(0, 200)
    const before = ctx.profile
    if (Object.keys(patch).length) ctx.profile = applyPatch(ctx.profile, patch, ctx.turn).profile
    // A fact that changed (not just stated for the first time) is confirmed in one line of the reply.
    const changed = Object.keys(patch).filter((k) => {
      const prev = before[k as keyof Profile]?.value
      return prev !== undefined && JSON.stringify(prev) !== JSON.stringify(patch[k])
    })
    return {
      profile: profileFacts(ctx.profile),
      changed: changed.length ? changed : undefined,
      note: changed.length ? 'Say the change in one line ("OK, budget is now 100 000 ₾."), then continue.' : undefined,
      ready_for_recommendations: has(ctx.profile, 'budgetGel') && (has(ctx.profile, 'goal') || has(ctx.profile, 'involvement')),
    }
  },

  async suggest_replies(args, ctx) {
    const options = ((args.options as string[] | undefined) ?? []).map((o) => String(o).trim()).filter((o) => o && o.length <= 60).slice(0, 3)
    ctx.out.quickReplies = options.map((o, i) => ({ kind: 'message', id: `ai:${i}`, label: o, text: o }))
    return { shown: options.length, note: 'The buttons appear under your reply. If you have not written the reply text yet, write it now.' }
  },

  async show_form(_args, ctx) {
    // A business type named in the message ("რესტორანი მინდა") is known: kept in the profile and pre-selected.
    const named = has(ctx.profile, 'sectors') ? [] : categoriesNamed(ctx.userText ?? '')
    if (named.length) ctx.profile = applyPatch(ctx.profile, { sectors: named }, ctx.turn).profile
    const missing = missingKeyFacts(ctx.profile)
    if (!formWanted(ctx.profile)) {
      return { error: `Do not show the form: only ${missing.length ? missing.join(' and ') : 'nothing'} is unknown and the client named what they want. ${missing.length ? 'Search now, and ask about the most important missing fact in one short question at the end.' : 'Search now.'}` }
    }
    ctx.out.formRequested = true
    return { shown: true, note: 'The form appears under your reply with what the client already said pre-selected. Write one short sentence before it; do not list its questions.' }
  },

  async seller_message(args, ctx) {
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    // Models name the field "message", "text" or "body"; any of them is the message.
    // "#3" means nothing to the seller (production test: "დაინტერესებული ვარ #3 საცხობის ბიზნესით"): the chat's numbers,
    // with any ending ("#3-ის"), are taken out; the listing page the message is sent from says which listing it is.
    const raw = String(args.message ?? args.text ?? args.body ?? args.content ?? '').trim().slice(0, 1500)
    const text = raw.replace(/\s?#\d{1,3}(?!\d)(?:-\p{L}+)?/gu, '').replace(/ {2,}/g, ' ').replace(/ ([,.!?])/g, '$1').trim()
    if (text.length < 20) return { error: 'Write the whole message in "message".' }
    ctx.out.handoff = { listingId: l.id, n: refOf(ctx.state, l.id), name: shortName(l, ctx.locale), url: listingUrl(l, ctx.locale), text }
    focus(ctx, l)
    markTopic(ctx.state, l.id, 'seller')
    return { shown: true, note: 'The message is on screen with Copy and Open listing buttons (the seller is contacted from the listing page). In your text say in one line that it is ready and what to ask first; do not repeat the message.' }
  },

  async visit_checklist(args, ctx) {
    const { listing: l, error } = await liveRef(ctx, String(args.ref ?? ''))
    if (!l) return { error }
    const items = ((args.items as unknown[] | undefined) ?? []).map((x) => String(x).trim()).filter((x) => x.length > 2 && x.length <= 200).slice(0, 12)
    if (items.length < 3) return { error: 'Give 6 to 10 items.' }
    ctx.out.checklist = { listingId: l.id, n: refOf(ctx.state, l.id), name: shortName(l, ctx.locale), items }
    focus(ctx, l)
    markTopic(ctx.state, l.id, 'visit')
    return { shown: true, note: 'The tickable checklist is on screen and stays with the listing. Nothing is scheduled: say the checklist is ready, never that a visit is planned. Do not repeat the items; add only what matters most.' }
  },

  async create_alert(args, ctx) {
    if (!ctx.userId) return { error: 'Alerts need a signed-in client.' }
    // Types the model named but that match no key fall back to the profile: an alert for every type is never meant.
    const named = categoryArgs(args.categories, (c) => knownCategoryKeys.includes(c))
    const categories = named.length || (Array.isArray(args.categories) && !args.categories.length) ? named : (val(ctx.profile, 'sectors') ?? []).filter((c) => knownCategoryKeys.includes(c))
    const cities = ((args.cities as string[] | undefined) ?? val(ctx.profile, 'cities') ?? []).map((c) => normalizeCity(String(c), ctx.s.cities)).filter((c): c is string => c !== null)
    const maxPriceGel = typeof args.max_price_gel === 'number' && args.max_price_gel > 0 ? Math.round(args.max_price_gel) : (val(ctx.profile, 'budgetGel') ?? null)
    const label =
      typeof args.label === 'string' && args.label.trim()
        ? args.label.trim()
        : [categories.map((c) => categoryLabel(c, ctx.locale)).join(', '), cities.map((c) => cityLabel(c, ctx.locale)).join(', '), maxPriceGel ? `≤ ${maxPriceGel} ₾` : ''].filter(Boolean).join(' · ')
    try {
      const a = await alerts.create(ctx.userId, label, { categories, cities, maxPriceGel })
      ctx.out.alert = { id: a.id, label: a.label }
      return { saved: true, label: a.label, note: 'Say how it works, in one or two lines: when a matching listing is added, a notice appears at the top of this chat, which they see when they open it; nothing comes by email or phone. They can remove the alert from the memory strip.' }
    } catch {
      return { error: 'Alerts are not available right now; suggest checking back later.' }
    }
  },
}

const MAX_COMPARE = 4

// The message to the seller when the model talked about it but never produced one: the analysis' own draft (the
// listing's open questions), so the buyer always gets the card with Copy and Open listing.
export function fallbackHandoff(ctx: ToolContext, l: CatalogListing): void {
  const { analysis } = analyzeListing({ listing: l, snapshot: ctx.s, profile: ctx.profile, track: deriveTrack(ctx.profile), locale: ctx.locale, aspect: 'seller_questions' })
  const draft = analysis.questions?.draft
  if (!draft) return
  ctx.out.handoff = { listingId: l.id, n: refOf(ctx.state, l.id), name: shortName(l, ctx.locale), url: listingUrl(l, ctx.locale), text: draft }
  markTopic(ctx.state, l.id, 'seller')
}

// The budget a client states in a message ("50 ათასი მაქვს", "30 ათასამდე", "5 000 ლარად", "до 30 000"), in GEL, so
// the form and the search use it even when the model forgets to call update_profile.
export function statedBudget(text: string, rates: FxRates): number | null {
  return statedMoney(text, rates)?.gel ?? null
}

// The same, with the amount and currency as the client wrote them.
export function statedMoney(text: string, rates: FxRates): { gel: number; amount: number; currency: string } | null {
  const amounts = extractAmounts(text)
  const forAmount = /ლარად|დოლარად|ევროდ|\$-?ად/.test(text)
  const a = amounts.find((x) => x.role === 'budget') ?? (forAmount ? amounts.find((x) => x.role === 'unknown') : undefined)
  if (!a) return null
  const amount = a.max ?? a.value
  const gel = toGel(amount, a.currency, rates)
  return gel && gel >= 500 ? { gel: Math.round(gel), amount, currency: (a.currency ?? 'GEL').toUpperCase() } : null
}

// The patch for a budget the client stated: in GEL for the search, and as said when it was another currency.
export function budgetPatch(money: { gel: number; amount: number; currency: string }): Partial<Record<'budgetGel' | 'budgetOriginal', unknown>> {
  return money.currency === 'GEL' ? { budgetGel: money.gel } : { budgetGel: money.gel, budgetOriginal: { amount: money.amount, currency: money.currency } }
}

// Months to pay back, as shown: one decimal under ten months ("5.5"), whole months from there; never below 0.1.
export const paybackMonths = (exact: number) => (exact < 10 ? Math.max(0.1, Math.round(exact * 10) / 10) : Math.round(exact))

// The three profit scenarios as a table under the answer: the same cost lines in every column.
function profitTable(
  scenarios: { scenario: string; revenue_monthly_gel: number; cost_of_goods_gel: number; tax_gel: number; net_profit_monthly_gel: number; payback_months: number | null; payback_fast: boolean; yearly_return_pct: number | null }[],
  fixed: Record<string, number>,
  cogsPct: number,
  taxPct: number,
  total: number,
  locale: Locale,
  layout: { cogsTypical: boolean; typical: Set<string>; manager: boolean; ownerWorks: boolean; rentUnknown: boolean },
): CompareTable {
  const t = (ka: string, en: string, ru: string) => pick({ ka, en, ru }, locale)
  const gel = (x: number) => formatGel(x, locale)
  const names = { cautious: t('ფრთხილი', 'Cautious', 'Осторожный'), realistic: t('რეალისტური', 'Realistic', 'Реалистичный'), optimistic: t('ოპტიმისტური', 'Optimistic', 'Оптимистичный') } as Record<string, string>
  const months = t('თვე', 'months', 'мес.')
  const fast = t('უჩვეულოდ სწრაფია, გადაამოწმეთ შემოსავალი', 'unusually fast, verify the revenue', 'подозрительно быстро, проверьте выручку')
  const usual = t('ტიპური', 'typical', 'типично')
  const fixedRow = (key: string, label: string) => (fixed[key] ? [{ key, label: layout.typical.has(key) ? `${label} (${usual})` : label, values: scenarios.map(() => `−${gel(fixed[key]!)}`) }] : [])
  // A line that is not in the costs is still shown, so its absence is seen: unknown rent, the owner's own work.
  const absentRow = (key: string, label: string) => [{ key, label, values: scenarios.map(() => '—') }]
  return {
    kind: 'profit',
    title: t('მოგების სცენარები (თვეში, შეფასება)', 'Profit scenarios (per month, estimate)', 'Сценарии прибыли (в месяц, оценка)'),
    columns: scenarios.map((s) => s.scenario),
    heads: scenarios.map((s) => ({ id: s.scenario, name: names[s.scenario] ?? s.scenario })),
    rows: [
      { key: 'revenue', label: t('შემოსავალი', 'Revenue', 'Выручка'), values: scenarios.map((s) => gel(s.revenue_monthly_gel)) },
      ...(cogsPct ? [{ key: 'cogs', label: layout.cogsTypical ? t(`პროდუქციის ღირებულება (${cogsPct}%, ტიპური)`, `Cost of goods (${cogsPct}%, typical)`, `Себестоимость (${cogsPct}%, типично)`) : t(`პროდუქციის ღირებულება (${cogsPct}%)`, `Cost of goods (${cogsPct}%)`, `Себестоимость (${cogsPct}%)`), values: scenarios.map((s) => `−${gel(s.cost_of_goods_gel)}`) }] : []),
      ...(layout.rentUnknown ? absentRow('rent', t('ქირა (არ არის მითითებული)', 'Rent (not stated)', 'Аренда (не указана)')) : fixedRow('rent', t('ქირა', 'Rent', 'Аренда'))),
      ...fixedRow('staff', t('პერსონალი', 'Staff', 'Персонал')),
      ...(layout.ownerWorks
        ? absentRow('owner_salary', t('მფლობელის ხელფასი (თქვენი შრომა, არ ითვლება)', 'Owner salary (your own work, not counted)', 'Зарплата владельца (ваш труд, не учтён)'))
        : fixedRow('owner_salary', layout.manager ? t('მენეჯერის ხელფასი', 'Manager salary', 'Зарплата управляющего') : t('მფლობელის ხელფასი', 'Owner salary', 'Зарплата владельца'))),
      ...fixedRow('utilities', t('კომუნალურები', 'Utilities', 'Коммунальные')),
      ...fixedRow('other', t('სხვა ხარჯები', 'Other costs', 'Прочие расходы')),
      { key: 'tax', label: t(`გადასახადი (${taxPct}%)`, `Tax (${taxPct}%)`, `Налог (${taxPct}%)`), values: scenarios.map((s) => `−${gel(s.tax_gel)}`) },
      { key: 'profit', label: t('წმინდა მოგება', 'Net profit', 'Чистая прибыль'), values: scenarios.map((s) => gel(s.net_profit_monthly_gel)) },
      // Under 6 months is unusually fast for a business: said in the table itself, so no answer can skip it.
      { key: 'payback', label: t(`ანაზღაურება (${gel(total)})`, `Payback (${gel(total)})`, `Окупаемость (${gel(total)})`), values: scenarios.map((s) => (s.payback_months === null ? '—' : `${decimal(s.payback_months, locale)} ${months}${s.payback_fast ? ` — ${fast}` : ''}`)) },
    ],
  }
}

// Does the client's message point at particular listings ("the first two", "#2 and #3", a title, a link, "both")?
// Then a comparison covers only those; otherwise it covers everything on screen.
export function namesSpecificListings(text: string, shown: CatalogListing[]): boolean {
  const t = text.toLowerCase()
  if (/#\s?\d|\b[0-9a-f]{8}\b|mybusiness\.ge/.test(t)) return true
  // Word edges that work for Georgian and Cyrillic too (\b only knows Latin letters).
  if (/პირველ|მეორე|მესამე|მეოთხე|ბოლო|ორივე|(?<!\p{L})ამ\s+ორ|(?<!\p{L})ორ\s+(?:ვარიანტ|განცხადებ|ბიზნეს)|(?<!\p{L})(?:first|second|third|fourth|last|both|these two|the two|two of)(?!\p{L})|перв|втор|трет|четв|последн|(?<!\p{L})(?:оба|обе|два|две|двух)(?!\p{L})/u.test(t)) return true
  const generic = /^(იყიდება|ბიზნესი|ბიზნესის|მოქმედი|თბილისში|ბათუმში|business|for|sale|продажа|бизнес|продается)$/
  return shown.some((l) =>
    [l.title.ka, l.title.en, l.title.ru]
      .filter(Boolean)
      .flatMap((title) => title!.toLowerCase().split(/[^\p{L}\d]+/u))
      .some((w) => w.length >= 5 && !generic.test(w) && t.includes(w)),
  )
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

// The client's intake-form answers → profile values, applied without a model call.
export function applyFormAnswers(profile: Profile, answers: { field: string; value: string }[], cities: string[], categories: string[], turn: number): Profile {
  const patch: Record<string, unknown> = {}
  for (const a of answers) {
    const v = a.value.trim()
    switch (a.field) {
      case 'budget': {
        const n = Number(v.replace(/[^\d.]/g, ''))
        // The pre-selected bucket keeps a stated budget inside it (50 000 stays 50 000, not 80 000).
        const stated = val(profile, 'budgetGel')
        if (n >= 500) patch.budgetGel = stated && stated > bucketFloor(n) && stated <= n ? stated : Math.round(n)
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
        else if (v !== 'other') {
          const c = normalizeCity(v, cities)
          if (c) {
            patch.cities = [c]
            patch.locationFlexible = false
          }
        }
        break
      }
      case 'sector': {
        if (v === 'any') patch.sectors = []
        else if (v !== 'other') {
          const keys = v.split(',').filter((k) => categories.includes(k) || PROPERTY.includes(k))
          if (keys.length) patch.sectors = keys
        }
        break
      }
    }
  }
  return Object.keys(patch).length ? applyPatch(profile, patch, turn).profile : profile
}

export { profileFacts }
