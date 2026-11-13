import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_REPORT,
  createHarness,
  errorBehavior,
  hangingBehavior,
  openTurnBehavior,
  reportBehavior,
  textBehavior,
} from './harness.mjs'

const OOM = {
  status: 'alert',
  summary: '训练进程 CUDA OOM',
  findings: [
    {
      key: 'train-1',
      type: 'cuda_oom',
      severity: 'critical',
      title: 'CUDA OOM in train.py',
      evidence: 'torch.OutOfMemoryError: CUDA out of memory',
      location: 'logs/train.log:42',
      suggestion: '减小 batch size 或清理显存',
    },
  ],
}

const OK = { status: 'ok', summary: '一切正常', findings: [] }

async function harness(t, options = {}) {
  const h = await createHarness(options)
  t.after(async () => {
    await h.cleanup().catch(() => undefined)
  })
  return h
}

test('1. normal run: fresh Session, no inheritance, archived, creator untouched, history kept', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const task = await h.createTask({ name: '训练进程巡检' })
  const before = h.rootAgent.session.log.length

  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'normal')
  assert.equal(result.archived, true)
  assert.notEqual(result.session_id, 'session-A')

  const created = h.createdSessions.find((entry) => entry.session.id === result.session_id)
  assert.ok(created, 'the monitor session was created')
  assert.equal(created.session.header.cwd, h.projectDir)
  assert.equal(created.session.header.parentSession, undefined)
  assert.ok(created.session.log.some((event) => event.type === 'plugin:isolated-monitor/session'))
  assert.equal(
    created.session.log.find((event) => event.type === 'plugin:isolated-monitor/session').data.taskId,
    task.task_id,
  )
  // Nothing from the creator conversation is present.
  assert.equal(created.session.log.some((event) => event.data?.source?.kind === 'user'), false)

  assert.ok(h.archived.includes(result.session_id), 'archived')
  assert.equal(h.agentsMap.has(result.session_id), false, 'agent ended and was removed from the live registry')
  assert.equal(h.messagesTo().length, 0, 'creator received no message')
  assert.equal(h.rootAgent.session.log.length, before, 'creator transcript untouched')

  const state = h.store.getState()
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0].status, 'normal')
  assert.equal(state.runs[0].usage.total, 120)
  assert.ok(state.runs[0].artifact_path)
  assert.equal(JSON.parse(await readFile(state.runs[0].artifact_path, 'utf8')).run.run_id, result.run_id)

  const view = await h.callTool('monitor_view', { task_id: task.task_id })
  assert.equal(view.runs.length, 1)
  assert.equal(view.runs[0].session_id, result.session_id)
  assert.equal(view.runs[0].session_archived, true)

  // Archiving never deleted the Session: it can be restored.
  await h.sessions.unarchive(result.session_id)
  assert.equal(h.archived.includes(result.session_id), false)
})

test('2. alert run: dedicated Session stays visible and the creator receives a full report', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OOM) })
  const task = await h.createTask({ name: 'CUDA 训练监控' })
  const result = await h.run(task.task_id)

  assert.equal(result.outcome, 'alert')
  assert.equal(result.archived, false)
  assert.equal(h.archived.includes(result.session_id), false)
  assert.equal(h.agentsMap.has(result.session_id), false, 'agent ended but session is retained')

  const created = h.createdSessions.find((entry) => entry.session.id === result.session_id)
  assert.ok(created.session.log.some((event) => event.type === 'assistant/message'))
  const runRecord = created.session.log.find((event) => event.type === 'plugin:isolated-monitor/run')
  assert.equal(runRecord.data.status, 'alert')
  assert.equal(runRecord.data.findings[0].key, 'train-1')

  const messages = h.messagesTo()
  assert.equal(messages.length, 1)
  const text = messages[0].data.message.content[0].text
  for (const required of [
    task.name,
    task.task_id,
    result.session_id,
    'cuda_oom',
    'critical',
    'CUDA OOM',
    'torch.OutOfMemoryError',
    'logs/train.log:42',
    h.projectDir,
    '建议排查方向',
  ]) {
    assert.ok(text.includes(required), `alert mentions ${required}`)
  }
  const delivery = h.store.getState().deliveries[0]
  assert.equal(delivery.status, 'delivered')
  assert.ok(messages[0].data.source.dedupeKey.startsWith(`im:${task.task_id}`))
})

