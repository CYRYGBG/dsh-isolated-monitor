import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyOutcome,
  findingsFromChecks,
  normalizeFinding,
  parseMonitorReport,
} from '../src/classify.js'
import { RUN_STATUS } from '../src/state.js'

const base = {
  turnReason: { kind: 'completed' },
  agentError: undefined,
  timedOut: false,
  budgetExceeded: false,
  checks: [],
  defaultSeverity: 'high',
  hasTurn: true,
}

const report = (value) => ['intro', '```json', JSON.stringify(value), '```'].join('\n')

test('parses the last fenced JSON block and ignores surrounding prose', () => {
  const parsed = parseMonitorReport(report({ status: 'ok', summary: 'fine', findings: [] }))
  assert.equal(parsed.kind, 'parsed')
  assert.equal(parsed.report.status, 'ok')
  const withTrailing = `${report({ status: 'ok', summary: 'fine', findings: [] })}\n\nDone.`
  assert.equal(parseMonitorReport(withTrailing).kind, 'parsed')
})

test('accepts a bare JSON object and normalizes findings', () => {
  const parsed = parseMonitorReport(
    JSON.stringify({
      status: 'alert',
      summary: 'oom',
      findings: [{ type: 'cuda_oom', severity: 'critical', title: 'CUDA OOM', evidence: 'out of memory', key: 'train-1' }],
    }),
  )
  assert.equal(parsed.kind, 'parsed')
  const finding = normalizeFinding(parsed.report.findings[0], { defaultSeverity: 'high', index: 0 })
  assert.equal(finding.type, 'cuda_oom')
  assert.equal(finding.object_key, 'train-1')
  assert.equal(finding.severity, 'critical')
})

test('unknown finding types map to other while keeping the raw type', () => {
  const finding = normalizeFinding(
    { type: 'gpu_on_fire', title: 'GPU on fire', evidence: 'smoke' },
    { defaultSeverity: 'medium', index: 2 },
  )
  assert.equal(finding.type, 'other')
  assert.equal(finding.raw_type, 'gpu_on_fire')
  assert.equal(finding.severity, 'medium')
})

test('missing and malformed results are monitor errors, never normal', () => {
  assert.equal(parseMonitorReport('').kind, 'missing')
  assert.equal(parseMonitorReport('all good, really').kind, 'missing')
  assert.equal(parseMonitorReport('```json\n{nope}\n```').kind, 'invalid')
  assert.equal(parseMonitorReport('```json\n{"status":"weird"}\n```').kind, 'invalid')
  const outcome = classifyOutcome({ ...base, assistantText: 'no json' })
  assert.equal(outcome.status, RUN_STATUS.MONITOR_ERROR)
  assert.equal(outcome.code, 'result_missing')
})

test('ok with no findings is normal; findings are alert; alert without findings is inconsistent', () => {
  const normal = classifyOutcome({ ...base, assistantText: report({ status: 'ok', summary: 'fine', findings: [] }) })
  assert.equal(normal.status, RUN_STATUS.NORMAL)

  const alert = classifyOutcome({
    ...base,
    assistantText: report({
      status: 'alert',
      summary: 'oom',
      findings: [{ type: 'cuda_oom', title: 'CUDA OOM', evidence: 'out of memory' }],
    }),
  })
  assert.equal(alert.status, RUN_STATUS.ALERT)
  assert.equal(alert.findings.length, 1)

  const inconsistent = classifyOutcome({ ...base, assistantText: report({ status: 'alert', summary: 'hmm', findings: [] }) })
  assert.equal(inconsistent.status, RUN_STATUS.MONITOR_ERROR)
  assert.equal(inconsistent.code, 'result_inconsistent')
})

test('inconclusive is a monitor error with the model reason', () => {
  const outcome = classifyOutcome({
    ...base,
    assistantText: report({ status: 'inconclusive', inconclusive_reason: 'permission denied', findings: [] }),
  })
  assert.equal(outcome.status, RUN_STATUS.MONITOR_ERROR)
  assert.equal(outcome.code, 'inconclusive')
  assert.match(outcome.message, /permission denied/)
})

test('turn failures, timeouts, budgets, and missing turns are monitor errors', () => {
  const cases = [
    [{ timedOut: true }, 'timeout'],
    [{ budgetExceeded: true }, 'budget_exceeded'],
    [{ agentError: { message: 'boom', code: 'X' } }, 'agent_error'],
    [{ turnReason: { kind: 'error', error: { message: 'bad' } } }, 'turn_error'],
    [{ turnReason: { kind: 'aborted' } }, 'turn_aborted'],
    [{ turnReason: { kind: 'max-tokens' } }, 'turn_max-tokens'],
    [{ turnReason: undefined }, 'no_turn_end'],
    [{ hasTurn: false }, 'no_turn'],
  ]
  for (const [patch, code] of cases) {
    const outcome = classifyOutcome({ ...base, assistantText: report({ status: 'ok', findings: [] }), ...patch })
    assert.equal(outcome.status, RUN_STATUS.MONITOR_ERROR, code)
    assert.equal(outcome.code, code)
  }
})

test('failed checks become findings and force an alert', () => {
  const checks = [
    { id: 'process', passed: false, title: '训练进程存活', severity: 'high', finding_type: 'process_exit', evidence: 'no python process' },
    { id: 'log', passed: true, title: '日志可读' },
  ]
  const findings = findingsFromChecks(checks)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].object_key, 'check:process')
  const outcome = classifyOutcome({
    ...base,
    checks,
    assistantText: report({ status: 'ok', summary: 'all good', findings: [] }),
  })
  assert.equal(outcome.status, RUN_STATUS.ALERT)
  assert.equal(outcome.findings.length, 1)
})

test('stable object keys keep the same event identity across runs', () => {
  const first = normalizeFinding({ type: 'cuda_oom', title: 'CUDA OOM', evidence: 'a' }, { defaultSeverity: 'high', index: 0 })
  const second = normalizeFinding({ type: 'cuda_oom', title: 'CUDA OOM', evidence: 'a' }, { defaultSeverity: 'high', index: 0 })
  assert.equal(first.object_key, second.object_key)
})
