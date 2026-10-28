import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { AppError } from './shared/http/app-error.js'
import { logger, errorFields } from './shared/logger/logger.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { chatRoutes } from './modules/chat/chat.routes.js'
import { jobsRoutes } from './jobs/jobs.routes.js'

// No CORS: the browser reaches this API through the frontend's /api proxy, on the site's own address, so the
// sign-in cookies set here belong to the site.
export const app = new Hono()
  .use(secureHeaders())
  .get('/health', (c) => c.json({ ok: true }))
  .route('/api/auth', authRoutes)
  .route('/api/assistant', chatRoutes)
  .route('/jobs', jobsRoutes)
  .notFound((c) => c.json({ code: 'not_found', message: 'Not found' }, 404))
  .onError((err, c) => {
    if (err instanceof AppError) {
      if (err.retryAfterSeconds) c.header('retry-after', String(err.retryAfterSeconds))
      return c.json({ code: err.code, message: err.message, ...err.details }, err.status)
    }
    logger.error('unhandled error', { path: c.req.path, ...errorFields(err) })
    return c.json({ code: 'internal', message: 'Something went wrong' }, 500)
  })