test('3a. Session creation failure is a MONITOR_ERROR and notifies', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const task = await h.createTask({})
  await h.setRetry(task.task_id, { max_attempts: 0 })
  h.setCreateFailures(1)
  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'monitor_error')
  assert.equal(result.code, 'session_create_failed')
  assert.equal(result.session_id, null)
  assert.equal(h.store.getState().runs[0].status, 'monitor_error')
  assert.equal(h.messagesTo().length, 1)
  assert.match(h.messagesTo()[0].data.message.content[0].text, /session_create_failed/)
})

test('3b. Agent timeout is a MONITOR_ERROR', async (t) => {
  const h = await harness(t, { behavior: hangingBehavior() })
  const task = await h.createTask({})
  await h.setRetry(task.task_id, { max_attempts: 0 })
  await h.store.transact((state) => {
    state.tasks[task.task_id].timeout_ms = 60
  })
  const started = Date.now()
  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'monitor_error')
  assert.equal(result.code, 'timeout')
  assert.ok(Date.now() - started < 3000)
  assert.equal(h.messagesTo().length, 1)
})

test('3c. Agent error, missing turn end, unparsable and invalid results are MONITOR_ERRORs', async (t) => {
  const cases = [
    { behavior: errorBehavior('provider exploded'), code: /turn_error|agent_error/ },
    { behavior: openTurnBehavior(), code: 'no_turn_end' },
    { behavior: textBehavior('I think everything is fine'), code: 'result_missing' },
    { behavior: textBehavior('```json\n{not json}\n```'), code: 'result_invalid' },
    { behavior: textBehavior('```json\n{"status":"weird"}\n```'), code: 'result_invalid' },
    {
      behavior: textBehavior('```json\n{"status":"inconclusive","inconclusive_reason":"no permission"}\n```'),
      code: 'inconclusive',
    },
  ]
  for (const entry of cases) {
    const h = await harness(t, { behavior: entry.behavior })
    const task = await h.createTask({ name: `case-${String(entry.code)}` })
    await h.setRetry(task.task_id, { max_attempts: 0 })
    const result = await h.run(task.task_id)
    assert.equal(result.outcome, 'monitor_error')
    assert.ok(
      typeof entry.code === 'string' ? result.code === entry.code : entry.code.test(String(result.code)),
      `expected ${entry.code}, got ${result.code}`,
    )
    assert.equal(h.messagesTo().length, 1)
    assert.equal(h.archived.includes(result.session_id), false)
  }
})

test('4. delivery failure stays pending, survives archiving, and can be retried', async (t) => {
  let blocked = true
  const h = await harness(t, { behavior: reportBehavior(OOM), resolveError: () => blocked })
  const task = await h.createTask({})
  const result = await h.run(task.task_id)

  assert.equal(result.outcome, 'alert')
  assert.equal(h.messagesTo().length, 0)
  let delivery = h.store.getState().deliveries[0]
  assert.equal(delivery.status, 'pending')
  assert.match(delivery.last_error, /cannot activate/)

  // Archiving the monitor Session must not lose the pending alert.
  await h.sessions.archive(result.session_id)
  blocked = false
  const retried = await h.alerts.retry(delivery.delivery_id)
  assert.equal(retried.status, 'delivered')
  assert.equal(h.messagesTo().length, 1)
  delivery = h.store.getState().deliveries[0]
  assert.equal(delivery.status, 'delivered')
  assert.ok(delivery.message_id)

  // A Session flush that is not acknowledged is a delivery failure, not a success.
  const h2 = await harness(t, { behavior: reportBehavior(OOM) })
  const task2 = await h2.createTask({})
  await h2.setRetry(task2.task_id, { max_attempts: 0 })
  h2.sessionsService.flushValue = false
  const failedRun = await h2.run(task2.task_id)
  assert.equal(failedRun.outcome, 'monitor_error')
  assert.equal(failedRun.code, 'prompt_flush_failed')
  let pending2 = h2.store.getState().deliveries.find((entry) => entry.status === 'pending')
  assert.ok(pending2, 'the alert waits for a usable delivery channel')
  assert.match(pending2.last_error, /did not acknowledge/)
  h2.sessionsService.flushValue = true
  const retried2 = await h2.alerts.retry(pending2.delivery_id)
  assert.equal(retried2.status, 'delivered')
  assert.equal(h2.messagesTo().length, 1)
})

