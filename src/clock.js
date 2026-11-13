/**
 * Time helpers. Pure `Intl` + injected caldendar adapters: no direct
 * dependency on the harness time package, so this module is unit-testable.
 * @module dsh-isolated-monitor/clock
 */

/** Canonical UTC ISO string with milliseconds. */
export function iso(epochMs) {
  return new Date(epochMs).toISOString()
}

/** Parse any ISO instant; `undefined` for an unusable value. */
export function epochOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) ? epoch : undefined
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** ISO weekday numbers (Monday=1 … Sunday=7) in order. */
export const ISO_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

/**
 * Local calendar fields of one instant in an IANA zone.
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, second:number, weekday:number}}
 */
export function zoneParts(epochMs, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  const weekday = WEEKDAYS.indexOf(parts.weekday) + 1
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekday === 0 ? 7 : weekday,
  }
}

/**
 * Resolve wall-clock fields in a zone to an epoch instant.
 * @param {{year:number, month:number, day:number, hour:number, minute:number, second:number}} fields
 * @param {string} timeZone
 * @param {(date:string, time:string, zone:string) => number|undefined} resolve
 * @returns {number|undefined} `undefined` inside a DST gap or for invalid input.
 */
export function localEpoch(fields, timeZone, resolve) {
  const date = `${String(fields.year).padStart(4, '0')}-${String(fields.month).padStart(2, '0')}-${String(fields.day).padStart(2, '0')}`
  const time = `${String(fields.hour).padStart(2, '0')}:${String(fields.minute).padStart(2, '0')}:${String(fields.second ?? 0).padStart(2, '0')}`
  try {
    return resolve(date, time, timeZone)
  } catch {
    return undefined
  }
}

/** Add whole days to a calendar date triple, using UTC arithmetic. */
export function addDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day))
  d.setUTCDate(d.getUTCDate() + days)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Parse `HH:mm` or `HH:mm:ss` into clock fields. */
export function parseClock(value) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] ?? '0')
  if (hour > 23 || minute > 59 || second > 59) return undefined
  return { hour, minute, second }
}

/** Format millisecond duration for humans. */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m${totalSeconds % 60 === 0 ? '' : ` ${totalSeconds % 60}s`}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h${minutes % 60 === 0 ? '' : ` ${minutes % 60}m`}`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24 === 0 ? '' : ` ${hours % 24}h`}`
}

/** Canonical IANA zone check through `Intl`; returns the canonical name or undefined. */
export function canonicalZone(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** Host zone, used when the task names none. */
export function hostTimeZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
