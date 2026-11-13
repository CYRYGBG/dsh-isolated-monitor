/**
 * Plugin configuration: pure defaults, normalization, and the schemastery
 * schema factory used by the plugin entry.
 * @module dsh-isolated-monitor/config
 */

/** Deployment defaults; every task field can override the matching default. */
export const DEFAULTS = Object.freeze({
  dataDir: '',
  timeZone: '',
  defaultTimeoutSeconds: 900,
  defaultRetryMaxAttempts: 1,
  defaultRetryBaseSeconds: 60,
  maxConcurrentRuns: 2,
  historyLimit: 200,
  runArtifactRetentionDays: 30,
  alertTextMaxChars: 6000,
  maxRunPromptChars: 60000,
  enableCommand: true,
  allowUnenforcedReadOnly: false,
  defaultAgentPreset: '',
  pollingMaxSeconds: 60,
  notifyRetryMaxAttempts: 0,
  notifyRetryBaseSeconds: 60,
  maxAlertsPerDay: 100,
})

const INTEGER_BOUNDS = {
  defaultTimeoutSeconds: [30, 24 * 60 * 60],
  defaultRetryMaxAttempts: [0, 10],
  defaultRetryBaseSeconds: [5, 3600],
  maxConcurrentRuns: [1, 16],
  historyLimit: [20, 5000],
  runArtifactRetentionDays: [1, 3650],
  alertTextMaxChars: [500, 20000],
  maxRunPromptChars: [1000, 500000],
  pollingMaxSeconds: [5, 3600],
  notifyRetryMaxAttempts: [0, 1000],
  notifyRetryBaseSeconds: [5, 3600],
  maxAlertsPerDay: [1, 10000],
}

const STRINGS = ['dataDir', 'timeZone', 'defaultAgentPreset']
const BOOLEANS = ['enableCommand', 'allowUnenforcedReadOnly']

/**
 * Normalize a raw deployment config into the effective form.
 * @param {Record<string, unknown>|undefined} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS }
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  for (const key of STRINGS) {
    const value = source[key]
    if (typeof value === 'string') config[key] = value.trim()
  }
  for (const key of BOOLEANS) {
    const value = source[key]
    if (typeof value === 'boolean') config[key] = value
  }
  for (const [key, [min, max]] of Object.entries(INTEGER_BOUNDS)) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      config[key] = Math.min(max, Math.max(min, Math.trunc(value)))
    }
  }
  return config
}

/**
 * Build the schemastery schema for the profile patch. Kept here so the
 * normalization rules and the declared schema cannot drift.
 * @param {import('@deepseek-ai/schemastery').default} z
 * @returns {unknown}
 */
export function createConfigSchema(z) {
  const int = (description, fallback) =>
    z.number().step(1).default(fallback).description(description)
  return z.object({
    dataDir: z
      .string()
      .default(DEFAULTS.dataDir)
      .description('Plugin data directory; empty uses <DSH_HOME>/isolated-monitor.'),
    timeZone: z
      .string()
      .default(DEFAULTS.timeZone)
      .description('Default IANA zone for wall-clock schedules; empty uses the host zone.'),
    defaultTimeoutSeconds: int('Per-run agent timeout when a task names none.', DEFAULTS.defaultTimeoutSeconds),
    defaultRetryMaxAttempts: int('Default extra attempts for a failed run.', DEFAULTS.defaultRetryMaxAttempts),
    defaultRetryBaseSeconds: int('Default backoff base between run attempts.', DEFAULTS.defaultRetryBaseSeconds),
    maxConcurrentRuns: int('Maximum monitor runs executing at the same time.', DEFAULTS.maxConcurrentRuns),
    historyLimit: int('Retained runs per task; older records are pruned.', DEFAULTS.historyLimit),
    runArtifactRetentionDays: int('Days to keep per-run evidence artifacts.', DEFAULTS.runArtifactRetentionDays),
    alertTextMaxChars: int('Maximum characters in one alert message.', DEFAULTS.alertTextMaxChars),
    maxRunPromptChars: int('Maximum characters of the composed monitor prompt.', DEFAULTS.maxRunPromptChars),
    enableCommand: z
      .boolean()
      .default(DEFAULTS.enableCommand)
      .description('Register the /monitor slash command.'),
    allowUnenforcedReadOnly: z
      .boolean()
      .default(DEFAULTS.allowUnenforcedReadOnly)
      .description('Allow runs when read-only could not be enforced (not recommended).'),
    defaultAgentPreset: z
      .string()
      .default(DEFAULTS.defaultAgentPreset)
      .description('Agent preset for monitor sessions; empty uses the host default.'),
    pollingMaxSeconds: int('Upper bound of one scheduler sleep.', DEFAULTS.pollingMaxSeconds),
    notifyRetryMaxAttempts: int('Alert redelivery attempts; 0 retries until delivered.', DEFAULTS.notifyRetryMaxAttempts),
    notifyRetryBaseSeconds: int('Base backoff for alert redelivery.', DEFAULTS.notifyRetryBaseSeconds),
    maxAlertsPerDay: int('Daily alert cap per task; extra events stay pending.', DEFAULTS.maxAlertsPerDay),
  })
}
