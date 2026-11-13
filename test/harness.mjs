/**
 * Test harness: a small but faithful fake of the harness surfaces the plugin
 * uses (agents, sessions, documents, tools, workspace registry, controller).
 *
 * Everything here is in-memory except the plugin state store, which uses a real
 * temporary directory so persistence and restart behavior are exercised.
 */
import { mkdtemp, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAlertRouter } from '../src/alerts.js'
import { createCheckRunner } from '../src/checks.js'
import { normalizeConfig } from '../src/config.js'
import { createRunner } from '../src/runner.js'
import { createScheduler } from '../src/scheduler.js'
import { createSessionManager } from '../src/sessions.js'
import { createStore } from '../src/store.js'
import { createTiming } from '../src/timing.js'
import { registerTools } from '../src/tools.js'

export const TEST_TOOLS = [
  'read',
  'read_image',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'web_fetch',
  'web_search',
  'job_list',
  'job_output',
  'working_directory',
  'write',
  'edit',
  'apply_patch',
  'subagent',
  'workflow',
  'ask_user_question',
  'present',
  'todo_write',
]

/** A simple atomic-ish write for tests (temp sibling + rename). */
export async function testWriteFileAtomic(path, content, options = {}) {
  await mkdir(join(path, '..'), { recursive: true, mode: options.dirMode })
  const temp = `${path}.${Math.random().toString(16).slice(2)}.tmp`
  await writeFile(temp, content, { mode: options.mode })
  await rename(temp, path)
}

export class FakeSession {
  constructor(id, header = {}) {
    this.header = { id, ...header }
    this.log = []
    this.seq = 0
    this.onAppend = undefined
  }

  get id() {
    return this.header.id
  }

  append(type, data) {
    const event = {
      type,
      data,
      seq: this.seq,
      time: new Date().toISOString(),
      ...(type.startsWith('plugin:') ? { ignorable: true } : {}),
    }
    this.log.push(event)
    this.seq += 1
    this.onAppend?.(event)
    return event.seq
  }

  eventAt(seq) {
    return this.log[seq]
  }
}

export class FakeAgent {
  constructor({ id, cwd, behavior, ctx }) {
    this.id = id
    this.session = new FakeSession(id, { cwd })
    this.inbox = []
    this.status = 'idle'
    this.ctx = makeAgentContext(this, ctx)
    this.behavior = behavior ?? normalBehavior
    this.ctxWorld = ctx
    this.cancelled = false
    this.cancelCause = undefined
    this.prompts = []
    this.session.onAppend = (event) => ctx.emit('session/event', this.session, event)
  }

  followup(message) {
    this.inbox.push(message)
    if (this.running === undefined) this.running = this.loop()
  }

  async loop() {
    while (this.inbox.length > 0) {
      const message = this.inbox.shift()
      this.prompts.push(message)
      this.status = 'running'
      this.cancelled = false
      this.release = undefined
      this.session.append('user/message', { message, source: message.source })
      try {
        await this.behavior({ agent: this, message })
      } finally {
        this.status = 'idle'
      }
    }
    this.running = undefined
  }

  whenIdle() {
    return this.running ?? Promise.resolve()
  }

  cancel(cause) {
    this.cancelCause = cause
    this.cancelled = true
    this.release?.()
  }
}

export async function normalBehavior({ agent, message }) {
  agent.session.append('turn/start', { turn: 0 })
  const text = typeof agent.behaviorText === 'string' ? agent.behaviorText : DEFAULT_REPORT
  agent.session.append('assistant/message', {
    turn: 0,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  })
  agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
}

export const DEFAULT_REPORT = [
  '检查完成。',
  '```json',
  JSON.stringify({ status: 'ok', summary: '训练进程与日志正常', findings: [] }),
  '```',
].join('\n')

function makeAgentContext(agent, world) {
  const scope = { kind: 'agent', id: agent.id }
  const service = () => (world.get ? world.get('tools') : world.toolsService)
  return {
    __scope: scope,
    tools: {
      definitions: () => service().definitions(scope),
      restrict: (filter) => service().restrict(scope, filter),
      execute: (input) => service().execute(input),
    },
    systemPrompt: {
      section: (section) => {
        agent.promptSection = section
      },
    },
  }
}

