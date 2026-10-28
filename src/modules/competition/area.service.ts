import { env } from '../../pkg/env/env.js'
import { pick, type Locale } from '../../shared/i18n/locale.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { ai } from '../ai/ai.gateway.js'
import { categoryLabel, cityLabel, districtLabel } from '../catalog/catalog.labels.js'
import type { CatalogListing } from '../catalog/catalog.model.js'
import type { CatalogSnapshot } from '../catalog/catalog.service.js'
import { competitionConfig } from './competition.config.js'
import { marketSupply } from './competition.service.js'
import { AREA_GROUPS, COMPETITORS, NOT_ACTIVITY, SPACE_USES, matches } from './area.config.js'
import { isCommercialSpace, rentBenchmark } from './location.service.js'
import { mapAround, type MapPlace } from './map.client.js'
import { distanceM, geocode } from './nominatim.client.js'

// Everything about a place that matters for a business there: where exactly it is, the competitors around it,
// what brings customers, and what the area lacks. The map data is the same OpenStreetMap map a mybusiness.ge
// listing page shows; a Google Maps report (through Gemini) adds ratings and reviews when available.

export type Precision = 'exact' | 'street' | 'district' | 'city'
export type Located = { lat: number; lon: number; precision: Precision; label: string }

// Coordinates this close to the city centre, or rounded to 4 decimals (~10 m), are the site's default pin for
// the city or district, not a pin the seller placed on the business.
const CITY_PIN_M = 400
// A street match farther than this from the neighbourhood the seller names is the same name elsewhere in the city.
const NEIGHBOURHOOD_M = 2_500
const decimals = (x: number) => (String(x).split('.')[1] ?? '').length
const isDefaultPin = (lat: number, lon: number) => decimals(lat) <= 4 && decimals(lon) <= 4
const REPORT_TTL_MS = 7 * 86_400_000
const reports = new Map<string, { at: number; value: { text: string; sources: { title: string; url: string }[] } }>()

// Sellers sometimes write notes into the address field ("📍 : Vake, Abashidze St 56 🏢 new building"):
// keep the first part that reads like an address.
const clean = (x: string | null | undefined) =>
  (x ?? '')
    .split(/\p{Extended_Pictographic}|\n/u)
    .map((part) => part.replace(/^[\s:,-]+|[\s:,-]+$/g, ''))
    .find((part) => /\p{L}{3,}/u.test(part))
    ?.slice(0, 120) ?? ''

// Tbilisi and Batumi neighbourhoods as sellers write them ("ვაკეში", "საბურთალოზე", "in Saburtalo"):
// stem → the name a map search understands.
const NEIGHBOURHOODS: [RegExp, string][] = [
  [/ვაკ[ეი]|\bvake\b|ваке/i, 'Vake'],
  [/საბურთალ|saburtalo|сабуртало/i, 'Saburtalo'],
  [/ისან[იში]|\bisani\b|исани/i, 'Isani'],
  [/დიდუბ|didube|дидубе/i, 'Didube'],
  [/ნაძალადევ|nadzaladevi|надзаладеви/i, 'Nadzaladevi'],
  [/გლდან|gldani|глдани/i, 'Gldani'],
  [/ჩუღურეთ|chughureti|чугурети/i, 'Chughureti'],
  [/მთაწმინდ|mtatsminda|мтацминда/i, 'Mtatsminda'],
  [/კრწანის|krtsanisi|крцаниси/i, 'Krtsanisi'],
  [/სამგორ|samgori|самгори/i, 'Samgori'],
  [/დიღომ|dighomi|дигоми/i, 'Dighomi'],
  [/ვარკეთილ|varketili|варкетили/i, 'Varketili'],
  [/ვაზისუბ|vazisubani|вазисубани/i, 'Vazisubani'],
  [/ორთაჭალ|ortachala|ортачала/i, 'Ortachala'],
  [/ავლაბარ|avlabari|авлабари/i, 'Avlabari'],
  [/სოლოლაკ|sololaki|сололаки/i, 'Sololaki'],
  [/მარჯანიშვილ|marjanishvili|марджанишвили/i, 'Marjanishvili'],
  [/დელის|delisi|делиси/i, 'Delisi'],
  [/ბაგებ|bagebi|багеби/i, 'Bagebi'],
  [/ლილო|lilo\b|лило/i, 'Lilo'],
]

