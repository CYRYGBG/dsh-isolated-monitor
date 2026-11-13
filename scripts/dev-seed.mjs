/**
 * Development-only live seeding helper (not published).
 *
 * Writes two real monitor tasks into the running profile's plugin data
 * directory so a reviewer can watch the live scheduler create isolated
 * Sessions. Run it, then toggle the bundle (or restart DSH) so the plugin
 * reloads the file:
 *
 *   node scripts/dev-seed.mjs
 *
 * Task 1 is a deterministic file check: it should pass, create an isolated
 * Session, archive it, and send nothing to the creator.
 * Task 2 asks the model to report a deliberately missing file: it should keep
 * its Session and send one alert to the creator.
 */
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTaskRecord } from '../src/state.js'
import { createStore } from '../src/store.js'
import { createTiming } from '../src/timing.js'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DATA_DIR = join(DSH_HOME, 'isolated-monitor')
const PROJECT = process.argv[2] ?? process.cwd()
const SOURCE_SESSION = process.argv[3] ?? process.env.DSH_SESSION_ID
if (SOURCE_SESSION === undefined) throw new Error('pass the creator session id as the second argument or set DSH_SESSION_ID')

async function atomic(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${Date.now()}.tmp`
  await writeFile(temp, content)
  await rename(temp, path)
}

const timing = createTiming({
  Cron: { parse: () => ({ kind: 'rejected', reason: 'syntax' }) },
  RRule: { parse: () => ({ kind: 'rejected', reason: 'syntax' }) },
  resolveLocalInstant(date, time, zone) {
    const epoch = Date.parse(`${date}T${time}Z`)
    return Number.isFinite(epoch) ? epoch : undefined
  },
})

const logger = { warn: (line) => console.warn(line), info: (line) => console.log(line) }
const store = createStore({
  dir: DATA_DIR,
  logger,
  writeFileAtomic: atomic,
  historyLimit: 200,
  artifactRetentionDays: 30,
})
await store.load()

const config = {
  defaultTimeoutSeconds: 900,
  defaultRetryMaxAttempts: 1,
  defaultRetryBaseSeconds: 60,
  defaultAgentPreset: '',
  maxAlertsPerDay: 100,
}
const now = Date.now()

const normalSchedule = timing.normalizeSchedule({ kind: 'every', every_seconds: 600 }, { now, defaultTimeZone: 'Asia/Shanghai' })
const normalTask = createTaskRecord(
  {
    name: '开发自检：插件文件存在',
    task_prompt: '',
    checks: [
      {
        id: 'package-json',
        kind: 'file_exists',
        title: '插件 package.json 存在',
        path: join(PROJECT, 'package.json'),
        exists: true,
        min_bytes: 100,
      },
    ],
    execution_mode: 'hybrid',
    schedule: normalSchedule.schedule,
    timeout_seconds: 120,
    severity: 'high',
  },
  {
    now,
    config,
    schedule: normalSchedule.schedule,
    firstAt: normalSchedule.firstAt,
    sourceSessionId: SOURCE_SESSION,
    projectPath: PROJECT,
    defaultTimeZone: 'Asia/Shanghai',
  },
)
normalTask.schedule_text = timing.describeSchedule(normalSchedule.schedule)
normalTask.next_run_at = new Date(now + 20_000).toISOString()

const alertSchedule = timing.normalizeSchedule({ kind: 'every', every_seconds: 600 }, { now, defaultTimeZone: 'Asia/Shanghai' })
const alertTask = createTaskRecord(
  {
    name: '开发自检：缺失文件告警',
    task_prompt:
      '检查项目根目录下是否存在文件 DEFINITELY_MISSING.txt（绝对路径：' +
      join(PROJECT, 'DEFINITELY_MISSING.txt') +
      '）。若不存在，这是预期异常：请报告 status=alert，type=missing_file，severity=high，key=dev-missing-file，evidence 写明你检查的绝对路径与结果。若存在则报告 ok。不要修改任何文件。',
    schedule: alertSchedule.schedule,
    timeout_seconds: 180,
    severity: 'high',
    alert_rules: ['项目根目录缺少 DEFINITELY_MISSING.txt 时视为异常'],
    allowed_operations: { write: false },
  },
  {
    now,
    config,
    schedule: alertSchedule.schedule,
    firstAt: alertSchedule.firstAt,
    sourceSessionId: SOURCE_SESSION,
    projectPath: PROJECT,
    defaultTimeZone: 'Asia/Shanghai',
  },
)
alertTask.schedule_text = timing.describeSchedule(alertSchedule.schedule)
alertTask.next_run_at = new Date(now + 50_000).toISOString()

await store.transact((state) => {
  state.tasks[normalTask.task_id] = normalTask
  state.tasks[alertTask.task_id] = alertTask
})

const state = JSON.parse(await readFile(join(DATA_DIR, 'state.json'), 'utf8'))
console.log(
  JSON.stringify(
    {
      dataDir: DATA_DIR,
      sourceSessionId: SOURCE_SESSION,
      project: PROJECT,
      tasks: Object.values(state.tasks).map((task) => ({
        task_id: task.task_id,
        name: task.name,
        mode: task.execution_mode,
        next_run_at: task.next_run_at,
        checks: task.checks.length,
      })),
    },
    null,
    2,
  ),
)

