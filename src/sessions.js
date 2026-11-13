/**
 * Isolated Session lifecycle: create a fresh root Agent/Session, harden it to
 * read-only, name and group it, dispose the Agent, archive or keep it.
 * @module dsh-isolated-monitor/sessions
 */
import { newSessionId, truncate } from './util.js'

/** Base allowlist for a read-only monitor Agent. */
export const BASE_ALLOWED_TOOLS = [
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
]

/** Tools a read-only monitor must never see. */
export const MUTATING_TOOLS = [
  'write',
  'edit',
  'apply_patch',
  'str_replace_editor',
  'subagent',
  'subagent_fork',
  'workflow',
  'create_goal',
  'update_goal',
  'get_goal',
  'schedule_create',
  'schedule_edit',
  'ask_user_question',
  'present',
]

/** Tools hidden from monitor sessions. */
export const MONITOR_TOOL_NAMES = ['monitor_create', 'monitor_list', 'monitor_view', 'monitor_manage']

/** A setup failure with a stable code, classified as MONITOR_ERROR. */
export class MonitorSetupError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MonitorSetupError'
    this.code = code
  }
}

/**
 * @param {{
 *   ctx: any,
 *   config: Record<string, any>,
 *   logger: {warn:Function, info:Function},
 *   adapters: {
 *     installModelSelection: Function,
 *     setSandboxMode: Function,
 *     setApprovalPolicy: Function,
 *     appendPluginRecord: Function,
 *     pluginRecordOf: Function,
 *     scopeOf: Function,
 *   },
 * }} options
 */
