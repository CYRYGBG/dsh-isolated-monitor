/**
 * Durable plugin storage under a dedicated data directory.
 *
 * `state.json` holds tasks, runs, alert events, and pending deliveries.
 * `runs/<run-id>.json` holds the complete evidence artifact of one run.
 * Writes are serialized in-process and committed with the harness'
 * `writeFileAtomic` (temp sibling + rename), so a crash leaves either the
 * previous or the next complete document.
 * @module dsh-isolated-monitor/store
 */
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { emptyState, normalizeLoadedState, RUN_STATUS, TASK_STATUS } from './state.js'
import { cloneJson, isPlainObject } from './util.js'

const STATE_FILE = 'state.json'
const BACKUP_FILE = 'state.json.bak'
const ARTIFACT_DIR = 'runs'

/**
 * @param {{
 *   dir: string,
 *   logger: {warn:(msg:string)=>void, info?:(msg:string)=>void},
 *   writeFileAtomic: (path:string, content:string, options:{mode?:number,dirMode?:number}) => Promise<void>,
 *   historyLimit: number,
 *   artifactRetentionDays: number,
 * }} options
 */
export function createStore(options) {
  const { dir, logger, writeFileAtomic, historyLimit, artifactRetentionDays } = options
  const statePath = join(dir, STATE_FILE)
  const backupPath = join(dir, BACKUP_FILE)
  const artifactDir = join(dir, ARTIFACT_DIR)
  let state = emptyState()
  let loaded = false
  let chain = Promise.resolve()

  /** Serialize one read-modify-write cycle and commit it durably. */
  function transact(mutator) {
    const run = chain.then(async () => {
      const next = cloneJson(state)
      const result = await mutator(next)
      next.updatedAt = new Date().toISOString()
      prune(next, { historyLimit })
      await commit(next)
      state = next
      return result
    })
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function commit(next) {
    const content = `${JSON.stringify(next, null, 2)}\n`
    try {
      const previous = await readFile(statePath, 'utf8')
      if (previous.trim() !== '') {
        await writeFileAtomic(backupPath, previous, { mode: 0o600, dirMode: 0o700 })
      }
    } catch {
      // No previous complete document (first write, or unreadable): the next
      // write is the first recovery anchor.
    }
    await writeFileAtomic(statePath, content, { mode: 0o600, dirMode: 0o700 })
  }

  async function load() {
    if (loaded) return state
    await mkdir(dir, { recursive: true })
    await mkdir(artifactDir, { recursive: true })
    const primary = await readStateFile(statePath)
    if (primary.kind === 'ok') {
      state = normalizeLoadedState(primary.value)
      loaded = true
      await repairAfterLoad()
      return state
    }
    if (primary.kind === 'corrupt') {
      const quarantine = `${statePath}.corrupt-${Date.now()}`
      try {
        await rm(quarantine, { force: true })
        await writeFileAtomic(quarantine, primary.raw, { mode: 0o600, dirMode: 0o700 })
        logger.warn(`state.json is not valid JSON; quarantined at ${quarantine}`)
      } catch {
        logger.warn('state.json is not valid JSON and could not be quarantined')
      }
    }
    const backup = await readStateFile(backupPath)
    if (backup.kind === 'ok') {
      state = normalizeLoadedState(backup.value)
      logger.warn('restored plugin state from state.json.bak')
      loaded = true
      await repairAfterLoad()
      return state
    }
    state = emptyState()
    loaded = true
    return state
  }

  /** Turn a stale in-flight marker into an explicit interruption and save. */
  async function repairAfterLoad() {
    let dirty = false
    for (const task of Object.values(state.tasks)) {
      if (task.in_flight_run_id !== null && task.in_flight_run_id !== undefined) {
        const run = state.runs.find((candidate) => candidate.run_id === task.in_flight_run_id)
        if (run === undefined || run.status !== RUN_STATUS.RUNNING) {
          task.in_flight_run_id = null
          dirty = true
        }
      }
    }
    if (dirty) await transact(() => undefined)
  }

  async function readStateFile(path) {
    let raw
    try {
      raw = await readFile(path, 'utf8')
    } catch (error) {
      return { kind: 'missing', error }
    }
    if (raw.trim() === '') return { kind: 'missing' }
    try {
      const value = JSON.parse(raw)
      if (!isPlainObject(value)) return { kind: 'corrupt', raw }
      return { kind: 'ok', value }
    } catch {
      return { kind: 'corrupt', raw }
    }
  }

  /** Current in-memory state; callers must treat it as read-only. */
  function getState() {
    return state
  }

  /** A detached copy for tool output. */
  function snapshot() {
    return cloneJson(state)
  }

  async function writeArtifact(runId, data) {
    await mkdir(artifactDir, { recursive: true })
    const path = join(artifactDir, `${runId}.json`)
    await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    return path
  }

  async function readArtifact(runId) {
    try {
      return JSON.parse(await readFile(join(artifactDir, `${runId}.json`), 'utf8'))
    } catch {
      return undefined
    }
  }

  /** Delete artifacts older than the retention window. */
  async function pruneArtifacts() {
    const cutoff = Date.now() - artifactRetentionDays * 24 * 60 * 60 * 1000
    let entries
    try {
      entries = await readdir(artifactDir)
    } catch {
      return 0
    }
    let removed = 0
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const path = join(artifactDir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < cutoff) {
          await rm(path, { force: true })
          removed += 1
        }
      } catch {
        // A concurrent removal or an unreadable artifact is not fatal.
      }
    }
    return removed
  }

  return {
    dir,
    load,
    transact,
    getState,
    snapshot,
    writeArtifact,
    readArtifact,
    pruneArtifacts,
  }
}

/** Keep retained history bounded; pending deliveries and open events are never dropped. */
function prune(state, { historyLimit }) {
  const perTask = new Map()
  const keptRuns = []
  for (const run of [...state.runs].reverse()) {
    if (run.status === RUN_STATUS.RUNNING) {
      keptRuns.push(run)
      continue
    }
    const count = perTask.get(run.task_id) ?? 0
    if (count >= historyLimit) continue
    perTask.set(run.task_id, count + 1)
    keptRuns.push(run)
  }
  state.runs = keptRuns.reverse()
  if (state.runs.length > 5000) state.runs = state.runs.slice(-5000)

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000
  state.events = state.events.filter((event) => {
    if (event.status === 'open') return true
    const seen = Date.parse(event.last_seen_at)
    return Number.isFinite(seen) ? seen >= cutoff : true
  })

  const deliveryCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  state.deliveries = state.deliveries.filter((delivery) => {
    if (delivery.status !== 'delivered') return true
    const at = Date.parse(delivery.delivered_at ?? delivery.created_at)
    return Number.isFinite(at) ? at >= deliveryCutoff : true
  })

  const stats = { runs: 0, normal: 0, alert: 0, monitor_error: 0 }
  for (const run of state.runs) {
    stats.runs += 1
    if (run.status === RUN_STATUS.NORMAL) stats.normal += 1
    else if (run.status === RUN_STATUS.ALERT) stats.alert += 1
    else if (run.status === RUN_STATUS.MONITOR_ERROR) stats.monitor_error += 1
  }
  state.stats = { ...state.stats, ...stats }
  for (const task of Object.values(state.tasks)) {
    if (task.status === TASK_STATUS.ENDED && task.in_flight_run_id !== null) task.in_flight_run_id = null
  }
}
