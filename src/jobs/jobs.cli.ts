// Usage: npm run job -- <knowledge|cleanup|all>
import { quota } from '../modules/ai/ai.quota.js'
import { jobNames, runJob, type JobName } from './jobs.service.js'

const name = process.argv[2] as JobName | undefined
if (!name || !jobNames.includes(name)) {
  console.error(`Usage: npm run job -- <${jobNames.join('|')}>`)
  process.exit(1)
}

await quota.load()
const { result } = await runJob(name)
console.log(JSON.stringify(result, null, 2))
process.exit(0)