export function createSessionManager({ ctx, config, logger, adapters }) {
  const created = new Set()
  const resumedHandles = new Map()

  /** Whether one Session was created by this plugin (durable marker or runtime cache). */
  function isMonitorSession(session) {
    if (session === undefined || session === null) return false
    if (created.has(session.id)) return true
    const events = Array.isArray(session.log) ? session.log.slice(0, 12) : []
    for (const event of events) {
      const record = adapters.pluginRecordOf(event)
      if (record !== undefined && record.type === 'plugin:isolated-monitor/session') return true
    }
    return false
  }

  function isArchived(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    return registry?.archivedSessionIds?.includes(sessionId) === true
  }

  /**
   * Apply read-only hardening in the Agent setup callback.
   * @returns {Record<string, unknown>} audit facts stored on the run
   */
  function harden({ agentCtx, agent, task }) {
    const auditing = { sandbox: null, approval: null, restricted: false, allowed: [], visible: [] }
    const writable = task.allowed_operations?.write === true

    if (!writable) {
      let sandboxApplied = false
      try {
        adapters.setSandboxMode(agent.session, 'read-only')
        sandboxApplied = true
        auditing.sandbox = 'read-only'
      } catch (error) {
        logger.warn(`could not set sandbox mode read-only: ${String(error?.message ?? error)}`)
      }
      let approvalApplied = false
      try {
        adapters.setApprovalPolicy(agent.session, 'never')
        approvalApplied = true
        auditing.approval = 'never'
      } catch (error) {
        logger.warn(`could not set approval policy never: ${String(error?.message ?? error)}`)
      }
      if (!sandboxApplied && !approvalApplied && config.allowUnenforcedReadOnly !== true) {
        throw new MonitorSetupError(
          'read_only_unenforceable',
          'read-only could not be enforced (no sandbox policy or approval service); set allowUnenforcedReadOnly to override',
        )
      }
    } else {
      auditing.sandbox = 'inherited'
      auditing.approval = 'inherited'
    }

    const tools = agentCtx.tools
    if (tools === undefined || tools === null) {
      throw new MonitorSetupError('tools_unavailable', 'the monitor Agent has no tool registry')
    }
    let known
    try {
      const scope = adapters.scopeOf(agentCtx)
      known = new Set(tools.definitions(scope).map((definition) => definition.name))
    } catch (error) {
      throw new MonitorSetupError('tools_unavailable', `cannot inspect the Agent tool set: ${String(error?.message ?? error)}`)
    }
    const allowed = new Set(BASE_ALLOWED_TOOLS.filter((name) => known.has(name)))
    if (task.allowed_operations?.allow_network === false) {
      allowed.delete('web_fetch')
      allowed.delete('web_search')
    }
    if (writable) {
      for (const name of ['write', 'edit', 'apply_patch']) if (known.has(name)) allowed.add(name)
    }
    for (const name of task.allowed_operations?.extra_tools ?? []) {
      if (known.has(name) && !MONITOR_TOOL_NAMES.includes(name)) allowed.add(name)
    }
    for (const name of MUTATING_TOOLS) if (writable && known.has(name)) allowed.add(name)
    // Monitor management tools are never available inside a monitor run.
    for (const name of MONITOR_TOOL_NAMES) allowed.delete(name)

    let restricted = false
    try {
      tools.restrict({ allow: [...allowed] })
      restricted = true
    } catch (firstError) {
      const deny = [...known].filter((name) => !allowed.has(name))
      try {
        tools.restrict({ deny })
        restricted = true
      } catch (secondError) {
        logger.warn(
          `could not restrict monitor tools (${String(firstError?.message ?? firstError)}; ${String(secondError?.message ?? secondError)})`,
        )
      }
    }

    let visible = []
    try {
      const scope = adapters.scopeOf(agentCtx)
      visible = tools.definitions(scope).map((definition) => definition.name)
    } catch {
      visible = []
    }
    const dangerous = visible.filter(
      (name) => MONITOR_TOOL_NAMES.includes(name) || (MUTATING_TOOLS.includes(name) && !writable) || name === 'run_code',
    )
    if (dangerous.length > 0 && config.allowUnenforcedReadOnly !== true) {
      throw new MonitorSetupError(
        'restriction_failed',
        `the monitor Agent can still see disallowed tools: ${dangerous.join(', ')}`,
      )
    }
    auditing.restricted = restricted
    auditing.allowed = [...allowed].filter((name) => visible.includes(name))
    auditing.visible = visible
    auditing.dangerous = dangerous

    try {
      agentCtx.systemPrompt.section({
        name: 'isolated-monitor:policy',
        order: 2500,
        text: [
          'You are running as an isolated, unattended monitor.',
          writable
            ? 'Only make the minimal change the task explicitly authorises.'
            : 'Stay strictly read-only: inspect files, git state, processes, logs, configurations and endpoints; never modify the project, commit, install, restart or delete.',
          'Never ask the user a question; nobody is watching this session live.',
          'Finish with exactly one fenced JSON result block following the contract in the user message.',
        ].join(' '),
      })
    } catch (error) {
      logger.warn(`could not add the monitor prompt section: ${String(error?.message ?? error)}`)
    }
    return auditing
  }

  /**
   * Create the fresh root Session and Agent for one run.
   * @param {Record<string, any>} task
   * @param {Record<string, any>} run
   * @returns {Promise<{sessionId:string, handle:any, agent:any, hardening:Record<string,unknown>}>}
   */
  async function createRunSession(task, run) {
    const presets = ctx.get('agentPresets')
    let resolved
    if (presets !== undefined) {
      try {
        resolved = await presets.resolve(task.agent_preset || undefined)
      } catch (error) {
        throw new MonitorSetupError('agent_preset_invalid', `cannot resolve the Agent preset: ${String(error?.message ?? error)}`)
      }
      if (resolved?.broken !== undefined) {
        throw new MonitorSetupError('agent_preset_invalid', `Agent preset ${resolved.id} is broken: ${String(resolved.broken)}`)
      }
    }
    const defaults = ctx.get('agentDefaultModel')
    let selection = task.model
      ? {
          provider: task.model.provider,
          model: task.model.model,
          ...(task.model.reasoning_effort === undefined ? {} : { reasoningEffort: task.model.reasoning_effort }),
        }
      : undefined
    if (selection === undefined) {
      const fallback = defaults?.currentSelection?.()
      if (fallback === undefined || fallback === null) {
        throw new MonitorSetupError('model_unavailable', 'no model selection is available for the monitor Agent')
      }
      selection = { provider: fallback.provider, model: fallback.model }
      if (fallback.reasoningEffort !== undefined) selection.reasoningEffort = fallback.reasoningEffort
    }
    if (task.model?.max_tokens !== undefined) selection.maxTokens = task.model.max_tokens
    const agentOptions = { ...selection }
    const sessionId = newSessionId()
    const meta = {
      cwd: task.project_path,
      ...(resolved?.id === undefined ? {} : { agentPreset: resolved.id }),
    }
    let hardening = { sandbox: null, approval: null, restricted: false, allowed: [], visible: [] }
    let handle
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta,
        agentOptions,
        setup: async (agentCtx, agent) => {
          try {
            adapters.installModelSelection(agentCtx)
          } catch (error) {
            logger.warn(`installModelSelection failed: ${String(error?.message ?? error)}`)
          }
          if (presets !== undefined && resolved?.id !== undefined) {
            await presets.mount(agentCtx, resolved.id)
          }
          hardening = harden({ agentCtx, agent, task })
        },
      })
    } catch (error) {
      if (error instanceof MonitorSetupError) throw error
      throw new MonitorSetupError('session_create_failed', `cannot create the monitor Session: ${String(error?.message ?? error)}`)
    }
    const agent = handle?.agent
    if (agent === undefined) {
      try {
        await handle?.dispose?.()
      } catch {
        // Nothing to clean up.
      }
      throw new MonitorSetupError('session_create_failed', 'agents.create resolved without an Agent')
    }
    created.add(sessionId)
    try {
      adapters.appendPluginRecord(agent.session, 'plugin:isolated-monitor/session', {
        taskId: task.task_id,
        runId: run.run_id,
        taskName: task.name,
        createdAt: new Date().toISOString(),
      })
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      logger.warn(`could not record the monitor marker: ${String(error?.message ?? error)}`)
    }
    nameSession(agent, task, run)
    await attachToWorkspace(sessionId, task.project_path)
    return { sessionId, handle, agent, hardening }
  }

  /** Give the monitor Session a stable title. */
  function nameSession(agent, task, run) {
    const titles = ctx.get('sessionTitle')
    if (titles === undefined) return
    const suffix = run.trigger === 'run_now' ? ' · 手动' : ''
    const title = truncate(`[监控] ${task.name}${suffix}`, 60)
    try {
      titles.rename(agent.session, title)
    } catch (error) {
      logger.warn(`could not title the monitor Session: ${String(error?.message ?? error)}`)
    }
  }

  /** Attach the Session to the Workspace registered at the project path, when one exists. */
  async function attachToWorkspace(sessionId, cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return false
    try {
      const workspace = await registry.resolveByPath(cwd)
      if (workspace === undefined) return false
      await workspace.attachSession(sessionId)
      return true
    } catch (error) {
      logger.warn(`monitor Session ${sessionId} did not join the workspace at ${cwd}: ${String(error?.message ?? error)}`)
      return false
    }
  }

  /** Archive one Session; the durable archive set hides it from every grouping surface. */
  async function archive(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new MonitorSetupError('archive_unavailable', 'no workspace registry is mounted')
    try {
      await registry.archiveSession(sessionId)
      return true
    } catch (error) {
      if (String(error?.name) === 'WorkspaceActiveSessionError') {
        logger.warn(`Session ${sessionId} still reported activity; archiving with stopActivity`)
        await registry.archiveSession(sessionId, { stopActivity: true })
        return true
      }
      throw error
    }
  }

  async function unarchive(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new MonitorSetupError('archive_unavailable', 'no workspace registry is mounted')
    await registry.unarchiveSession(sessionId)
  }

  /** Tear the Agent down; the persisted Session log remains. */
  async function dispose(handle) {
    if (handle === undefined || handle === null) return
    try {
      await handle.dispose()
    } catch (error) {
      logger.warn(`could not dispose the monitor Agent: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Resolve the Agent that owns an arbitrary Session (the alert target).
   * Prefers the Web controller's activation path so the recorded preset is
   * mounted; falls back to the Agent registry for reduced compositions.
   */
  async function resolveTargetAgent(sessionId) {
    const controller = ctx.get('sessionController')
    if (controller?.resolveAgent !== undefined) {
      const found = await controller.resolveAgent(sessionId)
      if (found?.agent !== undefined) return found.agent
      const reason = found?.error?.message ?? 'the target Session could not be activated'
      const error = new Error(reason)
      error.code = found?.error?.code ?? 'target_unavailable'
      throw error
    }
    const live = ctx.agents.get(sessionId)
    if (live !== undefined) return live
    if (resumedHandles.has(sessionId)) return resumedHandles.get(sessionId).agent
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: {},
    })
    resumedHandles.set(sessionId, handle)
    return handle.agent
  }

  /** Dispose Agents this plugin resumed only to deliver a notification. */
  async function releaseResumed() {
    const handles = [...resumedHandles.values()]
    resumedHandles.clear()
    for (const handle of handles) await dispose(handle)
  }

  return {
    isMonitorSession,
    isArchived,
    createRunSession,
    nameSession,
    attachToWorkspace,
    archive,
    unarchive,
    dispose,
    resolveTargetAgent,
    releaseResumed,
  }
}
