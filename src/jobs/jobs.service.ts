import { logger, errorFields } from '../shared/logger/logger.js'
import { deleteExpiredSessions } from '../modules/auth/auth.service.js'
import { chatRepository } from '../modules/chat/chat.repository.js'
import { knowledge } from '../modules/knowledge/knowledge.service.js'

// Listings are read live from mybusiness.ge, so there is nothing to sync: only housekeeping is left.
export const jobNames = ['knowledge', 'cleanup', 'all'] as const
export type JobName = (typeof jobNames)[number]

const running = new Set<JobName>()

const jobs: Record<Exclude<JobName, 'all'>, () => Promise<unknown>> = {
  knowledge: () => knowledge.ingest(),
  cleanup: () => Promise.all([chatRepository.deleteExpired(), deleteExpiredSessions()]),
}

// Runs a job unless the same job is already running.
export async function runJob(name: JobName): Promise<{ started: boolean; result?: unknown }> {
  if (running.has(name)) return { started: false }
  running.add(name)
  const started = Date.now()
  try {
    let result: unknown
    if (name === 'all') {
      result = { knowledge: await jobs.knowledge(), cleanup: await jobs.cleanup() }
    } else {
      result = await jobs[name]()
    }
    logger.info('job finished', { job: name, ms: Date.now() - started })
    return { started: true, result }
  } catch (err) {
    logger.error('job failed', { job: name, ...errorFields(err) })
    throw err
  } finally {
    running.delete(name)
  }
}

// In-process timers for single-server deployments (ENABLE_SCHEDULER=true).
export function startScheduler(): void {
  const every = (ms: number, name: JobName) =>
    setInterval(() => {
      runJob(name).catch(() => undefined)
    }, ms).unref()
  every(24 * 60 * 60_000, 'cleanup')
  logger.info('scheduler started')
}
