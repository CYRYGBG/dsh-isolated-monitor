/**
 * Model-facing management tools and the `/monitor` slash command.
 *
 * Every tool acts for the calling root Agent; `source_session_id` is always
 * read from that Agent's Session, never guessed from names or recent activity.
 * @module dsh-isolated-monitor/tools
 */
import { stat } from 'node:fs/promises'
import { hostTimeZone } from './clock.js'
import { normalizeModel, normalizeRules, normalizeChecks, createTaskRecord, isActiveTask, TASK_STATUS } from './state.js'
import { ScheduleError } from './timing.js'
import { isAbsolutePath, oneLine, truncate } from './util.js'

const SEVERITY_ENUM = ['low', 'medium', 'high', 'critical']
const MODE_ENUM = ['agent', 'hybrid']
const MANAGE_ACTIONS = [
  'update',
  'pause',
  'resume',
  'delete',
  'run_now',
  'retry_alerts',
  'retry_delivery',
  'unarchive_session',
  'archive_session',
]

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

const SCHEDULE_PARAMS = {
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: {
      type: 'string',
      required: true,
      enum: ['once', 'after', 'every', 'daily', 'weekly', 'cron', 'rrule'],
      description: 'Schedule kind. once/after run a single time; every/daily/weekly/cron/rrule repeat.',
    },
    at: { type: 'string', description: 'once: ISO instant with offset, e.g. 2026-11-14T09:00:00+08:00.' },
    after_seconds: { type: 'number', description: 'after: delay from creation, seconds.' },
    every_seconds: { type: 'number', description: 'every: fixed interval, at least 60 seconds.' },
    time: { type: 'string', description: 'daily/weekly: local clock time HH:mm.' },
    weekday: { type: 'number', description: 'weekly: ISO weekday 1=Monday … 7=Sunday.' },
    time_zone: { type: 'string', description: 'IANA zone for daily/weekly/cron, e.g. Asia/Shanghai.' },
    expression: { type: 'string', description: 'cron: five-field cron expression, e.g. */30 * * * *.' },
    rrule: { type: 'string', description: 'rrule: DTSTART line + newline + RRULE line.' },
  },
}

const MODEL_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    reasoning_effort: { type: 'string' },
    max_tokens: { type: 'number', description: 'Per-request output cap for the monitor Agent.' },
  },
}

const ALLOWED_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    write: { type: 'boolean', description: 'Explicitly authorise write operations. Default false (read-only).' },
    extra_tools: { type: 'array', items: { type: 'string' }, description: 'Additional tool names to expose.' },
    allow_network: { type: 'boolean', description: 'Allow web_fetch/web_search. Default true.' },
    commands: { type: 'array', items: { type: 'string' }, description: 'Allowed read-only command hints.' },
    notes: { type: 'string', description: 'Extra constraints for the monitor Agent.' },
  },
}

const CHECK_PARAMS = {
  type: 'array',
  description: 'Optional deterministic preflight checks executed by the host before any model request.',
  items: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string', required: true },
      kind: { type: 'string', required: true, enum: ['command', 'file_exists', 'file_match'] },
      title: { type: 'string' },
      severity: { type: 'string', enum: SEVERITY_ENUM },
      finding_type: { type: 'string' },
      command: { type: 'string' },
      shell: { type: 'string', enum: ['pwsh', 'bash'] },
      timeout_ms: { type: 'number' },
      expect_exit_code: { type: 'number' },
      stdout_includes: { type: 'string' },
      stdout_excludes: { type: 'string' },
      stdout_matches: { type: 'string' },
      path: { type: 'string' },
      exists: { type: 'boolean' },
      min_bytes: { type: 'number' },
      pattern: { type: 'string' },
      must_match: { type: 'boolean' },
      expect_failure: { type: 'boolean' },
    },
  },
}

/**
 * @param {{
 *   ctx: any,
 *   config: Record<string, any>,
 *   store: any,
 *   sessions: any,
 *   scheduler: any,
 *   alerts: any,
 *   timing: any,
 *   logger: {warn:Function, info:Function},
 *   adapters: { defineTool: Function },
 * }} options
 */