export function createToolsService({ logger } = {}) {
  const registrations = new Map()
  const restrictions = new Map()
  const visibility = (scope) => {
    const restricted = restrictions.get(scope.id)
    let names = [...registrations.keys()]
    if (restricted !== undefined) {
      if (restricted.allow !== undefined) names = names.filter((name) => restricted.allow.includes(name))
      if (restricted.deny !== undefined) names = names.filter((name) => !restricted.deny.includes(name))
    }
    return names.map((name) => ({ name }))
  }
  return {
    register(definition, options = {}) {
      registrations.set(definition.name, { definition, options })
      return () => registrations.delete(definition.name)
    },
    definitions(scope) {
      let names = TEST_TOOLS
      const restricted = restrictions.get(scope.id)
      if (restricted !== undefined) {
        if (restricted.allow !== undefined) names = names.filter((name) => restricted.allow.includes(name))
        if (restricted.deny !== undefined) names = names.filter((name) => !restricted.deny.includes(name))
      }
      return names.map((name) => ({ name }))
    },
    restrict(scope, filter) {
      const known = new Set(TEST_TOOLS)
      const named = [...(filter.allow ?? []), ...(filter.deny ?? [])]
      const unknown = named.filter((name) => !known.has(name) && !registrations.has(name))
      if (unknown.length > 0) throw new Error(`tools.restrict() names unknown tools: ${unknown.join(', ')}`)
      restrictions.set(scope.id, filter)
    },
    setResult(name, result) {
      this.canned = this.canned ?? new Map()
      this.canned.set(name, result)
    },
    async execute(input) {
      const call = input.calls[0]
      const canned = this.canned?.get(call.name)
      const result = typeof canned === 'function' ? canned(call) : canned
      return { results: [{ block: call, result: result ?? { isError: true, error: { message: 'no canned result' } } }] }
    },
    registrations,
    restrictions,
    visibility,
  }
}

/**
 * Build one complete plugin runtime over fakes.
 * @param {{config?:Record<string,any>, projectDir?:string, behavior?:Function, targets?:Record<string,any>}} options
 */