// Streets and neighbourhoods the seller writes in the title or description, most precise first:
// "ჭავჭავაძის 16", "ბერძენიშვილის ქუჩა", "Chavchavadze Ave 37", "ул. Абашидзе 56", then "ვაკეში".
export function placeHints(text: string): { streets: string[]; neighbourhood: string | null } {
  const streets = new Set<string>()
  const patterns = [
    /([ა-ჰ]{3,}(?:ის)?\s+(?:ქუჩა|ქ\.|გამზირი|გამზ\.|ჩიხი|შესახვევი|მოედანი|აღმართი|სანაპირო)(?:\s*(?:N|№)?\s*\d{1,4}[ა-ჰa-z]?)?)/g,
    /([ა-ჰ]{3,}ის)\s+(?:N|№)?\s*(\d{1,4}[ა-ჰa-z]?)\b/g,
    /([A-Z][a-z]{3,}(?:\s+[A-Z][a-z]+)?\s+(?:Street|St\.?|Avenue|Ave\.?|Square)(?:\s+\d{1,4})?)/g,
    /((?:ул\.|улица|пр\.|проспект)\s+[А-ЯЁ][а-яё]+(?:\s+\d{1,4})?)/g,
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) streets.add(m[2] ? `${m[1]} ${m[2]}` : m[1]!)
  const neighbourhood = NEIGHBOURHOODS.find(([re]) => re.test(text))?.[1] ?? null
  return { streets: [...streets].slice(0, 3), neighbourhood }
}

// The most precise place we can get for a listing: real coordinates, then the written address, then a place
// named in the title or description (or a hint from the model), then the district, then the city.
export async function locateListing(l: CatalogListing, hint?: string): Promise<Located | null> {
  const city = l.city ? cityLabel(l.city, 'en') : null
  const cityCentre = city ? await geocode(`${city}, Georgia`) : null
  const label = [clean(l.address), l.district ? districtLabel(l.district, 'ka') : '', l.city ? cityLabel(l.city, 'ka') : ''].filter(Boolean).join(', ')

  if (l.latitude !== null && l.longitude !== null) {
    const nearCentre = cityCentre && distanceM(l.latitude, l.longitude, cityCentre.lat, cityCentre.lon) < CITY_PIN_M
    if (!nearCentre && !isDefaultPin(l.latitude, l.longitude)) return { lat: l.latitude, lon: l.longitude, precision: 'exact', label }
  }
  const address = clean(l.address)
  const cityWords = [city, l.city ? cityLabel(l.city, 'ka') : null].filter(Boolean) as string[]
  const tries: [string, Precision][] = []
  if (address && !cityWords.some((c) => address.toLowerCase() === c.toLowerCase())) tries.push([address, 'street'])
  if (hint?.trim()) tries.push([hint.trim(), 'street'])
  // Many sellers leave the address field as just the city and write the street in the title ("ვაკეში, ჭავჭავაძის 16").
  const text = `${pick(l.title, 'ka')} ${l.title.en ?? ''} ${l.description.original} ${l.description.en ?? ''}`
  const found = placeHints(text)
  const area = l.district ? districtLabel(l.district, 'en') : found.neighbourhood
  // A street name can exist in several neighbourhoods (two Chavchavadze streets in Tbilisi): search it within the
  // neighbourhood the seller names, and reject a match far from that neighbourhood.
  const areaCentre = area ? await geocode([area, city, 'Georgia'].filter(Boolean).join(', ')) : null
  for (const street of found.streets) tries.push([area ? `${street}, ${area}` : street, 'street'])
  if (area) tries.push([area, 'district'])
  for (const [q, precision] of tries) {
    const p = await geocode([q, city, 'Georgia'].filter(Boolean).join(', '))
    if (!p) continue
    if (precision === 'street' && areaCentre && distanceM(p.lat, p.lon, areaCentre.lat, areaCentre.lon) > NEIGHBOURHOOD_M) continue
    return { ...p, precision, label: [q, l.city ? cityLabel(l.city, 'ka') : ''].filter(Boolean).join(', ') }
  }
  // A default pin still beats nothing: it is the district's (or the city's) own centre.
  if (l.latitude !== null && l.longitude !== null) return { lat: l.latitude, lon: l.longitude, precision: l.district ? 'district' : 'city', label }
  return cityCentre ? { ...cityCentre, precision: 'city', label: l.city ? cityLabel(l.city, 'ka') : '' } : null
}

// A written address or place name ("Chavchavadze Ave 37, Tbilisi").
export async function locateAddress(address: string, city?: string | null): Promise<Located | null> {
  const p = await geocode([address, city ? cityLabel(city, 'en') : null, 'Georgia'].filter(Boolean).join(', '))
  return p ? { ...p, precision: 'street', label: address } : null
}