export function registerTools(options) {
  const { ctx, config, store, sessions, scheduler, alerts, timing, adapters } = options
  const defineTool = adapters.defineTool

  function requireRoot(exec) {
    const agent = exec?.agent
    if (agent === undefined) throw new Error('monitor tools require a calling Agent')
    if (ctx.agents.get(agent.id) !== agent) throw new Error('monitor tools require the exact live calling Agent')
    if (!ctx.agents.roots().includes(agent)) throw new Error('delegated subagents cannot manage monitor tasks')
    if (sessions.isMonitorSession(agent.session)) throw new Error('monitor sessions cannot manage monitor tasks')
    return agent
  }

  async function existingDirectory(path) {
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) throw new Error(`project_path is not an existing directory: ${path}`)
    return path
  }

  function scheduleContext(now) {
    return {
      now,
      defaultTimeZone: config.timeZone || hostTimeZone(),
    }
  }

  /** Build a task from tool input; shared by create and update. */
  async function createFromInput(input, agent) {
    const now = Date.now()
    const checks = input.checks ?? []
    const taskPrompt = typeof input.task_prompt === 'string' ? input.task_prompt.trim() : ''
    if (taskPrompt === '' && checks.length === 0) {
      throw new Error('task_prompt is required unless at least one deterministic check is provided')
    }
    const projectPath = input.project_path ?? agent.session.header.cwd
    if (!isAbsolutePath(projectPath)) throw new Error('project_path must be an absolute directory path')
    await existingDirectory(projectPath)
    const { schedule, firstAt } = timing.normalizeSchedule(input.schedule, scheduleContext(now))
    const task = createTaskRecord(
      { ...input, checks },
      {
        now,
        config,
        schedule,
        firstAt,
        sourceSessionId: agent.session.id,
        projectPath,
        defaultTimeZone: config.timeZone || hostTimeZone(),
      },
    )
    task.schedule_text = timing.describeSchedule(schedule)
    return task
  }

  async function updateTask(task, patch) {
    if (patch === undefined || patch === null || typeof patch !== 'object') throw new Error('patch must be an object')
    const now = Date.now()
    const changes = {}
    const allowedKeys = [
      'name',
      'task_prompt',
      'timeout_seconds',
      'retry_policy',
      'alert_rules',
      'severity',
      'model',
      'agent_preset',
      'allowed_operations',
      'checks',
      'execution_mode',
      'notify_on_recovery',
      'max_tokens_per_run',
      'enabled',
      'max_alerts_per_day',
      'skip_agent_on_pass',
      'project_path',
      'schedule',
    ]
    for (const key of Object.keys(patch)) {
      if (!allowedKeys.includes(key)) throw new Error(`patch key is not editable: ${key}`)
    }
    if (patch.project_path !== undefined) {
      if (!isAbsolutePath(patch.project_path)) throw new Error('project_path must be an absolute directory path')
      await existingDirectory(patch.project_path)
      changes.project_path = patch.project_path
    }
    if (patch.name !== undefined) changes.name = oneLine(patch.name, 120)
    if (patch.task_prompt !== undefined) changes.task_prompt = String(patch.task_prompt).trim()
    if (patch.timeout_seconds !== undefined) {
      changes.timeout_ms = clamp(Number(patch.timeout_seconds), 30, 86400) * 1000
    }
    if (patch.retry_policy !== undefined) {
      changes.retry_policy = {
        max_attempts: clamp(Number(patch.retry_policy?.max_attempts ?? task.retry_policy.max_attempts), 0, 10),
        backoff_ms: clamp(Number(patch.retry_policy?.backoff_seconds ?? task.retry_policy.backoff_ms / 1000), 5, 3600) * 1000,
      }
    }
    if (patch.alert_rules !== undefined) changes.alert_rules = normalizeRules(patch.alert_rules)
    if (patch.severity !== undefined) {
      if (!SEVERITY_ENUM.includes(patch.severity)) throw new Error(`severity must be one of ${SEVERITY_ENUM.join(', ')}`)
      changes.severity = patch.severity
    }
    if (patch.model !== undefined) changes.model = normalizeModel(patch.model)
    if (patch.agent_preset !== undefined) changes.agent_preset = String(patch.agent_preset ?? '').trim()
    if (patch.allowed_operations !== undefined) {
      changes.allowed_operations = {
        ...task.allowed_operations,
        ...(patch.allowed_operations.write === undefined ? {} : { write: patch.allowed_operations.write === true }),
        ...(patch.allowed_operations.allow_network === undefined
          ? {}
          : { allow_network: patch.allowed_operations.allow_network !== false }),
        ...(patch.allowed_operations.extra_tools === undefined
          ? {}
          : { extra_tools: patch.allowed_operations.extra_tools.filter((name) => typeof name === 'string') }),
        ...(patch.allowed_operations.commands === undefined
          ? {}
          : { commands: patch.allowed_operations.commands.filter((entry) => typeof entry === 'string') }),
        ...(patch.allowed_operations.notes === undefined ? {} : { notes: String(patch.allowed_operations.notes) }),
      }
    }
    if (patch.checks !== undefined) {
      changes.checks = normalizeChecks(patch.checks)
    }
    if (patch.execution_mode !== undefined) {
      if (!MODE_ENUM.includes(patch.execution_mode)) throw new Error(`execution_mode must be one of ${MODE_ENUM.join(', ')}`)
      changes.execution_mode = patch.execution_mode
    }
    if (patch.notify_on_recovery !== undefined) changes.notify_on_recovery = patch.notify_on_recovery === true
    if (patch.max_tokens_per_run !== undefined) changes.max_tokens_per_run = clamp(Number(patch.max_tokens_per_run), 0, 100_000_000)
    if (patch.max_alerts_per_day !== undefined) changes.max_alerts_per_day = clamp(Number(patch.max_alerts_per_day), 1, 10000)
    if (patch.skip_agent_on_pass !== undefined) changes.skip_agent_on_pass = patch.skip_agent_on_pass !== false
    if (patch.enabled !== undefined) changes.enabled = patch.enabled === true

    let schedule
    let firstAt
    if (patch.schedule !== undefined) {
      const normalized = timing.normalizeSchedule(patch.schedule, scheduleContext(now))
      schedule = normalized.schedule
      firstAt = normalized.firstAt
    }
    const updated = await store.transact((state) => {
      const live = state.tasks[task.task_id]
      if (live === undefined) throw new Error(`unknown task: ${task.task_id}`)
      if (changes.name !== undefined) live.name = changes.name
      if (changes.task_prompt !== undefined) live.task_prompt = changes.task_prompt
      if (changes.timeout_ms !== undefined) live.timeout_ms = changes.timeout_ms
      if (changes.retry_policy !== undefined) live.retry_policy = changes.retry_policy
      if (changes.alert_rules !== undefined) live.alert_conditions.rules = changes.alert_rules
      if (changes.severity !== undefined) live.alert_conditions.default_severity = changes.severity
      if (changes.notify_on_recovery !== undefined) live.alert_conditions.notify_on_recovery = changes.notify_on_recovery
      if (changes.model !== undefined) live.model = changes.model
      if (changes.agent_preset !== undefined) live.agent_preset = changes.agent_preset
      if (changes.allowed_operations !== undefined) live.allowed_operations = changes.allowed_operations
      if (changes.checks !== undefined) live.checks = changes.checks
      if (changes.execution_mode !== undefined) live.execution_mode = changes.execution_mode
      if (changes.max_tokens_per_run !== undefined) live.max_tokens_per_run = changes.max_tokens_per_run
      if (changes.max_alerts_per_day !== undefined) live.max_alerts_per_day = changes.max_alerts_per_day
      if (changes.skip_agent_on_pass !== undefined) live.skip_agent_on_pass = changes.skip_agent_on_pass
      if (changes.project_path !== undefined) live.project_path = changes.project_path
      if (schedule !== undefined) {
        live.schedule = schedule
        live.schedule_text = timing.describeSchedule(schedule)
        live.time_zone = schedule.time_zone ?? live.time_zone
        if (live.status === TASK_STATUS.ACTIVE) live.next_run_at = new Date(firstAt).toISOString()
      }
      if (changes.enabled !== undefined) {
        live.enabled = changes.enabled
        if (changes.enabled) {
          live.status = TASK_STATUS.ACTIVE
          live.paused_reason = null
          if (live.next_run_at === null || Date.parse(live.next_run_at) <= Date.now()) {
            live.next_run_at = new Date(Date.now() + 1000).toISOString()
          }
        } else {
          live.status = TASK_STATUS.PAUSED
          live.paused_reason = 'disabled_by_tool'
        }
      }
      live.updated_at = new Date().toISOString()
      return { ...live }
    })
    scheduler.arm()
    return updated
  }

  const tools = []

  tools.push(
    defineTool({
      name: 'monitor_create',
      description:
        'Create an isolated scheduled monitor. Every run opens a brand-new root Session that does not inherit this conversation, checks the project, archives itself when nothing is wrong, and only messages this conversation when an anomaly is found. Read-only by default.',
      parameters: {
        name: { type: 'string', required: true, description: 'Task name, at most 120 characters.' },
        task_prompt: {
          type: 'string',
          description: 'What to check on every run, including the anomaly conditions. Required unless checks are given.',
        },
        schedule: { ...SCHEDULE_PARAMS, required: true },
        project_path: {
          type: 'string',
          description: 'Absolute project directory to monitor. Defaults to this session working directory.',
        },
        checks: CHECK_PARAMS,
        execution_mode: {
          type: 'string',
          enum: MODE_ENUM,
          description:
            'agent: always run the model. hybrid: run deterministic checks first and skip the model when all pass.',
        },
        timeout_seconds: { type: 'number', description: 'Per-run timeout. Default 900.' },
        retry_policy: {
          type: 'object',
          additionalProperties: false,
          properties: {
            max_attempts: { type: 'number' },
            backoff_seconds: { type: 'number' },
          },
        },
        alert_rules: { type: 'array', items: { type: 'string' }, description: 'Anomaly conditions the agent must apply.' },
        severity: { type: 'string', enum: SEVERITY_ENUM, description: 'Default finding severity. Default high.' },
        model: MODEL_PARAMS,
        agent_preset: { type: 'string', description: 'Agent preset for the monitor Session. Default host preset.' },
        allowed_operations: ALLOWED_PARAMS,
        notify_on_recovery: { type: 'boolean', description: 'Send a recovery notice when an anomaly clears. Default false.' },
        max_tokens_per_run: { type: 'number', description: '0 or omitted means no token budget.' },
        enabled: { type: 'boolean', description: 'Create paused when false.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const agent = requireRoot(exec)
        const task = await createFromInput(args, agent)
        await store.transact((state) => {
          state.tasks[task.task_id] = task
        })
        scheduler.arm()
        return {
          created: summarizeTask(task, store.getState()),
          message: 'Monitor created. Every run uses a fresh isolated Session; open `/monitor` or monitor_view for status.',
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'monitor_list',
      description:
        'List isolated monitor tasks with status, next run, last result, token usage, and pending alerts. Omit active to list every task.',
      parameters: {
        active: { type: 'boolean', description: 'true: only scheduled tasks; false: only paused/ended; omitted: all.' },
        limit: { type: 'number' },
      },
      output: JSON_OUTPUT,
      execute(args, exec) {
        requireRoot(exec)
        const state = store.getState()
        const limit = clamp(Number(args.limit ?? 50), 1, 200)
        let tasks = Object.values(state.tasks).filter((task) => task.status !== TASK_STATUS.DELETED)
        if (args.active === true) tasks = tasks.filter(isActiveTask)
        if (args.active === false) tasks = tasks.filter((task) => !isActiveTask(task))
        tasks.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
        return {
          tasks: tasks.slice(0, limit).map((task) => summarizeTask(task, state)),
          total: tasks.length,
          plugin: { data_dir: store.dir, now: new Date().toISOString() },
        }
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'monitor_view',
      description:
        'Read one monitor task in detail: configuration, recent runs, open anomalies, and undelivered alert notifications.',
      parameters: {
        task_id: { type: 'string', required: true },
        include: {
          type: 'array',
          items: { type: 'string', enum: ['runs', 'events', 'deliveries', 'artifact'] },
        },
        limit: { type: 'number' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        requireRoot(exec)
        const state = store.getState()
        const task = state.tasks[args.task_id]
        if (task === undefined) throw new Error(`unknown task: ${args.task_id}`)
        const include = Array.isArray(args.include) && args.include.length > 0
          ? args.include
          : ['runs', 'events', 'deliveries']
        const limit = clamp(Number(args.limit ?? 10), 1, 50)
        const result = { task: summarizeTask(task, state) }
        if (include.includes('runs')) {
          result.runs = state.runs
            .filter((run) => run.task_id === task.task_id)
            .slice()
            .reverse()
            .slice(0, limit)
            .map(summarizeRun)
        }
        if (include.includes('events')) {
          result.events = state.events
            .filter((event) => event.task_id === task.task_id)
            .slice()
            .reverse()
            .slice(0, limit)
            .map(summarizeEvent)
        }
        if (include.includes('deliveries')) {
          result.deliveries = state.deliveries
            .filter((delivery) => delivery.task_id === task.task_id)
            .slice()
            .reverse()
            .slice(0, limit)
            .map(summarizeDelivery)
        }
        if (include.includes('artifact')) {
          const lastRun = state.runs.filter((run) => run.task_id === task.task_id).at(-1)
          result.artifact = lastRun === undefined ? null : await store.readArtifact(lastRun.run_id)
        }
        result.now = new Date().toISOString()
        return result
      },
    }),
  )

  tools.push(
    defineTool({
      name: 'monitor_manage',
      description:
        'Change a monitor task: update its configuration, pause, resume, delete (history retained), run once now, retry failed alert deliveries, or unarchive a monitor Session.',
      parameters: {
        task_id: { type: 'string', required: true },
        action: { type: 'string', required: true, enum: MANAGE_ACTIONS },
        patch: { type: 'object', additionalProperties: true, description: 'For update: editable task fields.' },
        delivery_id: { type: 'string', description: 'For retry_delivery.' },
        session_id: { type: 'string', description: 'For archive_session / unarchive_session.' },
      },
      output: JSON_OUTPUT,
      async execute(args, exec) {
        const agent = requireRoot(exec)
        const state = store.getState()
        const task = state.tasks[args.task_id]
        if (task === undefined) throw new Error(`unknown task: ${args.task_id}`)
        switch (args.action) {
          case 'update': {
            const updated = await updateTask(task, args.patch)
            return { updated: summarizeTask(updated, store.getState()) }
          }
          case 'pause': {
            const updated = await store.transact((current) => {
              const live = current.tasks[task.task_id]
              live.status = TASK_STATUS.PAUSED
              live.enabled = false
              live.paused_reason = 'paused_by_tool'
              live.updated_at = new Date().toISOString()
              return { ...live }
            })
            scheduler.arm()
            return { updated: summarizeTask(updated, store.getState()) }
          }
          case 'resume': {
            const updated = await store.transact((current) => {
              const live = current.tasks[task.task_id]
              live.status = TASK_STATUS.ACTIVE
              live.enabled = true
              live.paused_reason = null
              if (live.next_run_at === null || Date.parse(live.next_run_at) <= Date.now()) {
                live.next_run_at = new Date(Date.now() + 1000).toISOString()
              }
              live.updated_at = new Date().toISOString()
              return { ...live }
            })
            scheduler.arm()
            return { updated: summarizeTask(updated, store.getState()) }
          }
          case 'delete': {
            await store.transact((current) => {
              const live = current.tasks[task.task_id]
              live.status = TASK_STATUS.DELETED
              live.enabled = false
              live.deleted_at = new Date().toISOString()
              live.next_run_at = null
              live.in_flight_run_id = null
              for (const delivery of current.deliveries) {
                if (delivery.task_id === task.task_id && delivery.status === 'pending') {
                  delivery.status = 'failed'
                  delivery.last_error = 'task deleted before delivery'
                }
              }
            })
            scheduler.arm()
            return { deleted: task.task_id, note: 'Task configuration is disabled; runs, sessions, and history are retained.' }
          }
          case 'run_now': {
            if (scheduler.isRunning(task.task_id)) return { started: false, reason: 'already_in_flight' }
            void scheduler.runNow(task.task_id).catch(() => undefined)
            return {
              started: true,
              task_id: task.task_id,
              note: 'The run executes in a new isolated Session; check monitor_view shortly.',
            }
          }
          case 'retry_alerts': {
            const results = await alerts.retryTask(task.task_id)
            return { attempts: results }
          }
          case 'retry_delivery': {
            if (typeof args.delivery_id !== 'string') throw new Error('delivery_id is required')
            return await alerts.retry(args.delivery_id)
          }
          case 'unarchive_session': {
            const sessionId = args.session_id ?? task.last_result?.session_id
            if (typeof sessionId !== 'string') throw new Error('session_id is required')
            await sessions.unarchive(sessionId)
            return { unarchived: sessionId }
          }
          case 'archive_session': {
            const sessionId = args.session_id ?? task.last_result?.session_id
            if (typeof sessionId !== 'string') throw new Error('session_id is required')
            const known = state.runs.some((run) => run.session_id === sessionId && run.task_id === task.task_id)
            if (!known) throw new Error('only sessions produced by this task can be archived here')
            await sessions.archive(sessionId)
            return { archived: sessionId }
          }
          default:
            throw new Error(`unsupported action: ${String(args.action)}`)
        }
      },
    }),
  )

  const disposers = []
  const when = ({ agent }) => agent !== undefined && !sessions.isMonitorSession(agent.session)
  for (const tool of tools) {
    disposers.push(ctx.tools.register(tool, { when }))
  }
  return { tools: tools.map((tool) => tool.name), disposers }
}

function clamp(value, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Compact task view shared by list/view/command. */
export function summarizeTask(task, state) {
  const open = state.events.filter((event) => event.task_id === task.task_id && event.status === 'open').length
  const pending = state.deliveries.filter(
    (delivery) => delivery.task_id === task.task_id && delivery.status === 'pending',
  ).length
  return {
    task_id: task.task_id,
    name: task.name,
    status: task.status,
    enabled: task.enabled,
    project_path: task.project_path,
    source_session_id: task.source_session_id,
    schedule: task.schedule_text ?? task.schedule?.kind,
    time_zone: task.time_zone,
    next_run_at: task.next_run_at,
    last_run_at: task.last_run_at,
    last_result: task.last_result,
    execution_mode: task.execution_mode,
    checks: task.checks?.length ?? 0,
    timeout_ms: task.timeout_ms,
    model: task.model,
    read_only: task.allowed_operations?.write !== true,
    notify_on_recovery: task.alert_conditions?.notify_on_recovery === true,
    open_alerts: open,
    pending_alerts: pending,
    paused_reason: task.paused_reason ?? null,
    stats: {
      runs: task.stats?.runs ?? 0,
      normal: task.stats?.normal ?? 0,
      alert: task.stats?.alert ?? 0,
      monitor_error: task.stats?.monitor_error ?? 0,
      tokens: task.stats?.usage?.total ?? 0,
      last_duration_ms: task.stats?.last_duration_ms ?? null,
    },
  }
}

export function summarizeRun(run) {
  return {
    run_id: run.run_id,
    status: run.status,
    code: run.code,
    trigger: run.trigger,
    occurrence_at: run.occurrence_at,
    started_at: run.started_at,
    finished_at: run.finished_at,
    duration_ms: run.duration_ms,
    session_id: run.session_id,
    session_archived: run.session_archived,
    usage: run.usage,
    summary: truncate(run.summary || run.message || '', 800),
    findings: (run.findings ?? []).map((finding) => ({
      key: finding.object_key,
      type: finding.type,
      severity: finding.severity,
      title: finding.title,
    })),
    artifact_path: run.artifact_path,
  }
}

export function summarizeEvent(event) {
  return {
    event_id: event.event_id,
    type: event.type,
    object_key: event.object_key,
    severity: event.severity,
    status: event.status,
    title: event.title,
    first_seen_at: event.first_seen_at,
    last_seen_at: event.last_seen_at,
    occurrence_count: event.occurrence_count,
    notify_count: event.notify_count,
    last_notified_at: event.last_notified_at,
    session_id: event.session_id,
  }
}

export function summarizeDelivery(delivery) {
  return {
    delivery_id: delivery.delivery_id,
    alert_event_id: delivery.alert_event_id,
    status: delivery.status,
    attempts: delivery.attempts,
    target_session_id: delivery.target_session_id,
    next_attempt_at: delivery.next_attempt_at,
    delivered_at: delivery.delivered_at,
    message_id: delivery.message_id,
    last_error: delivery.last_error,
    blocked_reason: delivery.blocked_reason,
    title: delivery.title,
    kind: delivery.kind,
  }
}

/**
 * Register the human `/monitor` command.
 * @param {{ctx:any, store:any, scheduler:any, alerts:any, sessions:any, config:Record<string,any>}} options
 */
export function registerCommand({ ctx, store, scheduler, alerts, sessions, config }) {
  if (config.enableCommand !== true) return undefined
  const commands = ctx.commands
  if (commands === undefined) return undefined
  return commands.register({
    name: 'monitor',
    description: '查看或管理独立会话监控任务',
    input: { hint: '[list | <task-id> | run|pause|resume|delete <task-id> | alerts | retry <task-id>]' },
    async handler({ agent, rawInput }) {
      if (agent === undefined) return { kind: 'error', text: 'monitor requires an active session' }
      if (sessions.isMonitorSession(agent.session)) {
        return { kind: 'error', text: '监控会话内不能管理监控任务。' }
      }
      const [verb = 'list', ...rest] = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
      const arg = rest[0]
      try {
        if (verb === 'help') return { kind: 'success', text: commandHelp() }
        if (verb === 'list') return { kind: 'success', text: renderTaskList(store, sessions, config) }
        if (verb === 'alerts') return { kind: 'success', text: renderAlerts(store) }
        if (['run', 'pause', 'resume', 'delete', 'retry'].includes(verb)) {
          if (arg === undefined) return { kind: 'error', text: `用法：/monitor ${verb} <task-id>` }
          const task = store.getState().tasks[arg]
          if (task === undefined) return { kind: 'error', text: `未知任务：${arg}` }
          if (verb === 'run') {
            void scheduler.runNow(arg).catch(() => undefined)
            return { kind: 'success', text: `已触发 ${arg} 的独立监控运行；稍后用 /monitor 或 monitor_view 查看。` }
          }
          if (verb === 'pause' || verb === 'resume') {
            const now = new Date().toISOString()
            await store.transact((state) => {
              const live = state.tasks[arg]
              live.status = verb === 'pause' ? TASK_STATUS.PAUSED : TASK_STATUS.ACTIVE
              live.enabled = verb === 'resume'
              live.paused_reason = verb === 'pause' ? 'paused_by_command' : null
              if (verb === 'resume' && (live.next_run_at === null || Date.parse(live.next_run_at) <= Date.now())) {
                live.next_run_at = new Date(Date.now() + 1000).toISOString()
              }
              live.updated_at = now
            })
            scheduler.arm()
            return { kind: 'success', text: `${arg} 已${verb === 'pause' ? '暂停' : '恢复'}。` }
          }
          if (verb === 'delete') {
            await store.transact((state) => {
              const live = state.tasks[arg]
              live.status = TASK_STATUS.DELETED
              live.enabled = false
              live.deleted_at = new Date().toISOString()
              live.next_run_at = null
              for (const delivery of state.deliveries) {
                if (delivery.task_id === arg && delivery.status === 'pending') {
                  delivery.status = 'failed'
                  delivery.last_error = 'task deleted before delivery'
                }
              }
            })
            scheduler.arm()
            return { kind: 'success', text: `${arg} 已删除（运行历史与会话保留）。` }
          }
          const results = await alerts.retryTask(arg)
          return {
            kind: 'success',
            text: `已尝试重投 ${results.length} 条：${results.map((entry) => `${entry.delivery_id}=${entry.status}`).join(', ') || '无待投递'}`,
          }
        }
        if (store.getState().tasks[verb] !== undefined) {
          return { kind: 'success', text: renderTaskDetail(store, verb) }
        }
        return { kind: 'error', text: `未知命令：${verb}\n${commandHelp()}` }
      } catch (error) {
        return { kind: 'error', text: `monitor 失败：${String(error?.message ?? error)}` }
      }
    },
  })
}

function commandHelp() {
  return [
    '用法：',
    '/monitor                     列出任务',
    '/monitor <task-id>           查看任务详情',
    '/monitor run <task-id>       立即执行一次（独立会话）',
    '/monitor pause <task-id>     暂停',
    '/monitor resume <task-id>    恢复',
    '/monitor delete <task-id>    删除配置（历史保留）',
    '/monitor alerts              查看未恢复异常',
    '/monitor retry <task-id>     重投失败通知',
  ].join('\n')
}

function renderTaskList(store, sessions, config) {
  const state = store.getState()
  const tasks = Object.values(state.tasks).filter((task) => task.status !== TASK_STATUS.DELETED)
  if (tasks.length === 0) return `暂无监控任务。\n数据目录：${store.dir}`
  const lines = [`监控任务（${tasks.length}）`, '']
  for (const task of tasks) {
    const view = summarizeTask(task, state)
    lines.push(
      `• ${view.name}  \`${view.task_id}\``,
      `  状态 ${view.status} · ${view.schedule} · 下次 ${view.next_run_at ?? '—'}`,
      `  运行 ${view.stats.runs}（正常 ${view.stats.normal} / 异常 ${view.stats.alert} / 错误 ${view.stats.monitor_error}）· tokens ${view.stats.tokens}`,
      `  未恢复异常 ${view.open_alerts} · 待投递 ${view.pending_alerts} · 来源会话 \`${view.source_session_id}\``,
    )
  }
  lines.push('', `数据目录：${store.dir}（时区 ${config.timeZone || hostTimeZone()}）`)
  return lines.join('\n')
}

function renderTaskDetail(store, taskId) {
  const state = store.getState()
  const task = state.tasks[taskId]
  const runs = state.runs.filter((run) => run.task_id === taskId).slice(-3).reverse()
  const events = state.events.filter((event) => event.task_id === taskId && event.status === 'open')
  const lines = [
    `任务 ${task.name} (\`${task.task_id}\`)`,
    `状态：${task.status}${task.paused_reason ? `（${task.paused_reason}）` : ''}`,
    `调度：${task.schedule_text} · 时区 ${task.time_zone}`,
    `下次：${task.next_run_at ?? '—'} · 上次：${task.last_run_at ?? '—'}`,
    `项目：${task.project_path}`,
    `来源会话：\`${task.source_session_id}\`（异常通知目标）`,
    `只读：${task.allowed_operations.write === true ? '否（已授权写）' : '是'}`,
    `最近运行：`,
    ...(runs.length === 0
      ? ['  （无）']
      : runs.map(
          (run) =>
            `  ${run.started_at} ${run.status}${run.code ? `(${run.code})` : ''} · ${run.duration_ms ?? '—'}ms · session \`${run.session_id ?? '—'}\`${run.session_archived ? ' · 已归档' : ''}`,
        )),
    `未恢复异常：${events.length}`,
    ...events.map((event) => `  [${event.severity}] ${event.title} (${event.occurrence_count} 次)`),
  ]
  return lines.join('\n')
}

function renderAlerts(store) {
  const state = store.getState()
  const open = state.events.filter((event) => event.status === 'open')
  if (open.length === 0) return '当前没有未恢复的监控异常。'
  return open
    .map(
      (event) =>
        `• [${event.severity}] ${event.title}\n  任务 ${event.task_id} · ${event.type} · 第 ${event.occurrence_count} 次 · 最近 ${event.last_seen_at}\n  会话 \`${event.session_id ?? '—'}\``,
    )
    .join('\n')
}

