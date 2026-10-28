import { Hono } from 'hono'
import { logger, errorFields } from '../../shared/logger/logger.js'
import { publicOrigin, safeNext, sameOrigin } from '../../shared/http/origin.js'
import { clearOpenConversation } from '../chat/chat.cookie.js'
import { finishGoogleSignIn, googleSignInUrl, requireUser, signOut } from './auth.service.js'

// /api/auth: Google sign-in, the signed-in user, sign-out.
// Google redirect URI to register: <site address>/api/auth/callback (e.g. http://localhost:3000/api/auth/callback).
export const authRoutes = new Hono()
  .use(sameOrigin)

  .get('/google', (c) => {
    const next = safeNext(c.req.query('next'))
    try {
      return c.redirect(googleSignInUrl(c, `${publicOrigin(c)}/api/auth/callback`, next))
    } catch (err) {
      logger.warn('google sign-in could not start', errorFields(err))
      return c.redirect(`${publicOrigin(c)}${next}?auth=failed`)
    }
  })

  .get('/callback', async (c) => {
    const origin = publicOrigin(c)
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state) return c.redirect(`${origin}/ka?auth=failed`) // the user cancelled at Google, or a bad link
    try {
      const next = await finishGoogleSignIn(c, `${origin}/api/auth/callback`, code, state)
      return c.redirect(`${origin}${safeNext(next)}`)
    } catch (err) {
      logger.warn('google sign-in failed', errorFields(err))
      return c.redirect(`${origin}/ka?auth=failed`)
    }
  })

  // The signed-in user for the UI (name and photo); 401 when signed out.
  .get('/me', async (c) => {
    const user = await requireUser(c)
    return c.json({ name: user.name, email: user.email, avatarUrl: user.avatarUrl })
  })

  .post('/signout', async (c) => {
    await signOut(c)
    clearOpenConversation(c)
    return c.body(null, 204)
  })
