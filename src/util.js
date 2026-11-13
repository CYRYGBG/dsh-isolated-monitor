/**
 * Small, dependency-free helpers shared by the plugin modules.
 * @module dsh-isolated-monitor/util
 */
import { createHash, randomUUID } from 'node:crypto'

/** A short, readable task id. */
export function newTaskId() {
  return `mon-${randomUUID().slice(0, 8)}`
}

/** A globally unique run id. */
export function newRunId() {
  return `run-${randomUUID()}`
}

/** A short alert id. */
export function newAlertId() {
  return `alert-${randomUUID().slice(0, 10)}`
}

/** A fresh root Session id, in the harness' own spelling. */
export function newSessionId() {
  return `session-${randomUUID()}`
}

/** Stable short hash used for de-duplication keys. */
export function shortHash(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

/** Clamp a string to `max` characters, marking truncation. */
export function truncate(value, max) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 24))}\n…[truncated ${text.length - max + 24} chars]`
}

/** Collapse all whitespace runs into one space and clamp the result. */
export function oneLine(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return truncate(text, max)
}

/** Return a finite number or `undefined`. */
export function numberOrUndefined(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Return a positive integer or `undefined`. */
export function positiveInt(value) {
  const n = numberOrUndefined(value)
  return n !== undefined && n > 0 && Number.isInteger(n) ? n : undefined
}

/** Deep clone via JSON, preserving only JSON-safe data. */
export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** `true` for a plain object (not an array, not null). */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `true` for an absolute path on the current platform. */
export function isAbsolutePath(value, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (platform === 'win32') return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
  return value.startsWith('/')
}
