/**
 * In-process scheduler. One timer sleeps until the earliest due task, then
 * dispatches runs through the runner. Occurrences are claimed durably by the
 * runner before any Session is created, so a restart cannot double-run one.
 * @module dsh-isolated-monitor/scheduler
 */
import { isActiveTask, TASK_STATUS } from './state.js'

/**
 * @param {{
 *   store: any,
 *   runner: any,
 *   config: Record<string, any>,
 *   logger: {warn:Function, info:Function},
 * }} options
 */
export function createScheduler({ store, runner, config, logger }) {
  const running = new Set()
  let timer
  let stopped = true

  /** Arm the next wake-up; recomputed after every state change. */
  function arm() {
    if (stopped) return
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const now = Date.now()
    let earliest = Number.POSITIVE_INFINITY
    for (const task of Object.values(store.getState().tasks)) {
      if (!isActiveTask(task)) continue
      const at = Date.parse(task.next_run_at ?? '')
      if (Number.isFinite(at)) earliest = Math.min(earliest, at)
    }
    const maxSleep = Math.max(5, config.pollingMaxSeconds) * 1000
    const delay = Number.isFinite(earliest) ? Math.max(500, Math.min(maxSleep, earliest - now)) : maxSleep
    timer = setTimeout(() => {
      timer = undefined
      void tick()
    }, delay)
    timer.unref?.()
  }

  /** Dispatch every due task within the concurrency budget. */
  async function tick() {
    if (stopped) return
    const now = Date.now()
    const due = Object.values(store.getState().tasks)
      .filter((task) => isActiveTask(task) && Number.isFinite(Date.parse(task.next_run_at ?? '')))
      .filter((task) => Date.parse(task.next_run_at) <= now)
      .filter((task) => !running.has(task.task_id))
      .filter((task) => task.in_flight_run_id === null || task.in_flight_run_id === undefined)
      .sort((left, right) => String(left.next_run_at).localeCompare(String(right.next_run_at)))

    for (const task of due) {
      if (running.size >= config.maxConcurrentRuns) break
      running.add(task.task_id)
      void runner
        .execute(task, { trigger: 'schedule', occurrenceAt: task.next_run_at })
        .catch((error) => logger.warn(`scheduled run failed: ${String(error?.message ?? error)}`))
        .finally(() => {
          running.delete(task.task_id)
          arm()
        })
    }
    arm()
  }

  /** Run one task immediately without moving its committed occurrence. */
  async function runNow(taskId) {
    const task = store.getState().tasks[taskId]
    if (task === undefined) throw new Error(`unknown task: ${taskId}`)
    if (running.has(taskId)) return { outcome: 'skipped', reason: 'already_in_flight' }
    running.add(taskId)
    try {
      return await runner.execute(task, { trigger: 'run_now', occurrenceAt: new Date().toISOString() })
    } finally {
      running.delete(taskId)
      arm()
    }
  }

  /** Startup: recover interrupted runs and collapse missed occurrences to one. */
  async function start() {
    stopped = false
    await runner.recoverInterrupted()
    for (const task of Object.values(store.getState().tasks)) {
      if (!isActiveTask(task)) continue
      if (Number.isFinite(Date.parse(task.next_run_at ?? ''))) continue
      // A task without a committed occurrence (older data, failed write) runs once now.
      await store.transact((state) => {
        const live = state.tasks[task.task_id]
        if (live === undefined || live.status !== TASK_STATUS.ACTIVE) return
        live.next_run_at = new Date().toISOString()
      })
    }
    arm()
    return () => stop()
  }

  function stop() {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return { start, stop, arm, tick, runNow, isRunning: (taskId) => running.has(taskId) }
}
