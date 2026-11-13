/**
 * Optional deterministic preflight checks.
 *
 * Command checks run through the Agent's own tool pipeline
 * (`ctx.tools.execute`), so the session sandbox, approval policy, output
 * logging, and cancellation all apply exactly as they would to a model call —
 * without spending a token. File checks read with `fs` directly.
 * @module dsh-isolated-monitor/checks
 */
import { readFile, stat } from 'node:fs/promises'
import { truncate } from './util.js'

const MAX_READ_BYTES = 5 * 1024 * 1024

/**
 * @param {{ctx: any, logger: {warn:Function}}} options
 */
export function createCheckRunner({ ctx, logger }) {
  /**
   * @param {{agent:any, checks:Array<Record<string,any>>, signal?:AbortSignal}} input
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function run({ agent, checks, signal }) {
    const results = []
    for (const check of checks) {
      if (signal?.aborted === true) break
      try {
        results.push(
          check.kind === 'command'
            ? await runCommand({ agent, check, signal })
            : await runFileCheck({ check }),
        )
      } catch (error) {
        results.push({
          ...base(check),
          passed: undefined,
          evidence: `check could not run: ${String(error?.message ?? error)}`,
          location: check.command ?? check.path ?? '',
        })
      }
    }
    return results
  }

  async function runCommand({ agent, check, signal }) {
    const toolName = check.shell === 'bash' ? 'bash' : 'pwsh'
    const batch = await ctx.tools.execute({
      calls: [
        {
          id: `mon-check-${check.id}-${Date.now()}`,
          name: toolName,
          arguments: JSON.stringify({
            description: `Monitor check: ${check.title}`,
            command: check.command,
            timeoutMs: check.timeout_ms,
            workdir: agent.session.header.cwd,
          }),
        },
      ],
      agent,
      ...(signal === undefined ? {} : { signal }),
    })
    const settled = batch?.results?.[0]?.result
    if (settled === undefined) {
      return { ...base(check), passed: undefined, evidence: 'the tool pipeline returned no result', location: check.command }
    }
    if (settled.isError === true) {
      const reason = settled.error?.reason ?? settled.error?.message ?? settled.error?.code ?? 'tool error'
      return {
        ...base(check),
        passed: undefined,
        evidence: `check command could not be executed: ${String(reason)}`,
        location: check.command,
      }
    }
    const value = settled.value ?? {}
    const output = typeof value.output === 'string' ? value.output : contentText(settled.content)
    const exitCode = typeof value.exitCode === 'number' ? value.exitCode : null
    const expectedExit = check.expect_exit_code
    let passed = exitCode === expectedExit
    if (passed && check.stdout_includes !== '') passed = output.includes(check.stdout_includes)
    if (passed && check.stdout_excludes !== '') passed = !output.includes(check.stdout_excludes)
    if (passed && check.stdout_matches !== '') {
      try {
        passed = new RegExp(check.stdout_matches, 'm').test(output)
      } catch {
        return { ...base(check), passed: undefined, evidence: `invalid stdout_matches regex: ${check.stdout_matches}` }
      }
    }
    if (check.expect_failure === true) passed = !passed
    return {
      ...base(check),
      passed,
      exit_code: exitCode,
      evidence: truncate(
        [
          `$ ${check.command}`,
          `exit code: ${exitCode === null ? '(unknown)' : exitCode}`,
          output.trim() === '' ? '(no output)' : output,
        ].join('\n'),
        5000,
      ),
      location: `${toolName}: ${check.command}`,
    }
  }

  async function runFileCheck({ check }) {
    if (check.kind === 'file_exists') {
      let exists = false
      let size = 0
      try {
        const info = await stat(check.path)
        exists = info.isFile()
        size = info.size
      } catch {
        exists = false
      }
      const passed = exists === check.exists && (check.min_bytes === 0 || size >= check.min_bytes)
      return {
        ...base(check),
        passed,
        evidence: `exists=${exists} size=${size} bytes (expected exists=${check.exists}${check.min_bytes ? `, min ${check.min_bytes} bytes` : ''})`,
        location: check.path,
      }
    }
    let content
    try {
      const info = await stat(check.path)
      if (info.size > MAX_READ_BYTES) {
        return { ...base(check), passed: undefined, evidence: `file is larger than ${MAX_READ_BYTES} bytes`, location: check.path }
      }
      content = await readFile(check.path, 'utf8')
    } catch (error) {
      if (check.must_match === true) {
        return { ...base(check), passed: false, evidence: `cannot read ${check.path}: ${String(error?.message ?? error)}`, location: check.path }
      }
      return { ...base(check), passed: true, evidence: `file is absent, which is the expected state: ${String(error?.message ?? error)}`, location: check.path }
    }
    let regex
    try {
      regex = new RegExp(check.pattern, 'm')
    } catch (error) {
      return { ...base(check), passed: undefined, evidence: `invalid pattern: ${String(error?.message ?? error)}`, location: check.path }
    }
    const match = regex.exec(content)
    const passed = check.must_match === true ? match !== null : match === null
    const evidence = match === null
      ? `pattern ${check.pattern} did not match`
      : content.slice(Math.max(0, match.index - 200), Math.min(content.length, match.index + 600))
    return {
      ...base(check),
      passed,
      evidence: truncate(`${match === null ? 'no match' : 'matched'} /${check.pattern}/\n${evidence}`, 4000),
      location: check.path,
    }
  }

  function base(check) {
    return {
      id: check.id,
      kind: check.kind,
      title: check.title,
      severity: check.severity,
      finding_type: check.finding_type ?? 'other',
      command: check.command,
      path: check.path,
    }
  }

  return { run }
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
}
