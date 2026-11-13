/**
 * One monitor run: create an isolated Session, run the Agent to completion,
 * classify the durable outcome, archive or keep the Session, and route alerts.
 * @module dsh-isolated-monitor/runner
 */
import { classifyOutcome, findingsFromChecks } from './classify.js'
import { buildMonitorPrompt, buildRepairPrompt, defaultSeverityOf } from './prompt.js'
import { monitorErrorFinding } from './alerts.js'
import { addUsage, emptyUsage, RUN_STATUS, TASK_STATUS } from './state.js'
import { truncate } from './util.js'

/**
 * @param {{
 *   ctx: any,
 *   config: Record<string, any>,
 *   store: any,
 *   sessions: any,
 *   alerts: any,
 *   checks: any,
 *   timing: any,
 *   logger: {warn:Function, info:Function},
 *   adapters: { createUserMessage: Function, appendPluginRecord: Function },
 * }} options
 */
export function createRunner(options) {
  const { ctx, config, store, sessions, alerts, checks, timing, logger, adapters } = options
  const inflight = new Set()
  const active = new Map()
  let stopped = false

  /**
   * Execute one task once.
   * @param {Record<string, any>} task
   * @param {{trigger:'schedule'|'run_now', occurrenceAt?:string|null, reason?:string}} request
   * @returns {Promise<Record<string, any>>}
   */
  async function execute(task, request) {
    if (stopped) return { outcome: 'skipped', reason: 'shutting_down' }
    if (inflight.has(task.task_id)) return { outcome: 'skipped', reason: 'already_in_flight' }
    inflight.add(task.task_id)
    try {
      return await executeInner(task, request)
    } catch (error) {
      logger.warn(`monitor run for ${task.task_id} failed: ${String(error?.stack ?? error)}`)
      return { outcome: 'error', reason: String(error?.message ?? error) }
    } finally {
      inflight.delete(task.task_id)
    }
  }

  async function executeInner(task, request) {
    if (stopped) return { outcome: 'skipped', reason: 'shutting_down' }
    if (sessions.isArchived(task.source_session_id)) {
      await pauseTask(task.task_id, 'source_session_archived')
      return { outcome: 'paused', reason: 'source_session_archived' }
    }
    const attempt = Math.max(1, Number(request.attempt ?? 1))
    const totalAttempts = 1 + Math.max(0, Number(task.retry_policy?.max_attempts ?? 0))
    const occurrence = request.occurrenceAt ?? task.next_run_at
    const occurrenceEpoch = occurrence === null ? undefined : Date.parse(occurrence)
    const runId = makeRunId()
    const startedAt = Date.now()
    const run = {
      run_id: runId,
      task_id: task.task_id,
      task_name: task.name,
      trigger: request.trigger,
      attempt,
      occurrence_at: occurrence ?? null,
      started_at: new Date(startedAt).toISOString(),
      finished_at: null,
      status: RUN_STATUS.RUNNING,
      code: null,
      message: null,
      session_id: null,
      session_archived: false,
      session_disposed: false,
      model: task.model ?? null,
      duration_ms: null,
      usage: emptyUsage(),
      summary: '',
      findings: [],
      checks: [],
      attempts: attempt,
      error: null,
      artifact_path: null,
      classification: null,
      retry_scheduled: false,
      recovery_handled: false,
    }
    const claim = await store.transact((state) => {
      const live = state.tasks[task.task_id]
      if (live === undefined) return { ok: false, reason: 'unknown_task' }
      if (live.status !== TASK_STATUS.ACTIVE || live.enabled !== true) return { ok: false, reason: 'inactive' }
      if (live.in_flight_run_id !== null && live.in_flight_run_id !== undefined) {
        return { ok: false, reason: 'already_in_flight' }
      }
      live.in_flight_run_id = runId
      state.runs.push(run)
      return { ok: true }
    })
    if (claim.ok !== true) return { outcome: 'skipped', reason: claim.reason }

    let session
    let outcome
    let assistantText = ''
    let prompt = ''
    let checkResults = []
    try {
      session = await sessions.createRunSession(task, run)
      run.session_id = session.sessionId
      active.set(run.run_id, session)
      if (task.checks.length > 0) {
        checkResults = await checks.run({ agent: session.agent, checks: task.checks })
        run.checks = checkResults
      }
      const failed = checkResults.filter((check) => check.passed === false)
      const unreadable = checkResults.filter((check) => check.passed === undefined)
      const canSkipAgent =
        task.execution_mode === 'hybrid' &&
        task.skip_agent_on_pass !== false &&
        task.checks.length > 0 &&
        checkResults.length === task.checks.length &&
        failed.length === 0 &&
        unreadable.length === 0
      if (canSkipAgent) {
        prompt = '[checks-only] deterministic preflight passed; no model request was made.'
        outcome = classifyOutcome({
          turnReason: { kind: 'completed' },
          agentError: undefined,
          timedOut: false,
          budgetExceeded: false,
          assistantText: JSON.stringify({
            status: 'ok',
            summary: '全部确定性检查通过（未调用模型）。',
            findings: [],
          }),
          checks: checkResults,
          defaultSeverity: defaultSeverityOf(task),
          hasTurn: true,
        })
      } else {
        const previous = previousState(task)
        prompt = buildMonitorPrompt({
          task,
          run,
          previous,
          checks: checkResults,
          now: new Date().toISOString(),
          maxChars: config.maxRunPromptChars,
        })
        const driven = await drive({ task, run, session, prompt, checkResults })
        outcome = driven.outcome
        assistantText = driven.assistantText
        run.usage = driven.usage
        if (
          ['result_missing', 'result_invalid'].includes(outcome.code) &&
          driven.timedOut !== true &&
          driven.budgetExceeded !== true
        ) {
          const repaired = await repair({ task, run, session, firstSeq: driven.firstSeq, previousText: assistantText })
          if (repaired !== undefined) {
            outcome = repaired.outcome
            assistantText = repaired.assistantText
            run.usage = repaired.usage
          }
        }
      }
    } catch (error) {
      outcome = {
        status: RUN_STATUS.MONITOR_ERROR,
        code: error?.code ?? 'runner_exception',
        message: `监控运行异常：${String(error?.message ?? error)}`,
        findings: findingsFromChecks(run.checks ?? []),
        summary: '',
        classification: { reason: error?.code ?? 'runner_exception' },
      }
    }

    const finishedAt = Date.now()
    active.delete(run.run_id)
    run.finished_at = new Date(finishedAt).toISOString()
    run.duration_ms = finishedAt - startedAt
    run.status = outcome.status
    run.code = outcome.code ?? null
    run.message = outcome.message ?? null
    run.summary = truncate(outcome.summary ?? run.summary ?? '', 4000)
    run.classification = outcome.classification ?? null
    run.findings = outcome.status === RUN_STATUS.ALERT ? outcome.findings ?? [] : []
    run.error = outcome.status === RUN_STATUS.MONITOR_ERROR
      ? { code: outcome.code ?? 'monitor_error', message: truncate(outcome.message ?? '', 4000) }
      : null

    // Normal runs archive; a failed archive is itself an exception.
    if (run.status === RUN_STATUS.NORMAL) {
      await recordSession(run, session)
      await sessions.dispose(session?.handle)
      run.session_disposed = true
      if (outcome.status === RUN_STATUS.NORMAL) {
        try {
          await sessions.archive(run.session_id)
          run.session_archived = true
        } catch (error) {
          run.status = RUN_STATUS.MONITOR_ERROR
          run.code = 'archive_failed'
          run.message = `正常执行完成但自动归档失败：${String(error?.message ?? error)}`
          run.error = { code: 'archive_failed', message: truncate(run.message, 4000) }
          run.classification = { reason: 'archive_failed' }
          run.summary = ''
        }
      }
    }

    if (run.status !== RUN_STATUS.NORMAL) {
      await recordSession(run, session)
      await sessions.dispose(session?.handle)
      run.session_disposed = true
    }

    try {
      const artifact = {
        run,
        task: pickTask(task),
        prompt: truncate(prompt, config.maxRunPromptChars),
        assistant_text: truncate(assistantText, 20000),
        checks: run.checks,
        findings: outcome.findings ?? [],
      }
      run.artifact_path = await store.writeArtifact(run.run_id, artifact)
    } catch (error) {
      logger.warn(`could not write the run artifact: ${String(error?.message ?? error)}`)
    }

    const nextRunAt = computeNext(task, { trigger: request.trigger, now: finishedAt, occurrenceEpoch })
    await store.transact((state) => {
      const index = state.runs.findIndex((candidate) => candidate.run_id === run.run_id)
      if (index === -1) state.runs.push(run)
      else state.runs[index] = run
      const live = state.tasks[task.task_id]
      if (live === undefined) return
      live.in_flight_run_id = null
      live.last_run_at = run.finished_at
      live.last_occurrence_at = occurrence ?? live.last_occurrence_at
      live.last_result = {
        run_id: run.run_id,
        status: run.status,
        code: run.code,
        summary: truncate(run.summary || run.message || '', 500),
        at: run.finished_at,
        session_id: run.session_id,
      }
      live.stats.runs = (live.stats.runs ?? 0) + 1
      if (run.status === RUN_STATUS.NORMAL) live.stats.normal = (live.stats.normal ?? 0) + 1
      else if (run.status === RUN_STATUS.ALERT) live.stats.alert = (live.stats.alert ?? 0) + 1
      else live.stats.monitor_error = (live.stats.monitor_error ?? 0) + 1
      live.stats.last_duration_ms = run.duration_ms
      live.stats.last_status = run.status
      const usage = live.stats.usage ?? emptyUsage()
      for (const key of Object.keys(usage)) usage[key] = (usage[key] ?? 0) + (run.usage?.[key] ?? 0)
      live.stats.usage = usage
      if (live.status === TASK_STATUS.ACTIVE) {
        if (nextRunAt === null) {
          live.status = TASK_STATUS.ENDED
          live.next_run_at = null
          live.enabled = false
        } else {
          live.next_run_at = new Date(nextRunAt).toISOString()
        }
      }
    })

    if (
      run.status === RUN_STATUS.MONITOR_ERROR &&
      attempt < totalAttempts &&
      RETRYABLE_CODES.has(run.code) &&
      store.getState().tasks[task.task_id]?.status === TASK_STATUS.ACTIVE
    ) {
      // Intermediate failure: hide this attempt's Session, wait the retry
      // backoff, and try the same occurrence again with a fresh Session.
      if (run.session_id !== null && run.session_archived !== true) {
        try {
          await sessions.archive(run.session_id)
          run.session_archived = true
        } catch (error) {
          logger.warn(`could not archive the superseded attempt Session: ${String(error?.message ?? error)}`)
        }
      }
      run.retry_scheduled = true
      await store.transact((state) => {
        const stored = state.runs.find((candidate) => candidate.run_id === run.run_id)
        if (stored !== undefined) stored.retry_scheduled = true
      })
      const delay = Math.min(5 * 60_000, Math.max(50, (task.retry_policy?.backoff_ms ?? 60_000) * attempt))
      await sleep(delay)
      if (stopped) return { outcome: run.status, run_id: run.run_id, code: run.code, retry_aborted: true }
      const fresh = store.getState().tasks[task.task_id]
      if (fresh === undefined || fresh.status !== TASK_STATUS.ACTIVE) {
        return { outcome: run.status, run_id: run.run_id, code: run.code, retry_aborted: true }
      }
      return executeInner(fresh, {
        trigger: request.trigger,
        occurrenceAt: occurrence,
        attempt: attempt + 1,
      })
    }

    if (run.status === RUN_STATUS.ALERT) {
      await alerts.raise({ task, run, conclusive: true, now: finishedAt })
      await alerts.deliverDue({ limit: 3 })
    } else if (run.status === RUN_STATUS.MONITOR_ERROR) {
      const synthetic = { ...run, findings: [monitorErrorFinding(run)] }
      await alerts.raise({ task, run: synthetic, conclusive: false, now: finishedAt })
      await alerts.deliverDue({ limit: 3 })
    } else {
      // A conclusive clean run resolves the task's open anomalies (and may send
      // a recovery notice when the task enables it).
      await alerts.raise({ task, run, conclusive: true, now: finishedAt })
      await alerts.deliverDue({ limit: 3 })
    }

    return {
      outcome: run.status,
      run_id: run.run_id,
      session_id: run.session_id,
      archived: run.session_archived,
      code: run.code,
      summary: run.summary,
    }
  }

  /** Run the monitor Agent through one or two turns and classify the durable result. */
  async function drive({ task, run, session, prompt }) {
    const agent = session.agent
    const firstSeq = agent.session.seq
    const usage = emptyUsage()
    let agentError
    let timedOut = false
    let budgetExceeded = false
    const deadline = Date.now() + task.timeout_ms

    const offError = ctx.on('agent/error', (payload) => {
      if (payload?.agent !== agent) return
      agentError = {
        message: String(payload.error?.message ?? payload.error ?? 'agent error'),
        code: payload.error?.code,
        atSeq: agent.session.seq,
      }
    })
    const offEvent = ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session) return
      if (event.type === 'assistant/message') {
        addUsage(usage, event.data?.usage)
        const budget = task.max_tokens_per_run ?? 0
        if (budget > 0 && usage.total > budget && budgetExceeded !== true) {
          budgetExceeded = true
          try {
            agent.cancel({ kind: 'isolated-monitor-budget' })
          } catch {
            // Cancellation is best effort; classification still reports the budget breach.
          }
        }
      }
      if (event.type === 'turn/end' && agentError !== undefined && event.seq >= (agentError.atSeq ?? 0)) {
        // A later committed terminal settles the earlier live failure.
        agentError = undefined
      }
    })
    const timer = setTimeout(() => {
      if (Date.now() < deadline) return
      timedOut = true
      try {
        agent.cancel({ kind: 'isolated-monitor-timeout' })
      } catch {
        // Already idle.
      }
    }, Math.max(1000, task.timeout_ms))
    timer.unref?.()

    try {
      const message = adapters.createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'isolated-monitor-run', taskId: task.task_id, runId: run.run_id },
      })
      agent.followup(message)
      const flushed = await ctx.sessions.flush(agent.session)
      if (flushed !== true) {
        throw Object.assign(new Error('Session persistence did not acknowledge the monitor prompt'), { code: 'prompt_flush_failed' })
      }
      await agent.whenIdle()
    } finally {
      clearTimeout(timer)
      offEvent()
      offError()
    }
    await ctx.sessions.flush(agent.session)

    const summary = summarize(agent.session, firstSeq)
    const outcome = classifyOutcome({
      turnReason: summary.turnReason,
      agentError,
      timedOut,
      budgetExceeded,
      assistantText: summary.assistantText,
      checks: run.checks ?? [],
      defaultSeverity: defaultSeverityOf(task),
      hasTurn: summary.hasTurn,
    })
    return { outcome, assistantText: summary.assistantText, usage, firstSeq, timedOut, budgetExceeded }
  }

  /** One bounded repair turn when the model forgot the JSON contract. */
  async function repair({ task, run, session, firstSeq, previousText }) {
    const agent = session.agent
    const timeout = Math.min(task.timeout_ms, 180_000)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        agent.cancel({ kind: 'isolated-monitor-repair-timeout' })
      } catch {
        // idle
      }
    }, timeout)
    timer.unref?.()
    try {
      const message = adapters.createUserMessage({
        content: [
          {
            type: 'text',
            text: buildRepairPrompt({ task, assistantText: previousText, maxChars: config.maxRunPromptChars }),
          },
        ],
        source: { kind: 'isolated-monitor-repair', taskId: task.task_id, runId: run.run_id },
      })
      agent.followup(message)
      await ctx.sessions.flush(agent.session)
      await agent.whenIdle()
    } catch (error) {
      logger.warn(`result repair turn failed: ${String(error?.message ?? error)}`)
      return undefined
    } finally {
      clearTimeout(timer)
    }
    if (timedOut) return undefined
    const summary = summarize(agent.session, firstSeq)
    const outcome = classifyOutcome({
      turnReason: summary.turnReason,
      agentError: undefined,
      timedOut: false,
      budgetExceeded: false,
      assistantText: summary.assistantText,
      checks: run.checks ?? [],
      defaultSeverity: defaultSeverityOf(task),
      hasTurn: summary.hasTurn,
    })
    return { outcome, assistantText: summary.assistantText, usage: emptyUsage() }
  }

  /** Fold the run interval into the last assistant text, terminal reason, and usage. */
  function summarize(session, firstSeq) {
    let assistantText = ''
    let turnReason
    let hasTurn = false
    for (let seq = firstSeq; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq)
      if (event === undefined) break
      if (event.type === 'turn/start') {
        hasTurn = true
        turnReason = undefined
        continue
      }
      if (!hasTurn) continue
      if (event.type === 'assistant/message') {
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
        if (text !== '') assistantText = text
      }
      if (event.type === 'turn/end') turnReason = event.data?.reason
    }
    return { assistantText, turnReason, hasTurn }
  }

  /** Persist one plugin record into the monitor Session before it is disposed. */
  async function recordSession(run, session) {
    if (session?.agent === undefined) return
    try {
      adapters.appendPluginRecord(session.agent.session, 'plugin:isolated-monitor/run', {
        runId: run.run_id,
        taskId: run.task_id,
        status: run.status,
        code: run.code,
        summary: truncate(run.summary || run.message || '', 1000),
        usage: run.usage,
        findings: run.findings.map((finding) => ({ type: finding.type, key: finding.object_key, severity: finding.severity })),
        finishedAt: run.finished_at,
      })
      await ctx.sessions.flush(session.agent.session)
    } catch (error) {
      logger.warn(`could not record the run outcome in the monitor Session: ${String(error?.message ?? error)}`)
    }
  }

  /** Structured previous state handed to the next run. */
  function previousState(task) {
    const state = store.getState()
    return {
      lastRunAt: task.last_run_at ?? null,
      status: task.last_result?.status ?? null,
      summary: task.last_result?.summary ?? '',
      events: state.events.filter((event) => event.task_id === task.task_id && event.status === 'open'),
    }
  }

  /** Next occurrence, or `null` when the schedule is finished. */
  function computeNext(task, { trigger, now, occurrenceEpoch }) {
    if (trigger === 'run_now') return task.next_run_at === null ? null : Date.parse(task.next_run_at)
    if (['once', 'after'].includes(task.schedule.kind)) return null
    try {
      return timing.nextOccurrence(task.schedule, {
        afterEpoch: now,
        lastOccurrenceEpoch: Number.isFinite(occurrenceEpoch) ? occurrenceEpoch : undefined,
      })
    } catch (error) {
      logger.warn(`cannot compute the next occurrence for ${task.task_id}: ${String(error?.message ?? error)}`)
      return null
    }
  }

  async function pauseTask(taskId, reason) {
    await store.transact((state) => {
      const task = state.tasks[taskId]
      if (task === undefined || task.status !== TASK_STATUS.ACTIVE) return
      task.status = TASK_STATUS.PAUSED
      task.enabled = false
      task.paused_reason = reason
      task.next_run_at = null
      task.updated_at = new Date().toISOString()
    })
  }

  /**
   * Notify the source Session about runs interrupted by a host stop, then mark
   * them handled so a restart never repeats the notification.
   */
  async function recoverInterrupted() {
    const interrupted = store
      .getState()
      .runs.filter(
        (run) => run.status === RUN_STATUS.MONITOR_ERROR && run.code === 'interrupted' && run.recovery_handled !== true,
      )
    for (const run of interrupted) {
      await store.transact((state) => {
        const record = state.runs.find((candidate) => candidate.run_id === run.run_id)
        if (record !== undefined) record.recovery_handled = true
      })
      const task = store.getState().tasks[run.task_id]
      if (task === undefined || task.status === TASK_STATUS.DELETED) continue
      try {
        await alerts.raise({
          task,
          run: { ...run, findings: [monitorErrorFinding(run)] },
          conclusive: false,
          now: Date.now(),
        })
      } catch (error) {
        logger.warn(`could not raise the interrupted-run alert: ${String(error?.message ?? error)}`)
      }
    }
    if (interrupted.length > 0) await alerts.deliverDue({ limit: 5 })
  }

  return { execute, recoverInterrupted, pauseTask, shutdown }

  /** Cancel and dispose every run this plugin still owns (plugin unload). */
  async function shutdown() {
    stopped = true
    const sessionsToStop = [...active.values()]
    active.clear()
    for (const entry of sessionsToStop) {
      try {
        entry.agent?.cancel?.({ kind: 'isolated-monitor-shutdown' })
      } catch {
        // Already idle.
      }
      await sessions.dispose(entry.handle)
    }
  }
}

function makeRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Monitor failures worth one more attempt; configuration/permission errors are not. */
const RETRYABLE_CODES = new Set([
  'timeout',
  'agent_error',
  'turn_error',
  'turn_aborted',
  'turn_max-tokens',
  'no_turn_end',
  'result_missing',
  'result_invalid',
  'result_inconsistent',
  'prompt_flush_failed',
  'runner_exception',
])

/** Sleep that does not keep the process alive and honours cancellation-free plugin unload. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

function pickTask(task) {
  return {
    task_id: task.task_id,
    name: task.name,
    project_path: task.project_path,
    schedule: task.schedule,
    source_session_id: task.source_session_id,
    allowed_operations: task.allowed_operations,
    alert_conditions: task.alert_conditions,
    timeout_ms: task.timeout_ms,
  }
}