export async function createHarness(options = {}) {
  const dir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'isolated-monitor-test-')))
  const projectDir = options.projectDir ?? (await mkdtemp(join(tmpdir(), 'isolated-monitor-project-')))
  const config = normalizeConfig({ enableCommand: true, ...(options.config ?? {}) })
  const logger = {
    warnings: [],
    infos: [],
    warn(message) {
      this.warnings.push(String(message))
    },
    info(message) {
      this.infos.push(String(message))
    },
  }
  const events = new Map()
  const targets = new Map(Object.entries(options.targets ?? {}))
  const toolsService = createToolsService({ logger })
  const agentsMap = new Map()
  const archived = []
  const workspaces = new Map()
  const titles = new Map()
  const mountedPresets = []
  const createdSessions = []
  let createFailures = 0
  const behaviorState = { current: options.behavior ?? normalBehavior }
  const behavior = (args) => behaviorState.current(args)

  const sessionsService = {
    flushValue: true,
    flushCalls: 0,
    get(id) {
      return agentsMap.get(id)?.session
    },
    list() {
      return [...agentsMap.values()].map((agent) => agent.session)
    },
    async flush(session) {
      this.flushCalls += 1
      return this.flushValue
    },
  }

  const ctx = {
    services: new Map(),
    get(name) {
      return this.services.get(name)
    },
    on(name, callback) {
      const list = events.get(name) ?? []
      list.push(callback)
      events.set(name, list)
      return () => {
        const current = events.get(name) ?? []
        events.set(name, current.filter((entry) => entry !== callback))
      }
    },
    emit(name, ...args) {
      for (const callback of events.get(name) ?? []) callback(...args)
    },
    async serial(name, payload) {
      for (const callback of events.get(name) ?? []) await callback(payload)
    },
    inject(_names, callback) {
      return callback(this)
    },
    effect(fn) {
      return fn()
    },
    logger,
  }

  const agentsService = {
    get(id) {
      return agentsMap.get(id)
    },
    roots() {
      return [...agentsMap.values()]
    },
    isOwnedBy() {
      return false
    },
    async create({ sessionId, meta, agentOptions, setup }) {
      if (createFailures > 0) {
        createFailures -= 1
        throw new Error('injected agents.create failure')
      }
      const agent = new FakeAgent({ id: sessionId, cwd: meta?.cwd, behavior, ctx })
      createdSessions.push({ agent, session: agent.session })
      await setup?.(agent.ctx, agent)
      agentsMap.set(sessionId, agent)
      return {
        agent,
        disposed: false,
        async dispose() {
          this.disposed = true
          agentsMap.delete(sessionId)
        },
      }
    },
    async resume({ resumeSessionId }) {
      const agent = targets.get(resumeSessionId)
      if (agent === undefined) throw new Error(`cannot resume ${resumeSessionId}`)
      return { agent, async dispose() {} }
    },
  }

  const controller = {
    async create({ sessionId, cwd }) {
      return agentsService.create({ sessionId, meta: { cwd }, setup: () => undefined })
    },
    async resolveAgent(sessionId) {
      if (options.resolveError?.(sessionId) === true) {
        return { error: { code: 'session/not-found', message: `session ${sessionId} not found` } }
      }
      const live = agentsMap.get(sessionId)
      if (live !== undefined) return { agent: live }
      const target = targets.get(sessionId)
      if (target !== undefined) return { agent: target }
      return { error: { code: 'session/not-found', message: `session ${sessionId} not found` } }
    },
  }

  const registry = {
    archivedSessionIds: archived,
    async archiveSession(sessionId, opts = {}) {
      if (archived.includes(sessionId)) return
      if (opts.stopActivity !== true && options.activeSessionIds?.includes(sessionId)) {
        const error = new Error('session is active')
        error.name = 'WorkspaceActiveSessionError'
        throw error
      }
      archived.push(sessionId)
    },
    async unarchiveSession(sessionId) {
      const index = archived.indexOf(sessionId)
      if (index >= 0) archived.splice(index, 1)
    },
    async resolveByPath(path) {
      return workspaces.get(path)
    },
  }

  const sessionTitle = {
    rename(session, title) {
      titles.set(session.id, title)
    },
  }

  const presets = {
    async resolve(id) {
      return { id: id ?? 'standard' }
    },
    async mount(_agentCtx, id) {
      mountedPresets.push(id)
      return { id }
    },
  }

  ctx.services.set('agents', agentsService)
  ctx.services.set('sessions', sessionsService)
  ctx.services.set('tools', toolsService)
  ctx.services.set('sessionController', controller)
  ctx.services.set('workspaceRegistry', registry)
  ctx.services.set('sessionTitle', sessionTitle)
  ctx.services.set('agentPresets', presets)
  ctx.services.set('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'mock-model' }) })
  ctx.services.set('commands', {
    commands: [],
    register(definition) {
      this.commands.push(definition)
      return () => undefined
    },
  })
  // Cordis mixes services onto the context; mirror that for these fakes.
  for (const [serviceName, service] of ctx.services) ctx[serviceName] = service

  const adapters = {
    installModelSelection(agentCtx) {
      agentCtx.__modelSelection = true
    },
    setSandboxMode(session, mode) {
      session.append('sandbox/mode', { mode })
    },
    setApprovalPolicy(session, policy) {
      session.append('approval/policy', { policy })
    },
    appendPluginRecord(session, type, data) {
      return session.append(type, data)
    },
    pluginRecordOf(event) {
      return event?.ignorable === true && typeof event.type === 'string' && event.type.startsWith('plugin:')
        ? { type: event.type, seq: event.seq, time: event.time, data: event.data }
        : undefined
    },
    scopeOf(agentCtx) {
      return agentCtx.__scope
    },
    createUserMessage(input) {
      adapters.messageSeq = (adapters.messageSeq ?? 0) + 1
      return { id: `msg-${adapters.messageSeq}`, role: 'user', ...input }
    },
    defineTool(definition) {
      return definition
    },
  }

  const store = createStore({
    dir,
    logger,
    writeFileAtomic: testWriteFileAtomic,
    historyLimit: config.historyLimit,
    artifactRetentionDays: config.runArtifactRetentionDays,
  })
  await store.load()

  const timing = createTiming({
    Cron: {
      parse(expression, zone) {
        // Test-only cron stub: honours every-N-minutes patterns.
        const match = /^\*\/(\d+) \* \* \* \*$/.exec(expression)
        if (match === null) return { kind: 'rejected', reason: 'syntax' }
        const minutes = Number(match[1])
        return {
          kind: 'accepted',
          rule: {
            next(after) {
              const step = minutes * 60 * 1000
              return Math.ceil((after + 1) / step) * step
            },
          },
        }
      },
    },
    RRule: {
      parse(expression) {
        if (!String(expression).includes('RRULE:')) return { kind: 'rejected', reason: 'syntax' }
        return { kind: 'accepted', rule: { next: (after) => after + 60_000 } }
      },
    },
    resolveLocalInstant(date, time) {
      const epoch = Date.parse(`${date}T${time}Z`)
      return Number.isFinite(epoch) ? epoch : undefined
    },
  })

  const sessions = createSessionManager({ ctx, config, logger, adapters })
  const alerts = createAlertRouter({ ctx, config, store, sessions, logger, adapters })
  const checks = createCheckRunner({ ctx, logger })
  const runner = createRunner({ ctx, config, store, sessions, alerts, checks, timing, logger, adapters })
  const scheduler = createScheduler({ store, runner, config, logger })
  const tools = registerTools({ ctx, config, store, sessions, scheduler, alerts, timing, logger, adapters: { defineTool: adapters.defineTool } })

  const rootAgent = new FakeAgent({ id: 'session-A', cwd: projectDir, behavior: normalBehavior, ctx })
  agentsMap.set(rootAgent.id, rootAgent)
  for (const target of targets.values()) if (agentsMap.get(target.id) === undefined) agentsMap.set(target.id, target)

  const toolMap = new Map(tools.tools.map((toolName) => [toolName, toolsService.registrations.get(toolName)?.definition]))

  function callTool(toolName, args, agent = rootAgent) {
    const definition = toolMap.get(toolName)
    if (definition === undefined) throw new Error(`unknown tool ${toolName}`)
    return definition.execute(args, { agent })
  }

  async function createTask(input) {
    const result = await callTool('monitor_create', {
      name: '训练监控',
      task_prompt: '检查训练进程与日志，出现 CUDA OOM 或中断则告警。',
      schedule: { kind: 'every', every_seconds: 1800 },
      ...input,
    })
    return store.getState().tasks[result.created.task_id]
  }

  async function setRetry(taskId, policy) {
    await store.transact((state) => {
      state.tasks[taskId].retry_policy = { max_attempts: 0, backoff_ms: 50, ...policy }
    })
  }

  async function run(taskId, options2 = {}) {
    const task = store.getState().tasks[taskId]
    return runner.execute(task, { trigger: 'run_now', occurrenceAt: new Date().toISOString(), ...options2 })
  }

  function setTarget(sessionId, agent) {
    targets.set(sessionId, agent)
    if (agent !== undefined) agentsMap.set(sessionId, agent)
  }

  return {
    dir,
    projectDir,
    config,
    ctx,
    logger,
    store,
    sessions,
    alerts,
    checks,
    runner,
    scheduler,
    timing,
    tools,
    toolMap,
    callTool,
    createTask,
    setRetry,
    run,
    rootAgent,
    agentsMap,
    archived,
    sessionsService,
    toolsService,
    titles,
    mountedPresets,
    createdSessions,
    workspaces,
    targets,
    setTarget,
    setBehavior(next) {
      behaviorState.current = next
    },
    messagesTo(agent = rootAgent) {
      return agent.session.log.filter(
        (event) => event.type === 'user/message' && event.data?.source?.kind === 'isolated-monitor',
      )
    },
    adapters,
    setCreateFailures(count) {
      createFailures = count
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    },
    async readStateFile() {
      return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    },
  }
}

