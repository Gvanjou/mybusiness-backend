// Where each kind of business competes, which OpenStreetMap place types count as its competitors,
// and how many nearby competitors make an area "medium" or "high" competition.

export type Scope = 'hyperlocal' | 'destination' | 'city' | 'national' | 'export' | 'property'

type Config = { scope: Scope; osm?: string[]; radiusM?: number; medium?: number; high?: number }

const food: Config = { scope: 'hyperlocal', osm: ['cafe', 'restaurant', 'fast_food'], radiusM: 500, medium: 10, high: 25 }

export const COMPETITION: Record<string, Config> = {
  restaurants: food,
  bakery: { scope: 'hyperlocal', osm: ['bakery', 'cafe'], radiusM: 500, medium: 6, high: 15 },
  bar_nightclub: { scope: 'hyperlocal', osm: ['bar', 'pub', 'nightclub'], radiusM: 700, medium: 5, high: 12 },
  pharmacy: { scope: 'hyperlocal', osm: ['pharmacy'], radiusM: 500, medium: 4, high: 10 },
  supermarket: { scope: 'hyperlocal', osm: ['supermarket', 'convenience'], radiusM: 500, medium: 4, high: 10 },
  retail: { scope: 'hyperlocal', osm: ['convenience', 'supermarket'], radiusM: 500, medium: 5, high: 12 },
  clothing_store: { scope: 'hyperlocal', osm: ['clothes'], radiusM: 700, medium: 5, high: 15 },
  beauty_sport: { scope: 'hyperlocal', osm: ['hairdresser', 'beauty'], radiusM: 500, medium: 5, high: 12 },
  spa: { scope: 'hyperlocal', osm: ['beauty', 'massage'], radiusM: 700, medium: 4, high: 10 },
  fitness_gym: { scope: 'hyperlocal', osm: ['fitness_centre'], radiusM: 1_000, medium: 3, high: 7 },
  healthcare: { scope: 'hyperlocal', osm: ['clinic', 'doctors'], radiusM: 700, medium: 4, high: 10 },
  car_wash: { scope: 'hyperlocal', osm: ['car_wash'], radiusM: 1_500, medium: 3, high: 7 },
  car_service: { scope: 'hyperlocal', osm: ['car_repair'], radiusM: 1_500, medium: 4, high: 10 },
  auto_business: { scope: 'city' },
  hotels: { scope: 'destination', osm: ['hotel', 'guest_house', 'hostel'], radiusM: 1_500, medium: 8, high: 20 },
  tourism: { scope: 'destination' },
  event_venue: { scope: 'city' },
  entertainment: { scope: 'city' },
  services: { scope: 'city' },
  cleaning: { scope: 'city' },
  printing: { scope: 'city' },
  construction: { scope: 'city' },
  offices: { scope: 'property' },
  online: { scope: 'national' },
  e_commerce: { scope: 'national' },
  it_tech: { scope: 'national' },
  manufacturing: { scope: 'national' },
  food_products: { scope: 'national' },
  franchises: { scope: 'city' },
  warehouse: { scope: 'property' },
  winery: { scope: 'export' },
  agriculture: { scope: 'export' },
  real_estate: { scope: 'property' },
  commercial_space: { scope: 'property' },
  land: { scope: 'property' },
}

export function competitionConfig(category: string): Config {
  return COMPETITION[category] ?? { scope: 'city' }
}