test('5. identical anomalies notify once, escalate on severity, and notify new anomalies', async (t) => {
  const OOM_HIGH = { ...OOM, findings: [{ ...OOM.findings[0], severity: 'high' }] }
  const h = await harness(t, { behavior: reportBehavior(OOM_HIGH) })
  const task = await h.createTask({})

  await h.run(task.task_id)
  await h.run(task.task_id)
  await h.run(task.task_id)

  let state = h.store.getState()
  let open = state.events.filter((event) => event.status === 'open')
  assert.equal(open.length, 1)
  assert.equal(open[0].occurrence_count, 3)
  assert.equal(h.messagesTo().length, 1, 'one notification for three identical anomalies')
  assert.equal(open[0].notify_count, 1)

  // A different anomaly is notified independently.
  h.setBehavior(
    reportBehavior({
      status: 'alert',
      summary: '磁盘满',
      findings: [
        {
          key: 'disk-1',
          type: 'missing_file',
          severity: 'high',
          title: 'checkpoint 目录被删除',
          evidence: 'ENOENT: checkpoints/',
          location: 'checkpoints/',
        },
      ],
    }),
  )
  await h.run(task.task_id)
  assert.equal(h.messagesTo().length, 2)
  assert.equal(h.store.getState().events.filter((event) => event.status === 'open').length, 2)

  // Severity escalation of the same object notifies again.
  h.setBehavior(
    reportBehavior({
      ...OOM,
      findings: [{ ...OOM.findings[0], severity: 'critical', evidence: 'second OOM with 40GB requested' }],
    }),
  )
  await h.run(task.task_id)
  assert.equal(h.messagesTo().length, 3)
  const trainEvent = h.store
    .getState()
    .events.find((event) => event.event_key === 'cuda_oom\u0000train-1')
  assert.equal(trainEvent.notify_count, 2)
  assert.equal(trainEvent.severity, 'critical')

  // A conclusive clean run resolves the open events; no recovery notice by default.
  h.setBehavior(reportBehavior(OK))
  await h.run(task.task_id)
  state = h.store.getState()
  assert.equal(state.events.filter((event) => event.status === 'open').length, 0)
  assert.equal(h.messagesTo().length, 3)

  // With recovery notices enabled, clearing an anomaly sends one.
  h.setBehavior(reportBehavior(OOM))
  await h.run(task.task_id)
  const before = h.messagesTo().length
  await h.store.transact((store) => {
    store.tasks[task.task_id].alert_conditions.notify_on_recovery = true
  })
  h.setBehavior(reportBehavior(OK))
  await h.run(task.task_id)
  const messages = h.messagesTo()
  assert.equal(messages.length, before + 1)
  assert.match(messages.at(-1).data.message.content[0].text, /恢复通知/)
})

test('6. restart restores tasks, history, pending alerts, and never re-runs a completed occurrence', async (t) => {
  let blocked = true
  const first = await createHarness({
    behavior: reportBehavior(OOM),
    resolveError: () => blocked,
  })
  const task = await first.createTask({ name: '重启恢复验证' })
  first.setBehavior(reportBehavior(OK))
  await first.run(task.task_id)
  first.setBehavior(reportBehavior(OOM))
  await first.run(task.task_id)
  const pending = first.store.getState().deliveries.find((delivery) => delivery.status === 'pending')
  assert.ok(pending)
  const runsBefore = first.store.getState().runs.length
  const nextBefore = first.store.getState().tasks[task.task_id].next_run_at

  const second = await createHarness({
    dataDir: first.dir,
    projectDir: first.projectDir,
    behavior: reportBehavior(OK),
    resolveError: () => false,
  })
  t.after(async () => {
    await second.cleanup().catch(() => undefined)
    await first.cleanup().catch(() => undefined)
  })

  const restored = second.store.getState()
  assert.ok(restored.tasks[task.task_id], 'task restored')
  assert.equal(restored.tasks[task.task_id].name, '重启恢复验证')
  assert.equal(restored.tasks[task.task_id].next_run_at, nextBefore)
  assert.equal(restored.runs.length, runsBefore, 'run history restored')
  assert.ok(restored.deliveries.some((delivery) => delivery.delivery_id === pending.delivery_id && delivery.status === 'pending'))

  await second.scheduler.start()
  await second.scheduler.tick()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(second.store.getState().runs.length, runsBefore, 'no duplicate execution after restart')

  const retried = await second.alerts.retry(pending.delivery_id)
  assert.equal(retried.status, 'delivered')
  assert.equal(second.messagesTo().length, 1)
})

