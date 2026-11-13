/**
 * Schedule validation and occurrence arithmetic.
 *
 * The harness' own `Cron` / `RRule` values are injected through `adapters`, so
 * this module never re-implements cron/RRULE parsing and stays testable
 * without the harness runtime.
 * @module dsh-isolated-monitor/timing
 */
import {
  addDays,
  canonicalZone,
  epochOf,
  iso,
  localEpoch,
  parseClock,
  zoneParts,
} from './clock.js'

/** A rejected schedule or option, carrying a stable code. */
export class ScheduleError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ScheduleError'
    this.code = code
  }
}

/** Kinds a task may declare. */
export const SCHEDULE_KINDS = ['once', 'after', 'every', 'daily', 'weekly', 'cron', 'rrule']

const MIN_EVERY_SECONDS = 60
const MAX_EVERY_SECONDS = 365 * 24 * 60 * 60
const ruleCache = new Map()

/**
 * Build the schedule helpers over injected recurrence adapters.
 * @param {{
 *   Cron: { parse: (expression: string, zone: string) => {kind: string, rule?: unknown, reason?: string}},
 *   RRule: { parse: (expression: string) => {kind: string, rule?: unknown, reason?: string}},
 *   resolveLocalInstant: (date: string, time: string, zone: string) => number|undefined,
 * }} adapters
 */
export function createTiming(adapters) {
  const resolveLocal = (date, time, zone) => {
    const value = adapters.resolveLocalInstant(date, time, zone)
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  const parseCron = (expression, zone) => {
    const key = `cron:${expression}\u0000${zone}`
    if (ruleCache.has(key)) return ruleCache.get(key)
    const parsed = adapters.Cron.parse(expression, zone)
    const rule = parsed?.kind === 'accepted' ? parsed.rule : undefined
    ruleCache.set(key, rule)
    return rule
  }

  const parseRrule = (expression) => {
    const key = `rrule:${expression}`
    if (ruleCache.has(key)) return ruleCache.get(key)
    const parsed = adapters.RRule.parse(expression)
    const rule = parsed?.kind === 'accepted' ? parsed.rule : undefined
    ruleCache.set(key, rule)
    return rule
  }

  /**
   * Validate and canonicalize one schedule input.
   * @param {Record<string, unknown>} input
   * @param {{now: number, defaultTimeZone: string}} options
   * @returns {{schedule: Record<string, unknown>, firstAt: number}}
   */
  function normalizeSchedule(input, { now, defaultTimeZone }) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ScheduleError('invalid_schedule', 'schedule must be an object')
    }
    const kind = input.kind
    if (!SCHEDULE_KINDS.includes(kind)) {
      throw new ScheduleError(
        'invalid_schedule',
        `schedule.kind must be one of ${SCHEDULE_KINDS.join(', ')}`,
      )
    }
    const zoneOf = (value) => {
      const zone = canonicalZone(typeof value === 'string' && value.trim() !== '' ? value : defaultTimeZone)
      if (zone === undefined) throw new ScheduleError('invalid_time_zone', `unknown IANA time zone: ${String(value)}`)
      return zone
    }

    switch (kind) {
      case 'once': {
        const at = epochOf(input.at)
        if (at === undefined) throw new ScheduleError('invalid_schedule', 'schedule.at must be an ISO instant')
        return { schedule: { kind: 'once', at: iso(at) }, firstAt: at }
      }
      case 'after': {
        const seconds = Number(input.after_seconds)
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_EVERY_SECONDS) {
          throw new ScheduleError('invalid_schedule', 'schedule.after_seconds must be between 1 and 31536000')
        }
        const at = now + Math.trunc(seconds) * 1000
        return { schedule: { kind: 'after', after_seconds: Math.trunc(seconds), at: iso(at) }, firstAt: at }
      }
      case 'every': {
        const seconds = Number(input.every_seconds)
        if (!Number.isInteger(seconds) || seconds < MIN_EVERY_SECONDS || seconds > MAX_EVERY_SECONDS) {
          throw new ScheduleError(
            'invalid_schedule',
            `schedule.every_seconds must be an integer between ${MIN_EVERY_SECONDS} and ${MAX_EVERY_SECONDS}`,
          )
        }
        return {
          schedule: { kind: 'every', every_seconds: seconds, anchor_at: iso(now) },
          firstAt: now + seconds * 1000,
        }
      }
      case 'daily': {
        const zone = zoneOf(input.time_zone)
        const clock = parseClock(input.time)
        if (clock === undefined) throw new ScheduleError('invalid_schedule', 'schedule.time must be HH:mm')
        const schedule = { kind: 'daily', time: `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`, time_zone: zone }
        return { schedule, firstAt: nextWallClock(schedule, now, resolveLocal) }
      }
      case 'weekly': {
        const zone = zoneOf(input.time_zone)
        const clock = parseClock(input.time)
        if (clock === undefined) throw new ScheduleError('invalid_schedule', 'schedule.time must be HH:mm')
        const weekday = Number(input.weekday)
        if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
          throw new ScheduleError('invalid_schedule', 'schedule.weekday must be 1 (Monday) through 7 (Sunday)')
        }
        const schedule = {
          kind: 'weekly',
          time: `${pad(clock.hour)}:${pad(clock.minute)}:${pad(clock.second)}`,
          weekday,
          time_zone: zone,
        }
        return { schedule, firstAt: nextWallClock(schedule, now, resolveLocal) }
      }
      case 'cron': {
        const zone = zoneOf(input.time_zone)
        const expression = typeof input.expression === 'string' ? input.expression.trim() : ''
        if (expression === '') throw new ScheduleError('invalid_schedule', 'schedule.expression is required')
        const rule = parseCron(expression, zone)
        if (rule === undefined) throw new ScheduleError('invalid_cron', `invalid cron expression: ${expression}`)
        const firstAt = rule.next(now)
        if (firstAt === undefined || firstAt === null) {
          throw new ScheduleError('schedule_exhausted', 'the cron expression has no future occurrence')
        }
        return { schedule: { kind: 'cron', expression, time_zone: zone }, firstAt }
      }
      case 'rrule': {
        const expression = typeof input.rrule === 'string' ? input.rrule.trim() : ''
        if (expression === '') throw new ScheduleError('invalid_schedule', 'schedule.rrule is required')
        const rule = parseRrule(expression)
        if (rule === undefined) throw new ScheduleError('invalid_rrule', 'invalid RRULE expression')
        const firstAt = rule.next(now)
        if (firstAt === undefined || firstAt === null) {
          throw new ScheduleError('schedule_exhausted', 'the RRULE has no future occurrence')
        }
        return { schedule: { kind: 'rrule', rrule: expression }, firstAt }
      }
      default:
        throw new ScheduleError('invalid_schedule', `unsupported schedule kind: ${String(kind)}`)
    }
  }

  /**
   * Next occurrence strictly after `afterEpoch`.
   * @param {Record<string, unknown>} schedule
   * @param {{afterEpoch: number, lastOccurrenceEpoch?: number}} options
   * @returns {number|null} `null` when the schedule is exhausted.
   */
  function nextOccurrence(schedule, { afterEpoch, lastOccurrenceEpoch }) {
    switch (schedule.kind) {
      case 'once':
      case 'after': {
        const at = epochOf(schedule.at)
        return at !== undefined && at > afterEpoch ? at : null
      }
      case 'every': {
        const interval = Number(schedule.every_seconds) * 1000
        const anchor = epochOf(schedule.anchor_at) ?? afterEpoch
        let next = (lastOccurrenceEpoch ?? anchor) + interval
        let guard = 0
        while (next <= afterEpoch && guard < 100000) {
          next += interval
          guard += 1
        }
        return next
      }
      case 'daily':
      case 'weekly':
        return nextWallClock(schedule, Math.max(afterEpoch, lastOccurrenceEpoch ?? 0), resolveLocal)
      case 'cron': {
        const rule = parseCron(schedule.expression, schedule.time_zone)
        if (rule === undefined) return null
        const value = rule.next(Math.max(afterEpoch, lastOccurrenceEpoch ?? 0))
        return value === undefined ? null : value
      }
      case 'rrule': {
        const rule = parseRrule(schedule.rrule)
        if (rule === undefined) return null
        const value = rule.next(Math.max(afterEpoch, lastOccurrenceEpoch ?? 0))
        return value === undefined ? null : value
      }
      default:
        return null
    }
  }

  /**
   * Human-readable schedule description.
   * @param {Record<string, unknown>} schedule
   * @returns {string}
   */
  function describeSchedule(schedule) {
    switch (schedule?.kind) {
      case 'once':
        return `一次性 · ${schedule.at}`
      case 'after':
        return `延迟 ${schedule.after_seconds}s 后执行一次`
      case 'every':
        return `每 ${formatSeconds(schedule.every_seconds)}`
      case 'daily':
        return `每天 ${String(schedule.time).slice(0, 5)} (${schedule.time_zone})`
      case 'weekly':
        return `每周${['一', '二', '三', '四', '五', '六', '日'][Number(schedule.weekday) - 1]} ${String(schedule.time).slice(0, 5)} (${schedule.time_zone})`
      case 'cron':
        return `cron ${schedule.expression} (${schedule.time_zone})`
      case 'rrule':
        return `rrule ${String(schedule.rrule).replace(/\n/g, ' · ')}`
      default:
        return '未知调度'
    }
  }

  return { normalizeSchedule, nextOccurrence, describeSchedule }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** ISO weekday (Monday=1 … Sunday=7) of a calendar date. */
