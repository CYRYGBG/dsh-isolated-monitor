import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createHarness, reportBehavior } from './harness.mjs'

test('state survives a corrupt primary document through the backup', async (t) => {
  const h = await createHarness({ behavior: reportBehavior({ status: 'ok', summary: 'ok', findings: [] }) })
  const task = await h.createTask({ name: '备份恢复' })
  await h.run(task.task_id)
  const statePath = join(h.dir, 'state.json')
  const backup = await readFile(join(h.dir, 'state.json.bak'), 'utf8')
  await writeFile(statePath, '{ this is not json')
  await writeFile(join(h.dir, 'state.json.corrupt-test.lock'), '')

  const h2 = await createHarness({ dataDir: h.dir, projectDir: h.projectDir })
  t.after(async () => {
    await h2.cleanup().catch(() => undefined)
    await h.cleanup().catch(() => undefined)
  })
  const restored = h2.store.getState()
  assert.ok(restored.tasks[task.task_id], 'task recovered from the backup')
  assert.equal(restored.runs.length, 1)
  assert.ok(h2.logger.warnings.some((line) => line.includes('state.json.bak')), 'recovery is logged')
  assert.ok(backup.includes(task.task_id))
})

test('a run interrupted by a host stop is reported once, never as normal', async (t) => {
  const h = await createHarness({ behavior: reportBehavior({ status: 'ok', summary: 'ok', findings: [] }) })
  const task = await h.createTask({ name: '中断恢复' })
  await h.store.transact((state) => {
    state.runs.push({
      run_id: 'run-interrupted',
      task_id: task.task_id,
      task_name: task.name,
      trigger: 'schedule',
      occurrence_at: new Date().toISOString(),
      started_at: new Date(Date.now() - 60_000).toISOString(),
      finished_at: null,
      status: 'running',
      code: null,
      message: null,
      session_id: 'session-interrupted',
      session_archived: false,
      session_disposed: false,
      model: null,
      duration_ms: null,
      usage: { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0, reasoning: 0 },
      summary: '',
      findings: [],
      checks: [],
      attempts: 1,
      error: null,
      artifact_path: null,
      classification: null,
      recovery_handled: false,
    })
    state.tasks[task.task_id].in_flight_run_id = 'run-interrupted'
  })

  const h2 = await createHarness({ dataDir: h.dir, projectDir: h.projectDir })
  t.after(async () => {
    await h2.cleanup().catch(() => undefined)
    await h.cleanup().catch(() => undefined)
  })
  const restored = h2.store.getState()
  const run = restored.runs.find((candidate) => candidate.run_id === 'run-interrupted')
  assert.equal(run.status, 'monitor_error')
  assert.equal(run.code, 'interrupted')
  assert.equal(restored.tasks[task.task_id].in_flight_run_id, null)

  await h2.runner.recoverInterrupted()
  const messages = h2.messagesTo()
  assert.equal(messages.length, 1)
  assert.match(messages[0].data.message.content[0].text, /interrupted/)
  const afterFirst = h2.store.getState().runs.find((candidate) => candidate.run_id === 'run-interrupted')
  assert.equal(afterFirst.recovery_handled, true)

  // A second recovery pass must not notify again.
  await h2.runner.recoverInterrupted()
  assert.equal(h2.messagesTo().length, 1)
})

test('the scheduler fires a due task exactly once and advances the occurrence', async (t) => {
  const h = await createHarness({ behavior: reportBehavior({ status: 'ok', summary: 'ok', findings: [] }) })
  const task = await h.createTask({ name: '定时触发' })
  await h.store.transact((state) => {
    state.tasks[task.task_id].next_run_at = new Date(Date.now() - 1000).toISOString()
  })
  await h.scheduler.start()
  await h.scheduler.tick()
  await new Promise((resolve) => setTimeout(resolve, 150))
  const state = h.store.getState()
  const runs = state.runs.filter((run) => run.task_id === task.task_id)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].trigger, 'schedule')
  assert.equal(runs[0].status, 'normal')
  assert.ok(Date.parse(state.tasks[task.task_id].next_run_at) > Date.now())
  // It stays archived and the creator was not disturbed.
  assert.ok(h.archived.includes(runs[0].session_id))
  assert.equal(h.messagesTo().length, 0)
})

test('one-shot tasks end after their single run', async (t) => {
  const h = await createHarness({ behavior: reportBehavior({ status: 'ok', summary: 'ok', findings: [] }) })
  const task = await h.createTask({
    name: '一次性任务',
    schedule: { kind: 'after', after_seconds: 60 },
  })
  schedLeap(h, task.task_id)
  await h.scheduler.start()
  await h.scheduler.tick()
  await new Promise((resolve) => setTimeout(resolve, 120))
  const stored = h.store.getState().tasks[task.task_id]
  assert.equal(stored.status, 'ended')
  assert.equal(stored.next_run_at, null)
  assert.equal(h.store.getState().runs.length, 1)
})

function schedLeap(h, taskId) {
  // Test-only: make the task due now without waiting for its interval.
  h.store.getState().tasks[taskId].next_run_at = new Date(Date.now() - 1).toISOString()
}

test('artifacts are written per run and pruned by age', async (t) => {
  const h = await createHarness({ behavior: reportBehavior({ status: 'ok', summary: 'ok', findings: [] }) })
  const task = await h.createTask({})
  await h.run(task.task_id)
  const run = h.store.getState().runs[0]
  const artifact = await h.store.readArtifact(run.run_id)
  assert.equal(artifact.run.run_id, run.run_id)
  assert.ok(artifact.prompt.includes(task.project_path))
  assert.equal(await h.store.pruneArtifacts(), 0)
})