function mapsPrompt(at: Located, businessType: string | null, forSpace: boolean): string {
  const type = businessType ? categoryLabel(businessType, 'en') : null
  const cfg = businessType ? competitionConfig(businessType) : null
  const radius = cfg?.radiusM ?? 500
  return [
    `You are researching a location in Georgia for someone thinking of buying or opening a business there. Point: ${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}${at.label ? ` (${at.label})` : ''}.`,
    type
      ? `1. Direct competitors for a ${type} within about ${radius} m: how many there are, and the nearest ones with name, approximate distance, Google rating and number of reviews. Say which look strongest.`
      : '1. The businesses directly around the point and how many of each kind.',
    '2. What brings people here: offices, schools and universities, metro and bus stops, hotels and sights, malls and markets, residential blocks, parking. Name the important ones with distance.',
    '3. Who passes by or lives here (residents, office workers, students, tourists, drivers) and at what times the area is busy, as far as Maps shows.',
    forSpace
      ? '4. For a commercial space here: which everyday businesses are missing or rare nearby (cafe, bakery, pharmacy, grocery, beauty salon, clinic, fitness, office), and which are already saturated.'
      : '4. Everyday business types that are missing or rare nearby, and which are saturated.',
    'Facts only, with numbers and distances; say when Maps has little data. English, compact, no introduction.',
  ].join('\n')
}

