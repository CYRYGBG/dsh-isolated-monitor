/**
 * Durable record shapes and pure normalization for tasks, runs, alert events,
 * and alert deliveries.
 * @module dsh-isolated-monitor/state
 */
import { cloneJson, isPlainObject, newAlertId, newRunId, newTaskId, oneLine, shortHash, truncate } from './util.js'

export const STATE_VERSION = 1
export const RUN_STATUS = Object.freeze({
  RUNNING: 'running',
  NORMAL: 'normal',
  ALERT: 'alert',
  MONITOR_ERROR: 'monitor_error',
})
export const TASK_STATUS = Object.freeze({ ACTIVE: 'active', PAUSED: 'paused', ENDED: 'ended', DELETED: 'deleted' })
export const EXECUTION_MODES = ['agent', 'hybrid']
export const SEVERITIES = ['low', 'medium', 'high', 'critical']
export const FINDING_TYPES = [
  'process_exit',
  'training_interrupted',
  'cuda_oom',
  'test_failure',
  'log_error',
  'missing_file',
  'unexpected_change',
  'service_unhealthy',
  'regression',
  'manual_review',
  'monitor_error',
  'other',
]

/** Empty durable state. */
export function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: {},
    runs: [],
    events: [],
    deliveries: [],
    stats: { runs: 0, normal: 0, alert: 0, monitor_error: 0 },
  }
}

/** Severity ordering for escalation decisions. */
export function severityRank(severity) {
  const index = SEVERITIES.indexOf(severity)
  return index === -1 ? 1 : index
}

/**
 * Build a complete task record from validated input.
 * @param {Record<string, unknown>} input
 * @param {{now:number, config:Record<string,unknown>, schedule:Record<string,unknown>, firstAt:number, sourceSessionId:string, projectPath:string, defaultTimeZone:string}} context
 * @returns {Record<string, unknown>}
 */
export function createTaskRecord(input, context) {
  const { now, config, schedule, firstAt, sourceSessionId, projectPath, defaultTimeZone } = context
  const createdAt = new Date(now).toISOString()
  const timeoutSeconds = clampInt(input.timeout_seconds, config.defaultTimeoutSeconds, 30, 86400)
  const retry = isPlainObject(input.retry_policy) ? input.retry_policy : {}
  const allowed = isPlainObject(input.allowed_operations) ? input.allowed_operations : {}
  const model = normalizeModel(input.model)
  const checks = normalizeChecks(input.checks)
  const executionMode = EXECUTION_MODES.includes(input.execution_mode)
    ? input.execution_mode
    : checks.length > 0
      ? 'hybrid'
      : 'agent'
  return {
    task_id: newTaskId(),
    name: oneLine(input.name, 120) || '未命名监控任务',
    task_prompt: typeof input.task_prompt === 'string' ? input.task_prompt.trim() : '',
    source_session_id: sourceSessionId,
    project_path: projectPath,
    schedule,
    schedule_text: '',
    time_zone: schedule.time_zone ?? defaultTimeZone,
    model,
    agent_preset: typeof input.agent_preset === 'string' && input.agent_preset.trim() !== ''
      ? input.agent_preset.trim()
      : config.defaultAgentPreset || '',
    timeout_ms: timeoutSeconds * 1000,
    retry_policy: {
      max_attempts: clampInt(retry.max_attempts, config.defaultRetryMaxAttempts, 0, 10),
      backoff_ms: clampInt(retry.backoff_seconds, config.defaultRetryBaseSeconds, 5, 3600) * 1000,
    },
    alert_conditions: {
      rules: normalizeRules(input.alert_rules ?? input.alert_conditions),
      default_severity: SEVERITIES.includes(input.severity) ? input.severity : 'high',
      notify_on_recovery: input.notify_on_recovery === true,
    },
    allowed_operations: {
      write: allowed.write === true,
      extra_tools: Array.isArray(allowed.extra_tools)
        ? allowed.extra_tools.filter((name) => typeof name === 'string' && name.trim() !== '').map((name) => name.trim())
        : [],
      allow_network: allowed.allow_network !== false,
      commands: Array.isArray(allowed.commands)
        ? allowed.commands.filter((entry) => typeof entry === 'string').map(oneLine)
        : [],
      notes: typeof allowed.notes === 'string' ? truncate(allowed.notes, 2000) : '',
    },
    checks,
    execution_mode: executionMode,
    skip_agent_on_pass: input.skip_agent_on_pass !== false,
    max_tokens_per_run: clampInt(input.max_tokens_per_run, 0, 0, 100_000_000),
    max_alerts_per_day: clampInt(input.max_alerts_per_day, config.maxAlertsPerDay, 1, 10000),
    enabled: input.enabled !== false,
    status: input.enabled === false ? TASK_STATUS.PAUSED : TASK_STATUS.ACTIVE,
    created_at: createdAt,
    updated_at: createdAt,
    next_run_at: new Date(firstAt).toISOString(),
    last_run_at: null,
    last_occurrence_at: null,
    last_result: null,
    in_flight_run_id: null,
    paused_reason: null,
    deleted_at: null,
    stats: {
      runs: 0,
      normal: 0,
      alert: 0,
      monitor_error: 0,
      usage: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
      last_duration_ms: null,
      last_status: null,
    },
  }
}