test('7. three consecutive runs are three isolated Sessions with independent state and usage', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const agentsFile = join(h.projectDir, 'AGENTS.md')
  await writeFile(agentsFile, '# Project rules\nRead-only monitor.\n')
  const task = await h.createTask({})
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    const result = await h.run(task.task_id)
    assert.equal(result.outcome, 'normal')
    ids.push(result.session_id)
    // The Session was opened in the project directory where AGENTS.md lives.
    assert.equal(h.createdSessions.at(-1).session.header.cwd, h.projectDir)
  }
  assert.equal(new Set(ids).size, 3, 'three distinct Session ids')
  for (const sessionId of ids) {
    const created = h.createdSessions.find((entry) => entry.session.id === sessionId)
    assert.equal(created.session.header.parentSession, undefined)
    assert.ok(created.session.log.some((event) => event.type === 'plugin:isolated-monitor/session'))
    assert.equal(
      created.session.log.find((event) => event.type === 'plugin:isolated-monitor/session').data.taskId,
      task.task_id,
    )
    // No conversation history from the creator or from a previous run.
    assert.equal(created.session.log.some((event) => event.data?.source?.kind === 'user'), false)
    assert.ok(created.agent.prompts.at(-1).content[0].text.includes(h.projectDir))
    assert.ok(created.agent.prompts.at(-1).content[0].text.includes('AGENTS.md'))
  }
  assert.equal(h.mountedPresets.length, 3, 'the recorded Agent preset is composed for every run')
  assert.equal(await readFile(agentsFile, 'utf8').then((text) => text.includes('Read-only')), true)

  const state = h.store.getState()
  const runs = state.runs.filter((run) => run.task_id === task.task_id)
  assert.equal(runs.length, 3)
  assert.equal(new Set(runs.map((run) => run.session_id)).size, 3)
  assert.equal(runs.reduce((sum, run) => sum + run.usage.total, 0), 360)
  assert.equal(state.tasks[task.task_id].stats.usage.total, 360)
  assert.equal(state.tasks[task.task_id].stats.runs, 3)
})

test('hybrid checks: passing checks skip the model; failing checks escalate to the Agent', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  h.toolsService.setResult('pwsh', {
    isError: false,
    value: { kind: 'foreground', exitCode: 0, output: 'python train.py is running' },
    content: [],
  })
  const task = await h.createTask({
    name: '确定性检查',
    task_prompt: undefined,
    execution_mode: 'hybrid',
    checks: [
      {
        id: 'train-process',
        kind: 'command',
        title: '训练进程存活',
        command: 'Get-Process python',
        finding_type: 'process_exit',
        stdout_includes: 'python',
      },
    ],
  })
  const normal = await h.run(task.task_id)
  assert.equal(normal.outcome, 'normal')
  assert.equal(normal.archived, true)
  const normalRun = h.store.getState().runs.at(-1)
  assert.equal(normalRun.checks.length, 1)
  assert.equal(normalRun.checks[0].passed, true)
  assert.equal(normalRun.usage.total, 0, 'no model request')
  assert.equal(h.createdSessions.length, 1)
  assert.equal(h.createdSessions[0].agent.prompts.length, 0, 'the Agent was never prompted')

  h.toolsService.setResult('pwsh', {
    isError: false,
    value: { kind: 'foreground', exitCode: 1, output: 'no python process' },
    content: [],
  })
  h.setBehavior(reportBehavior(OOM))
  const alert = await h.run(task.task_id)
  assert.equal(alert.outcome, 'alert')
  assert.equal(alert.archived, false)
  const alertRun = h.store.getState().runs.at(-1)
  assert.equal(alertRun.checks[0].passed, false)
  assert.equal(h.createdSessions.at(-1).agent.prompts.length, 1, 'the model investigated the failure')
  const alertTexts = h.messagesTo().map((entry) => entry.data.message.content[0].text)
  assert.ok(alertTexts.some((text) => /Get-Process python/.test(text)), 'the failed check evidence reaches an alert')
  assert.ok(alertTexts.some((text) => /CUDA OOM/.test(text)), 'the model finding is included as well')
})

test('file checks are deterministic and read-only', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const logPath = join(h.projectDir, 'train.log')
  await writeFile(logPath, 'epoch 1 ok\nepoch 2 ok\n')
  const task = await h.createTask({
    name: '文件检查',
    execution_mode: 'hybrid',
    checks: [
      { id: 'log-present', kind: 'file_exists', title: '日志存在', path: logPath, exists: true, min_bytes: 1 },
      { id: 'no-oom', kind: 'file_match', title: '日志无 OOM', path: logPath, pattern: 'OutOfMemory', must_match: false },
    ],
  })
  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'normal')
  const run = h.store.getState().runs.at(-1)
  assert.equal(run.checks.every((check) => check.passed === true), true)
})

