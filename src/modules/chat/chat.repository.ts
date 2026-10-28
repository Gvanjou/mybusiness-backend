import { db } from '../../pkg/supabase/supabase.js'
import type { Locale } from '../../shared/i18n/locale.js'
import { sessionStateSchema, type SessionState } from './chat.model.js'
import { parseProfile, type Profile } from './profile/profile.model.js'

// One conversation of a signed-in user (the table keeps its original name, chat_sessions).
export type Session = {
  id: string
  userId: string | null
  title: string | null
  locale: Locale
  profile: Profile
  state: SessionState
  turnCount: number
  expiresAt: Date
}

export type StoredMessage = {
  id: number
  role: 'user' | 'assistant'
  content: string
  intent: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type ConversationSummary = { id: string; title: string | null; updatedAt: string }

function toSession(row: Record<string, unknown>): Session {
  return {
    id: String(row.id),
    userId: row.user_id ? String(row.user_id) : null,
    title: row.title ? String(row.title) : null,
    locale: row.locale as Locale,
    profile: parseProfile(row.profile),
    state: sessionStateSchema.parse(row.state ?? {}),
    turnCount: Number(row.turn_count ?? 0),
    expiresAt: new Date(String(row.expires_at)),
  }
}

export const chatRepository = {
  async createSession(locale: Locale, userId: string): Promise<Session> {
    const { data, error } = await db.from('chat_sessions').insert({ user_id: userId, locale, profile: {}, state: {} }).select('*').single()
    if (error) throw error
    return toSession(data)
  },

  // A conversation, only if it belongs to this user.
  async findForUser(id: string, userId: string): Promise<Session | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null
    const { data, error } = await db.from('chat_sessions').select('*').eq('id', id).eq('user_id', userId).maybeSingle()
    if (error) throw error
    return data ? toSession(data) : null
  },

  // Chat history: the user's conversations that have at least one message from them, newest first.
  async listForUser(userId: string, limit = 50): Promise<ConversationSummary[]> {
    const { data, error } = await db
      .from('chat_sessions')
      .select('id, title, updated_at')
      .eq('user_id', userId)
      .not('title', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data.map((r) => ({ id: String(r.id), title: r.title, updatedAt: r.updated_at }))
  },

  // AI tokens this user's conversations used today (Tbilisi day).
  async tokensToday(userId: string): Promise<number> {
    const { data, error } = await db.rpc('user_tokens_today', { uid: userId })
    if (error) throw error
    return Number(data ?? 0)
  },

  async saveSession(s: Session): Promise<void> {
    const { error } = await db
      .from('chat_sessions')
      .update({ title: s.title, locale: s.locale, profile: s.profile, state: s.state, turn_count: s.turnCount, updated_at: new Date().toISOString() })
      .eq('id', s.id)
    if (error) throw error
  },

  async deleteSession(id: string): Promise<void> {
    const { error } = await db.from('chat_sessions').delete().eq('id', id)
    if (error) throw error
  },

  async addMessage(sessionId: string, m: { role: 'user' | 'assistant'; content: string; intent?: string; payload?: Record<string, unknown> }): Promise<number> {
    const { data, error } = await db
      .from('chat_messages')
      .insert({ session_id: sessionId, role: m.role, content: m.content, intent: m.intent ?? null, payload: m.payload ?? {} })
      .select('id')
      .single()
    if (error) throw error
    return Number(data.id)
  },

  async recentMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    const { data, error } = await db
      .from('chat_messages')
      .select('id, role, content, intent, payload, created_at')
      .eq('session_id', sessionId)
      .order('id', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data
      .map((r) => ({ id: Number(r.id), role: r.role, content: r.content, intent: r.intent, payload: r.payload ?? {}, createdAt: r.created_at }))
      .reverse()
  },

  async addFeedback(sessionId: string, messageId: number, rating: 1 | -1, comment?: string): Promise<boolean> {
    // Only feedback on this session's own assistant messages.
    const { data: msg } = await db.from('chat_messages').select('id').eq('id', messageId).eq('session_id', sessionId).eq('role', 'assistant').maybeSingle()
    if (!msg) return false
    const { error } = await db
      .from('chat_feedback')
      .upsert({ message_id: messageId, session_id: sessionId, rating, comment: comment ?? null }, { onConflict: 'message_id' })
    if (error) throw error
    return true
  },

  // Conversations from before sign-in existed; a user's own history is kept until they delete it.
  async deleteExpired(): Promise<void> {
    await db.from('chat_sessions').delete().is('user_id', null).lt('expires_at', new Date().toISOString())
  },
}
