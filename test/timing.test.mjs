import assert from 'node:assert/strict'
import test from 'node:test'
import { createTiming, ScheduleError } from '../src/timing.js'

const adapters = {
  Cron: {
    parse(expression, zone) {
      const match = /^\*\/(\d+) \* \* \* \*$/.exec(expression)
      if (match === null) return { kind: 'rejected', reason: 'syntax' }
      const step = Number(match[1]) * 60_000
      return {
        kind: 'accepted',
        rule: {
          next(after) {
            return Math.ceil((after + 1) / step) * step
          },
        },
      }
    },
  },
  RRule: {
    parse(expression) {
      if (!expression.includes('RRULE:')) return { kind: 'rejected', reason: 'syntax' }
      return { kind: 'accepted', rule: { next: (after) => after + 3_600_000 } }
    },
  },
  resolveLocalInstant(date, time) {
    const epoch = Date.parse(`${date}T${time}Z`)
    return Number.isFinite(epoch) ? epoch : undefined
  },
}

const timing = createTiming(adapters)
const NOW = Date.parse('2026-11-13T10:00:00.000Z')

test('every: first occurrence is one interval after creation and missed runs coalesce', () => {
  const { schedule, firstAt } = timing.normalizeSchedule(
    { kind: 'every', every_seconds: 1800 },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(firstAt, NOW + 1_800_000)
  assert.equal(schedule.anchor_at, new Date(NOW).toISOString())
  // Long downtime collapses to one future occurrence.
  const late = NOW + 10 * 1_800_000 + 5
  const next = timing.nextOccurrence(schedule, { afterEpoch: late, lastOccurrenceEpoch: firstAt })
  assert.equal(next, firstAt + 10 * 1_800_000)
  assert.ok(next > late)
})

test('every rejects intervals under one minute and non-integers', () => {
  assert.throws(
    () => timing.normalizeSchedule({ kind: 'every', every_seconds: 10 }, { now: NOW, defaultTimeZone: 'UTC' }),
    (error) => error instanceof ScheduleError && error.code === 'invalid_schedule',
  )
  assert.throws(
    () => timing.normalizeSchedule({ kind: 'every', every_seconds: 60.5 }, { now: NOW, defaultTimeZone: 'UTC' }),
    ScheduleError,
  )
})

test('daily: next wall-clock occurrence is strictly after now', () => {
  const { schedule, firstAt } = timing.normalizeSchedule(
    { kind: 'daily', time: '09:30', time_zone: 'UTC' },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(new Date(firstAt).toISOString(), '2026-11-14T09:30:00.000Z')
  assert.equal(timing.nextOccurrence(schedule, { afterEpoch: firstAt + 1 }), Date.parse('2026-11-15T09:30:00.000Z'))
})

test('weekly: selects the requested ISO weekday', () => {
  // 2026-11-13 is a Friday.
  const { firstAt } = timing.normalizeSchedule(
    { kind: 'weekly', time: '08:00', weekday: 1, time_zone: 'UTC' },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(new Date(firstAt).toISOString(), '2026-11-16T08:00:00.000Z')
})

test('cron and rrule delegate to the official recurrence values', () => {
  const cron = timing.normalizeSchedule(
    { kind: 'cron', expression: '*/15 * * * *', time_zone: 'UTC' },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(cron.schedule.expression, '*/15 * * * *')
  assert.equal(cron.firstAt, Date.parse('2026-11-13T10:15:00.000Z'))
  assert.equal(
    timing.nextOccurrence(cron.schedule, { afterEpoch: cron.firstAt }),
    Date.parse('2026-11-13T10:30:00.000Z'),
  )
  assert.throws(
    () => timing.normalizeSchedule({ kind: 'cron', expression: 'bogus', time_zone: 'UTC' }, { now: NOW, defaultTimeZone: 'UTC' }),
    (error) => error.code === 'invalid_cron',
  )
  const rrule = timing.normalizeSchedule(
    { kind: 'rrule', rrule: 'DTSTART:20261113T100000Z\nRRULE:FREQ=HOURLY' },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(rrule.firstAt, NOW + 3_600_000)
})

test('once and after run exactly once', () => {
  const once = timing.normalizeSchedule(
    { kind: 'once', at: '2026-11-14T00:00:00+08:00' },
    { now: NOW, defaultTimeZone: 'UTC' },
  )
  assert.equal(once.firstAt, Date.parse('2026-11-13T16:00:00.000Z'))
  assert.equal(timing.nextOccurrence(once.schedule, { afterEpoch: once.firstAt }), null)
  const after = timing.normalizeSchedule({ kind: 'after', after_seconds: 120 }, { now: NOW, defaultTimeZone: 'UTC' })
  assert.equal(after.firstAt, NOW + 120_000)
  assert.equal(timing.nextOccurrence(after.schedule, { afterEpoch: NOW }), NOW + 120_000)
})

test('unknown time zone and unknown kind are refused', () => {
  assert.throws(
    () => timing.normalizeSchedule({ kind: 'daily', time: '09:00', time_zone: 'Mars/Olympus' }, { now: NOW, defaultTimeZone: 'UTC' }),
    (error) => error.code === 'invalid_time_zone',
  )
  assert.throws(
    () => timing.normalizeSchedule({ kind: 'sometimes' }, { now: NOW, defaultTimeZone: 'UTC' }),
    (error) => error.code === 'invalid_schedule',
  )
})

test('describeSchedule renders every kind', () => {
  for (const input of [
    { kind: 'once', at: '2026-11-14T00:00:00Z' },
    { kind: 'after', after_seconds: 60 },
    { kind: 'every', every_seconds: 3600 },
    { kind: 'daily', time: '09:00', time_zone: 'UTC' },
    { kind: 'weekly', time: '09:00', weekday: 3, time_zone: 'UTC' },
    { kind: 'cron', expression: '*/5 * * * *', time_zone: 'UTC' },
    { kind: 'rrule', rrule: 'DTSTART:20261113T100000Z\nRRULE:FREQ=DAILY' },
  ]) {
    const { schedule } = timing.normalizeSchedule(input, { now: NOW, defaultTimeZone: 'UTC' })
    assert.equal(typeof timing.describeSchedule(schedule), 'string')
    assert.ok(timing.describeSchedule(schedule).length > 0)
  }
})