function isoWeekday({ year, month, day }) {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

function formatSeconds(seconds) {
  const n = Number(seconds)
  if (n % 3600 === 0) return `${n / 3600} 小时`
  if (n % 60 === 0) return `${n / 60} 分钟`
  return `${n} 秒`
}

/**
 * Next wall-clock occurrence for daily/weekly schedules.
 * @param {Record<string, unknown>} schedule
 * @param {number} afterEpoch
 * @param {(date:string,time:string,zone:string)=>number|undefined} resolveLocal
 * @returns {number}
 */
function nextWallClock(schedule, afterEpoch, resolveLocal) {
  const zone = schedule.time_zone
  const clock = parseClock(schedule.time)
  if (clock === undefined) throw new ScheduleError('invalid_schedule', 'stored schedule has an invalid clock time')
  const today = zoneParts(afterEpoch, zone)
  const start = { year: today.year, month: today.month, day: today.day }
  for (let offset = 0; offset <= 15; offset += 1) {
    const date = addDays(start, offset)
    if (schedule.kind === 'weekly' && isoWeekday(date) !== Number(schedule.weekday)) continue
    const candidate = localEpoch({ ...date, ...clock }, zone, resolveLocal)
    if (candidate !== undefined && candidate > afterEpoch) return candidate
  }
  throw new ScheduleError('schedule_exhausted', 'no wall-clock occurrence found in the next 15 days')
}
