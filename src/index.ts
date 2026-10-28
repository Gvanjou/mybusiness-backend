import { serve } from '@hono/node-server'
import { env } from './pkg/env/env.js'
import { logger, errorFields } from './shared/logger/logger.js'
import { app } from './app.js'
import { quota } from './modules/ai/ai.quota.js'
import { catalog } from './modules/catalog/catalog.service.js'
import { knowledge } from './modules/knowledge/knowledge.service.js'
import { startScheduler } from './jobs/jobs.service.js'

await quota.load()
await Promise.all([
  catalog.reload().catch((err) => logger.warn('mybusiness.ge not reachable at boot; listings load on the first question', errorFields(err))),
  knowledge.load().catch((err) => logger.warn('knowledge not loaded at boot', errorFields(err))),
])
if (env.ENABLE_SCHEDULER) startScheduler()

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('backend listening', { port: info.port, env: env.NODE_ENV })
})

const shutdown = () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
