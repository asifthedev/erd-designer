/** The rules of buying a plan that need no database (so they can be tested on their own). See billing.ts. */

/** `date` plus a calendar month, clamped to the end of a shorter month (Jan 31 + 1 month = Feb 28). */
export function addMonth(date: Date): Date {
  const d = new Date(date)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + 1)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d
}

/**
 * What a paid order does to the account: a monthly plan runs one month from now, or from the end of the current monthly
 * plan when it is renewed early (so paying early loses no days); a lifetime plan never ends. An account that already
 * has the lifetime plan keeps it, whatever else is paid.
 */
export function planAfterPayment(
  order: { kind: string; planId: string },
  user: { planId: string; planExpiresAt: Date | null },
  now: Date,
): { planId: string; planExpiresAt: Date | null } {
  if (user.planId === 'lifetime') return { planId: user.planId, planExpiresAt: null }
  if (order.kind === 'lifetime') return { planId: order.planId, planExpiresAt: null }
  if (order.kind === 'monthly') {
    const renewing = user.planId === order.planId && user.planExpiresAt && user.planExpiresAt > now
    return { planId: order.planId, planExpiresAt: addMonth(renewing ? user.planExpiresAt! : now) }
  }
  return { planId: 'free', planExpiresAt: null }
}
