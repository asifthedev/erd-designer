import { describe, expect, it } from 'vitest'
import { addMonth, planAfterPayment } from './billingRules'

const at = (iso: string) => new Date(iso)

describe('addMonth', () => {
  it('adds a calendar month', () => {
    expect(addMonth(at('2026-03-10T12:00:00Z')).toISOString()).toBe('2026-04-10T12:00:00.000Z')
    expect(addMonth(at('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-15T00:00:00.000Z')
  })

  it('stops at the end of a shorter month instead of spilling into the next', () => {
    expect(addMonth(at('2026-01-31T09:00:00Z')).toISOString()).toBe('2026-02-28T09:00:00.000Z')
    expect(addMonth(at('2028-01-31T09:00:00Z')).toISOString()).toBe('2028-02-29T09:00:00.000Z') // leap year
    expect(addMonth(at('2026-03-31T09:00:00Z')).toISOString()).toBe('2026-04-30T09:00:00.000Z')
  })
})

describe('planAfterPayment', () => {
  const now = at('2026-10-08T10:00:00Z')
  const free = { planId: 'free', planExpiresAt: null }
  const monthly = (iso: string | null) => ({ planId: 'monthly', planExpiresAt: iso ? at(iso) : null })

  it('starts a monthly plan a month from now', () => {
    expect(planAfterPayment({ kind: 'monthly', planId: 'monthly' }, free, now)).toEqual({
      planId: 'monthly',
      planExpiresAt: at('2026-11-08T10:00:00Z'),
    })
  })

  it('renewing early adds the month after the current end, so no paid days are lost', () => {
    const r = planAfterPayment({ kind: 'monthly', planId: 'monthly' }, monthly('2026-10-20T00:00:00Z'), now)
    expect(r.planExpiresAt).toEqual(at('2026-11-20T00:00:00Z'))
  })

  it('renewing after the plan ran out starts from now, not from the old end date', () => {
    const r = planAfterPayment({ kind: 'monthly', planId: 'monthly' }, monthly('2026-09-01T00:00:00Z'), now)
    expect(r.planExpiresAt).toEqual(at('2026-11-08T10:00:00Z'))
  })

  it('a lifetime plan never ends, and replaces a running monthly one', () => {
    expect(planAfterPayment({ kind: 'lifetime', planId: 'lifetime' }, monthly('2026-10-20T00:00:00Z'), now)).toEqual({
      planId: 'lifetime',
      planExpiresAt: null,
    })
  })

  it('an account that already has the lifetime plan keeps it whatever is paid later', () => {
    const lifetime = { planId: 'lifetime', planExpiresAt: null }
    expect(planAfterPayment({ kind: 'monthly', planId: 'monthly' }, lifetime, now)).toEqual(lifetime)
  })
})