/** Normalize an optional model override. */
export function normalizeModel(value) {
  if (!isPlainObject(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return null
  return {
    provider,
    model,
    ...(typeof value.reasoning_effort === 'string' && value.reasoning_effort !== ''
      ? { reasoning_effort: value.reasoning_effort }
      : {}),
    ...(Number.isFinite(Number(value.max_tokens)) ? { max_tokens: Math.trunc(Number(value.max_tokens)) } : {}),
  }
}

/** Normalize alert rules: one string per line, or an array of strings. */
export function normalizeRules(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('\n')
      : []
  return list
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter((line) => line !== '')
    .slice(0, 30)
    .map((line) => truncate(line, 500))
}

/** Normalize deterministic preflight checks; invalid entries are dropped. */
export function normalizeChecks(value) {
  if (!Array.isArray(value)) return []
  const checks = []
  for (const raw of value.slice(0, 20)) {
    if (!isPlainObject(raw)) continue
    const kind = raw.kind
    if (!['command', 'file_exists', 'file_match'].includes(kind)) continue
    const id = oneLine(raw.id ?? raw.name ?? `${kind}-${checks.length + 1}`, 60).replace(/[^\w.-]+/g, '-')
    const base = {
      id,
      kind,
      severity: SEVERITIES.includes(raw.severity) ? raw.severity : 'high',
      title: oneLine(raw.title ?? id, 160),
      expect_failure: raw.expect_failure === true,
      finding_type: FINDING_TYPES.includes(raw.finding_type) ? raw.finding_type : 'other',
    }
    if (kind === 'command') {
      const command = typeof raw.command === 'string' ? raw.command.trim() : ''
      if (command === '') continue
      checks.push({
        ...base,
        command: truncate(command, 4000),
        shell: raw.shell === 'bash' ? 'bash' : 'pwsh',
        timeout_ms: clampInt(raw.timeout_ms, 120_000, 1000, 900_000),
        expect_exit_code: Number.isInteger(raw.expect_exit_code) ? raw.expect_exit_code : 0,
        stdout_includes: typeof raw.stdout_includes === 'string' ? raw.stdout_includes : '',
        stdout_excludes: typeof raw.stdout_excludes === 'string' ? raw.stdout_excludes : '',
        stdout_matches: typeof raw.stdout_matches === 'string' ? raw.stdout_matches : '',
      })
    } else if (kind === 'file_exists') {
      const path = typeof raw.path === 'string' ? raw.path.trim() : ''
      if (path === '') continue
      checks.push({ ...base, path, exists: raw.exists !== false, min_bytes: clampInt(raw.min_bytes, 0, 0, Number.MAX_SAFE_INTEGER) })
    } else {
      const path = typeof raw.path === 'string' ? raw.path.trim() : ''
      const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim() : ''
      if (path === '' || pattern === '') continue
      checks.push({ ...base, path, pattern: truncate(pattern, 1000), must_match: raw.must_match === true })
    }
  }
  return checks
}

/** Create a running run record (persisted before the session is created). */
export function createRunRecord({ task, runId = newRunId(), trigger, occurrenceAt, model, attempt = 1 }) {
  const now = new Date().toISOString()
  return {
    run_id: runId,
    task_id: task.task_id,
    task_name: task.name,
    trigger,
    attempt,
    occurrence_at: occurrenceAt ?? null,
    started_at: now,
    finished_at: null,
    status: RUN_STATUS.RUNNING,
    code: null,
    message: null,
    session_id: null,
    session_archived: false,
    session_disposed: false,
    model: model ?? null,
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
  }
}

/** Zeroed usage counters. */
export function emptyUsage() {
  return { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0, reasoning: 0 }
}

/** Extract and aggregate the recognized usage fields of one `usage` payload. */
export function addUsage(target, usage) {
  if (!isPlainObject(usage)) return target
  const pick = (...names) => {
    for (const name of names) {
      const value = usage[name]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return 0
  }
  const input = pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens')
  const output = pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens')
  target.input += input
  target.output += output
  target.total += pick('totalTokens', 'total_tokens') || input + output
  target.cache_read += pick('cacheReadTokens', 'cache_read_tokens', 'cachedInputTokens')
  target.cache_write += pick('cacheWriteTokens', 'cache_write_tokens')
  target.reasoning += pick('reasoningTokens', 'reasoning_tokens')
  return target
}

/**
 * Create one alert event from a finding.
 * @param {{taskId:string, finding:Record<string,unknown>, runId:string, now:number, sessionId:string|null}} context
 * @returns {Record<string, unknown>}
 */
export function createAlertEvent({ taskId, finding, runId, now, sessionId }) {
  const timestamp = new Date(now).toISOString()
  return {
    event_id: newAlertId(),
    task_id: taskId,
    type: finding.type,
    object_key: finding.object_key,
    event_key: `${finding.type}\u0000${finding.object_key}`,
    severity: finding.severity,
    title: finding.title,
    status: 'open',
    first_seen_at: timestamp,
    last_seen_at: timestamp,
    resolved_at: null,
    occurrence_count: 1,
    notify_count: 0,
    last_notified_at: null,
    last_notified_severity: null,
    run_ids: [runId],
    session_id: sessionId,
    evidence: finding.evidence,
    location: finding.location,
    suggestion: finding.suggestion,
  }
}

/** Bounded delivery record for one alert notification attempt set. */
export function createDeliveryRecord({ alertEvent, task, run, targetSessionId, dedupeKey, text }) {
  const now = new Date().toISOString()
  return {
    delivery_id: `del-${shortHash(`${alertEvent.event_id}:${targetSessionId}:${now}`)}`,
    alert_event_id: alertEvent.event_id,
    task_id: task.task_id,
    run_id: run.run_id,
    target_session_id: targetSessionId,
    dedupe_key: dedupeKey,
    status: 'pending',
    attempts: 0,
    created_at: now,
    last_attempt_at: null,
    next_attempt_at: now,
    delivered_at: null,
    message_id: null,
    last_error: null,
    blocked_reason: null,
    severity: alertEvent.severity,
    title: alertEvent.title,
    text,
    monitor_session_id: run.session_id,
  }
}

/** `true` when a task is scheduled (active) rather than paused/ended/deleted. */
export function isActiveTask(task) {
  return task.status === TASK_STATUS.ACTIVE && task.enabled === true
}

/**
 * Repair loaded state: unknown shapes are dropped, counters are recomputed from
 * retained runs, and stale in-flight markers become explicit interruptions.
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeLoadedState(raw) {
  const state = emptyState()
  if (!isPlainObject(raw)) return state
  if (isPlainObject(raw.tasks)) {
    for (const [id, task] of Object.entries(raw.tasks)) {
      if (!isPlainObject(task) || typeof task.task_id !== 'string') continue
      state.tasks[id] = normalizeTask(task)
    }
  }
  if (Array.isArray(raw.runs)) {
    state.runs = raw.runs.filter(isPlainObject).map(normalizeRun).filter(Boolean)
  }
  if (Array.isArray(raw.events)) {
    state.events = raw.events.filter(isPlainObject).map(normalizeEvent).filter(Boolean)
  }
  if (Array.isArray(raw.deliveries)) {
    state.deliveries = raw.deliveries.filter(isPlainObject).map(normalizeDelivery).filter(Boolean)
  }
  state.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : state.createdAt
  state.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : state.updatedAt
  return state
}

function normalizeTask(task) {
  const copy = cloneJson(task)
  copy.retry_policy ??= { max_attempts: 0, backoff_ms: 60000 }
  copy.alert_conditions ??= { rules: [], default_severity: 'high', notify_on_recovery: false }
  copy.allowed_operations ??= { write: false, extra_tools: [], allow_network: true, commands: [], notes: '' }
  copy.checks = Array.isArray(copy.checks) ? copy.checks : []
  copy.stats ??= {}
  copy.stats.usage ??= emptyUsage()
  copy.in_flight_run_id ??= null
  copy.last_result ??= null
  return copy
}

function normalizeRun(run) {
  if (typeof run.run_id !== 'string' || typeof run.task_id !== 'string') return undefined
  const copy = cloneJson(run)
  copy.usage ??= emptyUsage()
  copy.findings = Array.isArray(copy.findings) ? copy.findings : []
  copy.checks = Array.isArray(copy.checks) ? copy.checks : []
  if (copy.status === RUN_STATUS.RUNNING) {
    copy.status = RUN_STATUS.MONITOR_ERROR
    copy.code = 'interrupted'
    copy.message = 'Host stopped before the run finished'
    copy.finished_at = copy.finished_at ?? new Date().toISOString()
  }
  return copy
}

function normalizeEvent(event) {
  if (typeof event.event_id !== 'string' || typeof event.task_id !== 'string') return undefined
  const copy = cloneJson(event)
  copy.event_key ??= `${copy.type}\u0000${copy.object_key}`
  copy.run_ids = Array.isArray(copy.run_ids) ? copy.run_ids : []
  copy.occurrence_count = Number.isInteger(copy.occurrence_count) ? copy.occurrence_count : 1
  return copy
}

function normalizeDelivery(delivery) {
  if (typeof delivery.delivery_id !== 'string' || typeof delivery.target_session_id !== 'string') return undefined
  const copy = cloneJson(delivery)
  copy.attempts = Number.isInteger(copy.attempts) ? copy.attempts : 0
  copy.status = ['pending', 'delivered', 'failed'].includes(copy.status) ? copy.status : 'pending'
  return copy
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  const base = Number.isFinite(n) ? Math.trunc(n) : Number(fallback)
  if (!Number.isFinite(base)) return min
  return Math.min(max, Math.max(min, base))
}
