/**
 * dsh-isolated-monitor — isolated, self-archiving scheduled monitors for
 * DeepSeek Harness.
 *
 * Each scheduled run creates a fresh root Session (never reusing the creator
 * conversation or a previous run), hardens it to read-only, executes the
 * monitor, classifies the durable result, archives the Session when nothing is
 * wrong, and only messages the original creator Session when an anomaly or a
 * monitor failure requires attention.
 * @module dsh-isolated-monitor
 */
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { Cron, RRule, parseLocalCalendar, resolveLocalInstant } from '@deepseek-ai/dsh-util-time'
import { createAlertRouter } from './alerts.js'
import { createCheckRunner } from './checks.js'
import { hostTimeZone } from './clock.js'
import { createConfigSchema, normalizeConfig } from './config.js'
import { createRunner } from './runner.js'
import { createScheduler } from './scheduler.js'
import { createSessionManager } from './sessions.js'
import { createStore } from './store.js'
import { createTiming } from './timing.js'
import { registerCommand, registerTools } from './tools.js'
import { isActiveTask, TASK_STATUS } from './state.js'

/** Plugin name registered with the Cordis loader. */
export const name = 'isolated-monitor'

/** Host services required before the plugin can mount. */
export const inject = ['agents', 'sessions', 'tools']

/** Profile configuration schema. */
export const Config = createConfigSchema(z)

/**
 * Mount the plugin.
 * @param {any} ctx Cordis context
 * @param {Record<string, unknown>} rawConfig profile configuration
 */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = createLogger(ctx.logger)
  const dir = config.dataDir.trim() === ''
    ? dshHomePath('isolated-monitor')
    : resolve(expandHomePath(config.dataDir.trim()))

  const store = createStore({
    dir,
    logger,
    writeFileAtomic,
    historyLimit: config.historyLimit,
    artifactRetentionDays: config.runArtifactRetentionDays,
  })
  await store.load()

  const timing = createTiming({
    Cron,
    RRule,
    resolveLocalInstant: (date, time, zone) => {
      const parsed = parseLocalCalendar(date, time)
      if (parsed.kind !== 'accepted') return undefined
      return resolveLocalInstant(parsed.time, zone)
    },
  })

  const adapters = {
    installModelSelection,
    setSandboxMode,
    setApprovalPolicy,
    appendPluginRecord,
    pluginRecordOf,
    scopeOf,
    createUserMessage,
    defineTool,
  }

  const sessions = createSessionManager({
    ctx,
    config,
    logger,
    adapters,
  })

  const alerts = createAlertRouter({
    ctx,
    config,
    store,
    sessions,
    logger,
    adapters,
  })

  const checks = createCheckRunner({ ctx, logger })

  const runner = createRunner({ ctx, config, store, sessions, alerts, checks, timing, logger, adapters })

  const scheduler = createScheduler({ store, runner, config, logger })

  const registered = registerTools({ ctx, config, store, sessions, scheduler, alerts, timing, logger, adapters })

  // The command surface is optional; wait for it when a later composition provides it.
  ctx.inject(['commands'], (commandCtx) => {
    registerCommand({ ctx: commandCtx, store, scheduler, alerts, sessions, config })
  })

  // Archive admission: a creator Session that still owns active monitors reports
  // them, and "stop and archive" pauses those monitors instead of orphaning them.
  const offActivity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const rest = await next()
    const activeTasks = Object.values(store.getState().tasks).filter(
      (task) => isActiveTask(task) && task.source_session_id === sessionId,
    )
    if (activeTasks.length === 0) return rest
    return [
      {
        kind: 'isolated-monitor',
        items: activeTasks.map((task) => ({ id: task.task_id, label: task.name })),
      },
      ...rest,
    ]
  })
  const offStop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
    await store.transact((state) => {
      for (const task of Object.values(state.tasks)) {
        if (task.source_session_id !== sessionId || task.status !== TASK_STATUS.ACTIVE) continue
        task.status = TASK_STATUS.PAUSED
        task.enabled = false
        task.paused_reason = 'source_session_archived'
        task.next_run_at = null
        task.updated_at = new Date().toISOString()
      }
    })
    scheduler.arm()
  })

  const stopAlerts = alerts.start()
  const stopScheduler = await scheduler.start()
  void store.pruneArtifacts().catch(() => undefined)

  // A small, durable health record: it proves which deployment mounted, which
  // tools were registered, and when the scheduler last started. It never holds
  // task content.
  await writeFileAtomic(
    join(dir, 'mount.json'),
    `${JSON.stringify(
      {
        plugin: 'dsh-isolated-monitor',
        mountedAt: new Date().toISOString(),
        dataDir: dir,
        timeZone: config.timeZone || hostTimeZone(),
        tools: registered.tools,
        tasks: Object.keys(store.getState().tasks).length,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, dirMode: 0o700 },
  ).catch(() => undefined)

  ctx.effect(
    () => () => {
      stopScheduler()
      stopAlerts()
      offActivity()
      offStop()
      for (const dispose of registered.disposers) {
        try {
          dispose()
        } catch {
          // The tool registry may already be gone during unload.
        }
      }
      // Sets the runner's stopped flag synchronously, then disposes agents.
      void runner.shutdown()
      void sessions.releaseResumed()
    },
    'isolated-monitor:lifecycle',
  )

  logger.info(
    `mounted: data=${dir}, timeZone=${config.timeZone || hostTimeZone()}, tasks=${Object.keys(store.getState().tasks).length}`,
  )
}

function createLogger(base) {
  const prefix = '[isolated-monitor]'
  return {
    info: (message) => base?.info?.(`${prefix} ${message}`),
    warn: (message) => base?.warn?.(`${prefix} ${message}`),
    error: (message) => base?.error?.(`${prefix} ${message}`),
  }
}
