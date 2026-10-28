import { db } from '../../pkg/supabase/supabase.js'
import { logger, errorFields } from '../../shared/logger/logger.js'
import type { CatalogListing } from '../catalog/catalog.model.js'
import type { CatalogSnapshot } from '../catalog/catalog.service.js'

// "Tell me when a café in Batumi under 30 000 ₾ is listed": a saved search per user. Listings are read live from the
// site, so a match is any listing that fits and was published after the client last looked.

export type AlertCriteria = { categories: string[]; cities: string[]; maxPriceGel: number | null }
export type Alert = { id: string; label: string; criteria: AlertCriteria; lastSeenAt: string; createdAt: string }

function toAlert(r: Record<string, unknown>): Alert {
  const c = (r.criteria ?? {}) as Partial<AlertCriteria>
  return {
    id: String(r.id),
    label: String(r.label ?? ''),
    criteria: { categories: c.categories ?? [], cities: c.cities ?? [], maxPriceGel: c.maxPriceGel ?? null },
    lastSeenAt: String(r.last_seen_at),
    createdAt: String(r.created_at),
  }
}

export function matchesAlert(l: CatalogListing, c: AlertCriteria): boolean {
  if (c.categories.length && !c.categories.includes(l.category)) return false
  if (c.cities.length && (!l.city || !c.cities.includes(l.city))) return false
  if (c.maxPriceGel !== null && (l.priceGel === null || l.priceGel > c.maxPriceGel)) return false
  return true
}

export const alerts = {
  async create(userId: string, label: string, criteria: AlertCriteria): Promise<Alert> {
    const { data, error } = await db.from('saved_searches').insert({ user_id: userId, label: label.slice(0, 120), criteria }).select('*').single()
    if (error) throw error
    return toAlert(data)
  },

  async listForUser(userId: string): Promise<Alert[]> {
    const { data, error } = await db.from('saved_searches').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(20)
    if (error) {
      // Before migration 015 the table is missing: alerts are simply off.
      logger.warn('saved searches unavailable (run migration 015?)', errorFields(error))
      return []
    }
    return data.map(toAlert)
  },

  async markSeen(userId: string, id: string): Promise<void> {
    const { error } = await db.from('saved_searches').update({ last_seen_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId)
    if (error) throw error
  },

  async remove(userId: string, id: string): Promise<boolean> {
    const { data, error } = await db.from('saved_searches').delete().eq('id', id).eq('user_id', userId).select('id')
    if (error) throw error
    return data.length > 0
  },

  // Listings published since the client last looked that fit the alert, newest first.
  newMatches(a: Alert, s: CatalogSnapshot): CatalogListing[] {
    const since = new Date(a.lastSeenAt).getTime()
    return s.listings
      .filter((l) => matchesAlert(l, a.criteria) && l.createdAt !== null && new Date(l.createdAt).getTime() > since)
      .sort((x, y) => new Date(y.createdAt!).getTime() - new Date(x.createdAt!).getTime())
      .slice(0, 10)
  },
}
