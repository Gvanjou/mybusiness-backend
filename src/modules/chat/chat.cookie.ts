import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { env } from '../../pkg/env/env.js'

// Which of the user's conversations is open. Not a secret: every request checks it belongs to the signed-in user.
export const CONVERSATION_COOKIE = 'mb_chat'

export function openConversationId(c: Context): string | undefined {
  const id = getCookie(c, CONVERSATION_COOKIE)
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined
}

export function setOpenConversation(c: Context, id: string): void {
  setCookie(c, CONVERSATION_COOKIE, id, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'Lax', path: '/', maxAge: 365 * 86_400 })
}

export function clearOpenConversation(c: Context): void {
  deleteCookie(c, CONVERSATION_COOKIE, { path: '/' })
}
