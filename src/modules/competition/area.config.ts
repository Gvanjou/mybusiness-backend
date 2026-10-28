// Which places on the map compete with each kind of business. Entries match a map place's class ("cafe") or
// class/subclass ("shop/beauty"), as in the OpenMapTiles poi layer. direct = same offer; related = competes for
// the same visit or spend.
export const COMPETITORS: Record<string, { direct: string[]; related: string[] }> = {
  restaurants: { direct: ['restaurant', 'fast_food'], related: ['cafe', 'bar', 'beer', 'bakery', 'ice_cream'] },
  bakery: { direct: ['bakery', 'shop/confectionery', 'shop/chocolate'], related: ['cafe', 'grocery', 'shop/convenience'] },
  bar_nightclub: { direct: ['bar', 'beer'], related: ['restaurant', 'cafe'] },
  hotels: { direct: ['lodging'], related: [] },
  tourism: { direct: ['lodging', 'shop/travel_agency'], related: ['attraction', 'museum'] },
  retail: { direct: ['shop/convenience', 'grocery', 'shop/kiosk'], related: ['alcohol_shop', 'butcher'] },
  supermarket: { direct: ['grocery', 'shop/convenience', 'shop/kiosk'], related: ['butcher', 'alcohol_shop', 'bakery'] },
  clothing_store: { direct: ['clothing_store', 'shop/shoes', 'shop/boutique'], related: ['shop/jewelry', 'shop/second_hand', 'shop/sports'] },
  healthcare: { direct: ['hospital', 'doctors'], related: ['dentist', 'pharmacy'] },
  dental: { direct: ['dentist'], related: ['hospital', 'doctors'] },
  pharmacy: { direct: ['pharmacy', 'shop/chemist'], related: ['hospital', 'doctors'] },
  spa: { direct: ['shop/massage', 'swimming_pool'], related: ['shop/beauty', 'hairdresser'] },
  beauty_sport: { direct: ['hairdresser', 'shop/beauty'], related: ['shop/massage', 'shop/tattoo', 'sports_centre', 'yoga'] },
  fitness_gym: { direct: ['sports_centre', 'yoga'], related: ['swimming_pool', 'pitch'] },
  car_service: { direct: ['car/car_repair', 'car/car_parts'], related: ['fuel', 'car'] },
  auto_business: { direct: ['car', 'car/car_parts'], related: ['fuel'] },
  car_wash: { direct: ['car'], related: ['fuel'] },
  entertainment: { direct: ['cinema', 'theatre', 'escape_game', 'billiards', 'theme_park'], related: ['bar', 'restaurant'] },
  event_venue: { direct: ['restaurant', 'theatre'], related: ['lodging'] },
  printing: { direct: ['shop/copyshop'], related: ['shop/stationery'] },
  cleaning: { direct: ['laundry'], related: [] },
  services: { direct: [], related: [] },
}

// What the area around a place consists of, for judging footfall and who the customers are.
export const AREA_GROUPS: Record<string, string[]> = {
  food_and_drink: ['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'bakery', 'ice_cream'],
  everyday_shops: ['grocery', 'shop/convenience', 'shop/kiosk', 'butcher', 'alcohol_shop'],
  other_shops: ['shop', 'clothing_store'],
  health: ['pharmacy', 'hospital', 'doctors', 'dentist'],
  beauty: ['hairdresser', 'shop/beauty', 'shop/massage'],
  offices: ['office'],
  schools_kindergartens: ['school'],
  universities: ['college'],
  hotels: ['lodging'],
  sights_and_culture: ['attraction', 'museum', 'art_gallery/gallery', 'theatre', 'cinema'],
  banks_atms: ['bank', 'atm'],
  bus_stops: ['bus'],
  metro_and_rail: ['entrance/subway_entrance', 'railway'],
  parking: ['parking'],
  parks_playgrounds: ['park', 'playground'],
}

// Street furniture on the map that says nothing about business activity.
export const NOT_ACTIVITY = new Set(['gate', 'waste_basket', 'bollard', 'lift_gate', 'drinking_water', 'bicycle_parking', 'information', 'toilets', 'shelter', 'recycling', 'art_gallery/artwork', 'stile', 'post/post_box'])

// Uses a commercial space is typically bought for, with the floor area each needs.
export const SPACE_USES: { category: string; minArea: number }[] = [
  { category: 'restaurants', minArea: 40 },
  { category: 'bakery', minArea: 25 },
  { category: 'pharmacy', minArea: 25 },
  { category: 'supermarket', minArea: 40 },
  { category: 'beauty_sport', minArea: 20 },
  { category: 'dental', minArea: 40 },
  { category: 'fitness_gym', minArea: 150 },
  { category: 'clothing_store', minArea: 30 },
]

export function matches(place: { cls: string; sub: string }, keys: string[]): boolean {
  return keys.some((k) => k === place.cls || k === `${place.cls}/${place.sub}`)
}
