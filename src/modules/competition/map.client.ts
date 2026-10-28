import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { distanceM } from './nominatim.client.js'

// Places around a point from OpenFreeMap vector tiles: the same OpenStreetMap data the map on a mybusiness.ge
// listing page shows (shops, cafés, pharmacies, bus stops, schools…). Free, no key, no request limit.
// https://openfreemap.org

const TILEJSON = 'https://tiles.openfreemap.org/planet'
const ZOOM = 14 // the zoom level that carries every place
const TIMEOUT_MS = 6_000
const MAX_TILES = 80 // decoded tiles kept in memory (~1 MB each)

export type MapPlace = { name: string; nameEn: string | null; nameKa: string | null; cls: string; sub: string; lat: number; lon: number; distanceM: number }
type Tile = { places: Omit<MapPlace, 'distanceM'>[]; addresses: { lat: number; lon: number }[] }

const tiles = new Map<string, Promise<Tile>>()
let template: { at: number; url: string } | null = null

// The tile URL carries the data version, which changes about weekly.
async function tileUrl(): Promise<string> {
  if (template && Date.now() - template.at < 86_400_000) return template.url
  const res = await fetch(TILEJSON, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`OpenFreeMap ${res.status}`)
  const url = ((await res.json()) as { tiles: string[] }).tiles[0]!
  template = { at: Date.now(), url }
  return url
}

function tileXY(lat: number, lon: number): { x: number; y: number } {
  const n = 2 ** ZOOM
  const rad = (lat * Math.PI) / 180
  return { x: Math.floor(((lon + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n) }
}

function point(geometry: { type: string }): { lat: number; lon: number } | null {
  if (geometry.type !== 'Point') return null
  const [lon, lat] = (geometry as unknown as { coordinates: [number, number] }).coordinates
  return { lat, lon }
}

async function loadTile(x: number, y: number): Promise<Tile> {
  const url = (await tileUrl()).replace('{z}', String(ZOOM)).replace('{x}', String(x)).replace('{y}', String(y))
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 404) return { places: [], addresses: [] }
  if (!res.ok) throw new Error(`OpenFreeMap tile ${res.status}`)
  const tile = new VectorTile(new Pbf(new Uint8Array(await res.arrayBuffer())))
  const places: Tile['places'] = []
  const poi = tile.layers.poi
  for (let i = 0; poi && i < poi.length; i++) {
    const f = poi.feature(i)
    const p = point(f.toGeoJSON(x, y, ZOOM).geometry)
    if (!p) continue
    const props = f.properties
    places.push({ name: String(props.name ?? ''), nameEn: props['name:en'] ? String(props['name:en']) : null, nameKa: props['name:ka'] ? String(props['name:ka']) : null, cls: String(props.class ?? ''), sub: String(props.subclass ?? ''), ...p })
  }
  const addresses: Tile['addresses'] = []
  const hn = tile.layers.housenumber
  for (let i = 0; hn && i < hn.length; i++) {
    const p = point(hn.feature(i).toGeoJSON(x, y, ZOOM).geometry)
    if (p) addresses.push(p)
  }
  return { places, addresses }
}

function cachedTile(x: number, y: number): Promise<Tile> {
  const key = `${x}/${y}`
  let hit = tiles.get(key)
  if (!hit) {
    hit = loadTile(x, y)
    hit.catch(() => tiles.delete(key))
    tiles.set(key, hit)
    if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value!)
  }
  return hit
}

// Every place and street address within radiusM of the point, nearest first. null when the tiles are unavailable.
export async function mapAround(lat: number, lon: number, radiusM: number): Promise<{ places: MapPlace[]; addresses: number } | null> {
  const dLat = radiusM / 111_320
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180))
  const a = tileXY(lat + dLat, lon - dLon)
  const b = tileXY(lat - dLat, lon + dLon)
  const keys: [number, number][] = []
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) keys.push([x, y])
  try {
    const loaded = await Promise.all(keys.map(([x, y]) => cachedTile(x, y)))
    // Tiles repeat the places near their edges (tile buffers): keep each place once.
    const unique = <T extends { lat: number; lon: number }>(items: T[], key: (x: T) => string) => [...new Map(items.map((x) => [`${key(x)}|${x.lat.toFixed(5)}|${x.lon.toFixed(5)}`, x])).values()]
    const places = unique(loaded.flatMap((t) => t.places), (p) => `${p.cls}|${p.sub}|${p.name}`)
      .map((p) => ({ ...p, distanceM: Math.round(distanceM(lat, lon, p.lat, p.lon)) }))
      .filter((p) => p.distanceM <= radiusM)
      .sort((p, q) => p.distanceM - q.distanceM)
    const addresses = unique(loaded.flatMap((t) => t.addresses), () => '').filter((p) => distanceM(lat, lon, p.lat, p.lon) <= radiusM).length
    return { places, addresses }
  } catch (err) {
    logger.warn('map tiles unavailable', errorFields(err))
    return null
  }
}