/** Build a behavior that reports the given findings. */
export function reportBehavior(report, { usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } = {}) {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    const text = ['检查完成。', '```json', JSON.stringify(report), '```'].join('\n')
    agent.session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      usage,
    })
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  }
}

/** Build a behavior that hangs until cancelled. */
export function hangingBehavior() {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    await new Promise((resolve) => {
      agent.release = resolve
      if (agent.cancelled) resolve()
    })
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'aborted', reason: agent.cancelCause ?? { kind: 'timeout' } } })
  }
}

/** Build a behavior that fails inside the turn. */
export function errorBehavior(message = 'provider exploded') {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    ctxEmit(agent, 'agent/error', { agent, error: Object.assign(new Error(message), { code: 'TEST_ERROR' }) })
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'error', error: { code: 'TEST_ERROR', message } } })
  }
}

function ctxEmit(agent, name, payload) {
  agent.ctxWorld.emit(name, payload)
}

/** Build a behavior that consumes tokens past a budget, then stops. */
export function budgetBehavior(totalTokens) {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] },
      usage: { inputTokens: totalTokens, outputTokens: 0, totalTokens },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'aborted', reason: { kind: 'isolated-monitor-budget' } } })
  }
}

/** Build a behavior that emits a raw assistant text. */
export function textBehavior(text) {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })
    agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
  }
}

/** Behavior that never terminates a turn (missing turn/end). */
export function openTurnBehavior() {
  return async ({ agent }) => {
    agent.session.append('turn/start', { turn: 0 })
    agent.session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    })
  }
}
