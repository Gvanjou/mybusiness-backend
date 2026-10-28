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

// Another conversation of the same user: what it learned about them and which listings it showed.
export type EarlierChat = { id: string; title: string | null; updatedAt: string; profile: Profile; state: SessionState }

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


  // The user's most recently started chat (titled or not): the one in progress when it is open.
  async newestForUser(userId: string): Promise<string | null> {
    const { data, error } = await db.from('chat_sessions').select('id').eq('user_id', userId).order('created_at', { ascending: false }).limit(1)
    if (error) throw error
    return data[0] ? String(data[0].id) : null
  },

  // The user's other conversations, newest first, for recalling what was said before (only on demand).
  async earlierForUser(userId: string, excludeId: string, limit = 5): Promise<EarlierChat[]> {
    const { data, error } = await db
      .from('chat_sessions')
      .select('id, title, updated_at, profile, state')
      .eq('user_id', userId)
      .neq('id', excludeId)
      .not('title', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data.map((r) => ({ id: String(r.id), title: r.title, updatedAt: r.updated_at, profile: parseProfile(r.profile), state: sessionStateSchema.parse(r.state ?? {}) }))
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

  // Rewrites a stored message: an answer that was continued, or a message of the client's left unanswered.
  async updateMessage(sessionId: string, id: number, m: { content?: string; payload?: Record<string, unknown> }): Promise<void> {
    const patch: Record<string, unknown> = {}
    if (m.content !== undefined) patch.content = m.content
    if (m.payload !== undefined) patch.payload = m.payload
    const { error } = await db.from('chat_messages').update(patch).eq('id', id).eq('session_id', sessionId)
    if (error) throw error
  },

  async deleteMessage(sessionId: string, id: number): Promise<void> {
    const { error } = await db.from('chat_messages').delete().eq('id', id).eq('session_id', sessionId)
    if (error) throw error
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
