import { Hono } from 'hono'
import { env } from '../pkg/env/env.js'
import { AppError } from '../shared/http/app-error.js'
import { safeEqual } from '../shared/utils/crypto.js'
import { quota } from '../modules/ai/ai.quota.js'
import { jobNames, runJob, type JobName } from './jobs.service.js'

// Internal endpoints for an external cron service. Protected by JOBS_SECRET (Bearer);
// disabled entirely when JOBS_SECRET is not set.
export const jobsRoutes = new Hono()
  .use(async (c, next) => {
    if (!env.JOBS_SECRET) throw new AppError('not_found', 'Not found')
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || !safeEqual(token, env.JOBS_SECRET)) throw new AppError('unauthorized', 'Unauthorized')
    await next()
  })
  .post('/:name', async (c) => {
    const name = c.req.param('name') as JobName
    if (!jobNames.includes(name)) throw new AppError('not_found', 'Unknown job')
    // Jobs can take minutes: start in the background and return immediately.
    void runJob(name).catch(() => undefined)
    return c.json({ accepted: true, job: name }, 202)
  })
  .get('/quota', (c) => c.json(quota.snapshot()))