test('management tools: list, view, pause, resume, update, delete', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const task = await h.createTask({ name: '管理测试' })

  const list = await h.callTool('monitor_list', {})
  assert.equal(list.total, 1)
  assert.equal(list.tasks[0].task_id, task.task_id)
  assert.equal(list.tasks[0].status, 'active')

  const view = await h.callTool('monitor_view', { task_id: task.task_id })
  assert.equal(view.task.name, '管理测试')
  assert.deepEqual(view.runs, [])

  await h.callTool('monitor_manage', { task_id: task.task_id, action: 'pause' })
  assert.equal(h.store.getState().tasks[task.task_id].status, 'paused')
  await h.callTool('monitor_manage', { task_id: task.task_id, action: 'resume' })
  assert.equal(h.store.getState().tasks[task.task_id].status, 'active')

  const updated = await h.callTool('monitor_manage', {
    task_id: task.task_id,
    action: 'update',
    patch: { name: '改名后', schedule: { kind: 'cron', expression: '*/30 * * * *', time_zone: 'UTC' }, severity: 'low' },
  })
  assert.equal(updated.updated.name, '改名后')
  assert.equal(updated.updated.schedule, 'cron */30 * * * * (UTC)')
  assert.equal(h.store.getState().tasks[task.task_id].alert_conditions.default_severity, 'low')

  const runNow = await h.callTool('monitor_manage', { task_id: task.task_id, action: 'run_now' })
  assert.equal(runNow.started, true)
  await new Promise((resolve) => setTimeout(resolve, 100))

  await h.callTool('monitor_manage', { task_id: task.task_id, action: 'delete' })
  assert.equal(h.store.getState().tasks[task.task_id].status, 'deleted')
  assert.equal((await h.callTool('monitor_list', {})).total, 0)
  assert.equal(h.store.getState().runs.length, 1, 'history retained after delete')
})

test('tool validation rejects bad input without creating a task', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const base = { name: 'bad', schedule: { kind: 'every', every_seconds: 1800 } }
  await assert.rejects(() => h.callTool('monitor_create', base), /task_prompt is required/)
  await assert.rejects(
    () => h.callTool('monitor_create', { ...base, task_prompt: 'x', schedule: { kind: 'every', every_seconds: 5 } }),
    /every_seconds/,
  )
  await assert.rejects(
    () => h.callTool('monitor_create', { ...base, task_prompt: 'x', project_path: 'relative/path' }),
    /absolute/,
  )
  await assert.rejects(
    () =>
      h.callTool('monitor_create', {
        ...base,
        task_prompt: 'x',
        schedule: { kind: 'daily', time: 'oops', time_zone: 'UTC' },
      }),
    /HH:mm/,
  )
  assert.equal(Object.keys(h.store.getState().tasks).length, 0)
})

test('retry policy re-runs a transient failure in a fresh Session before alerting', async (t) => {
  let calls = 0
  const behavior = async (args) => {
    calls += 1
    if (calls === 1) return errorBehavior('transient provider failure')(args)
    return reportBehavior(OK)(args)
  }
  const h = await harness(t, { behavior })
  const task = await h.createTask({})
  await h.store.transact((state) => {
    state.tasks[task.task_id].retry_policy = { max_attempts: 1, backoff_ms: 10 }
  })
  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'normal')
  const runs = h.store.getState().runs.filter((run) => run.task_id === task.task_id)
  assert.equal(runs.length, 2, 'the failed attempt and the retry are both recorded')
  assert.equal(runs[0].status, 'monitor_error')
  assert.equal(runs[0].retry_scheduled, true)
  assert.equal(runs[1].status, 'normal')
  assert.notEqual(runs[0].session_id, runs[1].session_id)
  assert.ok(h.archived.includes(runs[0].session_id), 'the superseded attempt Session is archived')
  assert.ok(h.archived.includes(runs[1].session_id))
  assert.equal(h.messagesTo().length, 0, 'a recovered transient failure does not alert')
})

test('source Session archived before a run pauses the task instead of running', async (t) => {
  const h = await harness(t, { behavior: reportBehavior(OK) })
  const task = await h.createTask({})
  h.archived.push('session-A')
  const result = await h.run(task.task_id)
  assert.equal(result.outcome, 'paused')
  const stored = h.store.getState().tasks[task.task_id]
  assert.equal(stored.status, 'paused')
  assert.equal(stored.paused_reason, 'source_session_archived')
  assert.equal(h.createdSessions.length, 0)
})



