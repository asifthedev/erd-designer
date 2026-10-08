import { describe, expect, it } from 'vitest'
import { initials, tableCountLabel, timeAgo } from './time'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('timeAgo', () => {
  it('speaks in short, plain units', () => {
    expect(timeAgo(ago(5_000), NOW)).toBe('just now')
    expect(timeAgo(ago(5 * MIN), NOW)).toBe('5m ago')
    expect(timeAgo(ago(59 * MIN), NOW)).toBe('59m ago')
    expect(timeAgo(ago(2 * HOUR), NOW)).toBe('2h ago')
    expect(timeAgo(ago(23 * HOUR), NOW)).toBe('23h ago')
    expect(timeAgo(ago(30 * HOUR), NOW)).toBe('yesterday')
    expect(timeAgo(ago(3 * DAY), NOW)).toBe('3d ago')
    expect(timeAgo(ago(15 * DAY), NOW)).toBe('2w ago')
  })

  it('shows a date for anything older than a month, and survives a clock that is behind or bad input', () => {
    expect(timeAgo(ago(90 * DAY), NOW)).toMatch(/2026/)
    expect(timeAgo(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe('just now')
    expect(timeAgo('not a date', NOW)).toBe('')
  })
})

describe('tableCountLabel', () => {
  it('reads naturally', () => {
    expect(tableCountLabel(0)).toBe('Empty')
    expect(tableCountLabel(1)).toBe('1 table')
    expect(tableCountLabel(12)).toBe('12 tables')
    expect(tableCountLabel(undefined)).toBe('')
  })
})

describe('initials', () => {
  it('uses the first letters of the first two words, or the first two letters of one', () => {
    expect(initials('Asif Shahzad')).toBe('AS')
    expect(initials('ada@example.com')).toBe('AD')
    expect(initials('mary.jane')).toBe('MJ')
    expect(initials('  x ')).toBe('X')
    expect(initials('')).toBe('?')
  })
})