async function mapsReport(at: Located, businessType: string | null, forSpace: boolean, sessionId: string) {
  if (!env.GOOGLE_MAPS_GROUNDING) return null
  const key = `${at.lat.toFixed(4)}|${at.lon.toFixed(4)}|${businessType ?? '-'}|${forSpace}`
  const hit = reports.get(key)
  if (hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.value
  try {
    const value = await ai.searchMaps(mapsPrompt(at, businessType, forSpace), at, { sessionId })
    if (value.text) reports.set(key, { at: Date.now(), value })
    return value.text ? value : null
  } catch (err) {
    logger.warn('google maps report unavailable; using the map data only', errorFields(err))
    return null
  }
}

// The map around a place, worked into facts a consultant needs: direct and related competitors (named, with
// distance), what else is there, how busy it looks and, for a space, which uses the area lacks or has too many of.
async function mapFacts(at: Located, businessType: string | null, forSpace: boolean, area: number | null, locale: Locale = 'en') {
  const cfg = businessType ? competitionConfig(businessType) : null
  const radius = Math.min(cfg?.radiusM ?? 500, 1_500)
  const map = await mapAround(at.lat, at.lon, Math.max(radius, 1_000))
  if (!map) return null
  const within = (m: number) => map.places.filter((p) => p.distanceM <= m)
  // Names in the reply's language when the map has them (Georgian answers never get "Friend's park").
  const nameOf = (p: MapPlace) => (locale === 'ka' ? p.nameKa || (/[ა-ჰ]/.test(p.name) ? p.name : '') || p.name : locale === 'en' ? p.nameEn || p.name : p.name) || p.nameEn || '(no name on the map)'
  const named = (p: MapPlace) => ({ name: nameOf(p), type: p.sub || p.cls, distance_m: p.distanceM })
  const isActivity = (p: MapPlace) => !NOT_ACTIVITY.has(p.cls) && !NOT_ACTIVITY.has(`${p.cls}/${p.sub}`)
  const near300 = within(300).filter(isActivity).length
  const near500 = within(500).filter(isActivity)
  const count = (keys: string[], list: MapPlace[]) => list.filter((p) => matches(p, keys)).length

  const rivals = businessType ? COMPETITORS[businessType] : undefined
  let competition: Record<string, unknown> | null = null
  if (rivals && rivals.direct.length) {
    const direct = map.places.filter((p) => matches(p, rivals.direct))
    const inRadius = direct.filter((p) => p.distanceM <= radius)
    const level = inRadius.length >= (cfg?.high ?? 20) ? 'high' : inRadius.length >= (cfg?.medium ?? 8) ? 'medium' : 'low'
    competition = {
      radius_m: radius,
      direct_competitors: { within_150m: direct.filter((p) => p.distanceM <= 150).length, within_radius: inRadius.length, within_1km: direct.filter((p) => p.distanceM <= 1_000).length },
      level_by_count: level,
      nearest_direct: inRadius.slice(0, 10).map(named),
      related_within_radius: count(rivals.related, within(radius)),
    }
  }

  // Each place in one group only (its first match), so the groups never add up to more than the total.
  const around: Record<string, number> = Object.fromEntries(Object.keys(AREA_GROUPS).map((g) => [g, 0]))
  for (const p of near500) {
    const group = Object.entries(AREA_GROUPS).find(([, keys]) => matches(p, keys))?.[0]
    if (group) around[group]! += 1
  }
  const uses = forSpace
    ? SPACE_USES.map((u) => {
        const c = competitionConfig(u.category)
        const r = c.radiusM ?? 500
        const n = count(COMPETITORS[u.category]!.direct, within(r))
        return { use: categoryLabel(u.category, 'en'), competitors: n, radius_m: r, level: n >= (c.high ?? 20) ? 'high' : n >= (c.medium ?? 8) ? 'medium' : 'low', space_big_enough: area === null || area >= u.minArea }
      })
    : null
  return {
    competition,
    within_500m: { all_places: near500.length, by_kind: around, street_addresses: map.addresses },
    footfall_signal: near300 >= 80 ? 'busy' : near300 >= 25 ? 'moderate' : 'quiet',
    uses_for_this_space: uses,
    data_note: 'From OpenStreetMap, the map shown on the listing page. Small shops and new places can be missing, so counts are a minimum; names and distances are reliable.',
  }
}

// Competition around a listing in a few numbers, for comparisons: nothing when only the city is known.
export async function competitionBrief(l: CatalogListing, locale: Locale = 'en'): Promise<Record<string, unknown> | null> {
  const at = await locateListing(l)
  if (!at || at.precision === 'city') return { note: 'only the city is known; competition around the exact address cannot be judged' }
  const facts = await mapFacts(at, PROPERTY_LIKE.has(l.category) ? null : l.category, isCommercialSpace(l), l.area, locale)
  if (!facts) return null
  const c = facts.competition as { radius_m?: number; direct_competitors?: unknown; level_by_count?: string; nearest_direct?: { name: string; distance_m: number }[] } | null
  return {
    location: at.label,
    precision: at.precision,
    radius_m: c?.radius_m ?? null,
    direct_competitors: c?.direct_competitors ?? null,
    level: c?.level_by_count ?? null,
    nearest: c?.nearest_direct?.slice(0, 4).map((n) => `${n.name} (${n.distance_m} m)`) ?? [],
    footfall: facts.footfall_signal,
  }
}

const PROPERTY_LIKE = new Set(['commercial_space', 'real_estate', 'offices', 'warehouse', 'land'])

export async function analyzeArea(p: {
  at: Located
  listing?: CatalogListing
  businessType: string | null
  s: CatalogSnapshot
  locale: Locale
  sessionId: string
}): Promise<{ facts: Record<string, unknown>; sources: { title: string; url: string }[] }> {
  const { at, listing: l, businessType, s } = p
  const forSpace = l ? isCommercialSpace(l) : !businessType
  const scope = businessType ? competitionConfig(businessType).scope : null
  const location = {
    described_as: at.label,
    precision: at.precision,
    precision_note: {
      exact: 'exact pin placed on the listing',
      street: 'found from the written street address or a place named in the listing; the house may be up to a few hundred metres away',
      district: 'only the district is known: this describes the district centre, not the exact street',
      city: 'only the city is known: nearby competition cannot be judged; ask for the street or address',
    }[at.precision],
  }
  const supply = l && businessType ? marketSupply(l, s, businessType) : null
  const rent = l && forSpace ? rentBenchmark(l, s) : null
  const base = {
    location,
    business_type: businessType ? categoryLabel(businessType, 'en') : null,
    how_far_competition_matters: scope,
    similar_for_sale_on_mybusiness_ge: supply && { same_city: supply.city, same_district: supply.district },
    rent_if_let_out: rent && { rent_per_m2_gel: rent.rentPerM2, monthly_rent_gel: rent.monthly, gross_yield_pct: rent.yieldPct, based_on_listings: rent.sample },
  }
  if (at.precision === 'city') return { facts: base, sources: [] }

  // The map is fast and free; the Google Maps report adds ratings, reviews and busy hours when available.
  const [map, google] = await Promise.all([mapFacts(at, businessType, forSpace, l?.area ?? null, p.locale), mapsReport(at, businessType, forSpace, p.sessionId)])
  return {
    facts: { ...base, map, google_maps_report: google?.text ?? null },
    sources: google?.sources.slice(0, 6) ?? [],
  }
}
