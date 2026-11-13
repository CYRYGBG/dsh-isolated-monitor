/**
 * Result classification: turn the durable outcome of one monitor run into
 * NORMAL / ALERT / MONITOR_ERROR, and turn the model's JSON contract into
 * normalized findings.
 * @module dsh-isolated-monitor/classify
 */
import { FINDING_TYPES, RUN_STATUS, SEVERITIES, severityRank } from './state.js'
import { oneLine, shortHash, truncate } from './util.js'

const MAX_FINDINGS = 20
const MAX_EVIDENCE = 6000

/** Parse the last fenced JSON block of an assistant message. */
export function parseMonitorReport(text) {
  const source = typeof text === 'string' ? text : ''
  if (source.trim() === '') return { kind: 'missing', reason: 'the monitor agent produced no assistant text' }
  const fences = [...source.matchAll(/```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g)]
  let candidate
  if (fences.length > 0) {
    candidate = fences.at(-1)[1]
  } else {
    const trimmed = source.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidate = trimmed
  }
  if (candidate === undefined) {
    return { kind: 'missing', reason: 'no fenced JSON result block was found in the final message' }
  }
  let report
  try {
    report = JSON.parse(candidate)
  } catch (error) {
    return { kind: 'invalid', reason: `the JSON result block is not valid JSON: ${String(error.message ?? error)}` }
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { kind: 'invalid', reason: 'the JSON result block must be an object' }
  }
  if (!['ok', 'alert', 'inconclusive'].includes(report.status)) {
    return { kind: 'invalid', reason: 'result.status must be "ok", "alert", or "inconclusive"' }
  }
  if (report.findings !== undefined && !Array.isArray(report.findings)) {
    return { kind: 'invalid', reason: 'result.findings must be an array' }
  }
  return {
    kind: 'parsed',
    report: {
      status: report.status,
      summary: typeof report.summary === 'string' ? truncate(report.summary, 4000) : '',
      inconclusive_reason: typeof report.inconclusive_reason === 'string'
        ? truncate(report.inconclusive_reason, 2000)
        : '',
      findings: (report.findings ?? []).slice(0, MAX_FINDINGS),
    },
  }
}

/**
 * Normalize one model finding.
 * @param {unknown} raw
 * @param {{defaultSeverity:string, index:number}} context
 * @returns {Record<string, unknown>|undefined}
 */
export function normalizeFinding(raw, { defaultSeverity, index }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const title = oneLine(raw.title ?? raw.message ?? raw.summary, 200)
  if (title === '') return undefined
  const type = FINDING_TYPES.includes(raw.type) ? raw.type : 'other'
  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : defaultSeverity
  const evidence = truncate(
    typeof raw.evidence === 'string'
      ? raw.evidence
      : typeof raw.detail === 'string'
        ? raw.detail
        : raw.evidence !== undefined
          ? JSON.stringify(raw.evidence)
          : '',
    MAX_EVIDENCE,
  )
  const objectKey = oneLine(
    typeof raw.key === 'string' && raw.key.trim() !== ''
      ? raw.key
      : typeof raw.object_key === 'string' && raw.object_key.trim() !== ''
        ? raw.object_key
        : `${type}:${shortHash(`${title}\u0000${evidence.slice(0, 300)}`)}`,
    160,
  )
  return {
    key: `${type}|${objectKey}|${index}`,
    object_key: objectKey,
    type,
    raw_type: typeof raw.type === 'string' && raw.type !== type ? oneLine(raw.type, 60) : undefined,
    severity,
    title,
    evidence,
    location: oneLine(raw.location ?? raw.path ?? raw.log_path ?? '', 400),
    suggestion: truncate(typeof raw.suggestion === 'string' ? raw.suggestion : '', 2000),
    source: 'agent',
  }
}

/**
 * Convert failed deterministic checks into findings.
 * @param {Array<Record<string, unknown>>} checks
 * @returns {Array<Record<string, unknown>>}
 */
export function findingsFromChecks(checks) {
  const findings = []
  for (const check of checks) {
    if (check.passed === true) continue
    if (check.passed === undefined) continue
    findings.push({
      key: `check|${check.id}|0`,
      object_key: `check:${check.id}`,
      type: check.finding_type ?? 'other',
      severity: check.severity ?? 'high',
      title: check.title ?? `检查失败：${check.id}`,
      evidence: truncate(String(check.evidence ?? ''), MAX_EVIDENCE),
      location: oneLine(check.location ?? '', 400),
      suggestion: '根据检查输出定位失败原因；修复后下一次巡检会自动复核。',
      source: 'check',
      check_id: check.id,
    })
  }
  return findings
}

/**
 * Decide the final run status.
 * @param {{
 *   turnReason: Record<string, unknown>|undefined,
 *   agentError: {message:string, code?:string}|undefined,
 *   timedOut: boolean,
 *   budgetExceeded: boolean,
 *   assistantText: string,
 *   checks: Array<Record<string, unknown>>,
 *   defaultSeverity: string,
 *   hasTurn: boolean,
 * }} input
 * @returns {{status:string, code:string|null, message:string, findings:Array<Record<string, unknown>>, summary:string, classification:Record<string, unknown>}}
 */
export function classifyOutcome(input) {
  const {
    turnReason,
    agentError,
    timedOut,
    budgetExceeded,
    assistantText,
    checks,
    defaultSeverity,
    hasTurn,
  } = input
  const checkFindings = findingsFromChecks(checks)

  const failure = (code, message, extra = {}) => ({
    status: RUN_STATUS.MONITOR_ERROR,
    code,
    message,
    findings: checkFindings,
    summary: '',
    classification: { reason: code, ...extra },
  })

  if (timedOut) return failure('timeout', '监控 Agent 超时被终止，未能完成检查')
  if (budgetExceeded) return failure('budget_exceeded', '监控 Agent 超出 token 预算被终止')
  if (agentError !== undefined) {
    return failure('agent_error', `监控 Agent 执行出错：${oneLine(agentError.message, 500)}`, {
      agentErrorCode: agentError.code ?? null,
    })
  }
  if (!hasTurn) return failure('no_turn', '监控 Agent 没有产生任何执行轮次')
  if (turnReason === undefined) return failure('no_turn_end', '监控 Agent 的最后一轮没有终止记录')
  if (turnReason.kind !== 'completed') {
    const detail = turnReason.kind === 'error'
      ? oneLine(turnReason.error?.message ?? 'unknown error', 500)
      : String(turnReason.kind)
    return failure(`turn_${String(turnReason.kind)}`, `监控 Agent 未正常完成：${detail}`, {
      turnReason: turnReason.kind,
      errorCode: turnReason.error?.code ?? null,
    })
  }

  const parsed = parseMonitorReport(assistantText)
  if (parsed.kind !== 'parsed') {
    return failure(parsed.kind === 'missing' ? 'result_missing' : 'result_invalid', parsed.reason)
  }
  const reportFindings = parsed.report.findings
    .map((raw, index) => normalizeFinding(raw, { defaultSeverity, index }))
    .filter((finding) => finding !== undefined)
  const findings = [...checkFindings, ...reportFindings]
  const summary = parsed.report.summary

  if (parsed.report.status === 'inconclusive') {
    return failure(
      'inconclusive',
      `监控未能完成全部检查：${oneLine(parsed.report.inconclusive_reason || summary || 'agent reported inconclusive', 800)}`,
      { inconclusive: true },
    )
  }
  if (findings.length > 0) {
    return {
      status: RUN_STATUS.ALERT,
      code: null,
      message: '',
      findings,
      summary,
      classification: { reason: 'findings', reportStatus: parsed.report.status },
    }
  }
  if (parsed.report.status === 'alert') {
    return failure('result_inconsistent', '监控报告声明 alert，但没有给出任何 finding')
  }
  return {
    status: RUN_STATUS.NORMAL,
    code: null,
    message: '',
    findings: [],
    summary,
    classification: { reason: 'no_findings', reportStatus: 'ok' },
  }
}

/**
 * Fold the run's durable events into final text, terminal reason, usage, and
 * turn presence.
 * @param {{eventAt:(seq:number)=>Record<string, unknown>|undefined, seq:number}} session
 * @param {number} firstSeq
 * @param {{addUsage:Function}} stateHelpers
 * @returns {{assistantText:string, turnReason:Record<string,unknown>|undefined, usage:Record<string,number>, hasTurn:boolean}}
 */
export function summarizeSession(session, firstSeq, stateHelpers) {
  let text = ''
  let turnReason
  let hasTurn = false
  const usage = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0, reasoning: 0 }
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
      const joined = (event.data?.message?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
      stateHelpers.addUsage(usage, event.data?.usage)
    }
    if (event.type === 'turn/end') turnReason = event.data?.reason
  }
  return { assistantText: text, turnReason, usage, hasTurn }
}

/** Highest severity among findings. */
export function highestSeverity(findings) {
  let rank = -1
  let severity = 'low'
  for (const finding of findings) {
    const next = severityRank(finding.severity)
    if (next > rank) {
      rank = next
      severity = finding.severity
    }
  }
  return severity
}
