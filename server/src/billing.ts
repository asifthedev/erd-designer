import { prisma } from './db'
import { planAfterPayment } from './billingRules'

/**
 * Buying a plan, without a payment gateway. The buyer places an order, pays the way the payment instructions say, and
 * the admin marks the order paid; that is the moment the plan starts. (A gateway would call the same `activateOrder`
 * from its webhook instead of the admin's button.)
 */

export const DEFAULT_PAYMENT_INSTRUCTIONS =
  'We will contact you on your account email with the payment details. Your plan starts as soon as the payment is confirmed.'
const INSTRUCTIONS_KEY = 'payment_instructions'

export async function paymentInstructions(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: INSTRUCTIONS_KEY } })
  return row?.value.trim() ? row.value : DEFAULT_PAYMENT_INSTRUCTIONS
}

export async function savePaymentInstructions(text: string) {
  await prisma.appSetting.upsert({
    where: { key: INSTRUCTIONS_KEY },
    create: { key: INSTRUCTIONS_KEY, value: text },
    update: { value: text },
  })
}

/** Marks an order paid and starts the plan on the account, in one transaction. Paying twice changes nothing. */
export async function activateOrder(orderId: string): Promise<'activated' | 'already_paid' | 'cancelled' | 'missing'> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { plan: true } })
    if (!order) return 'missing'
    if (order.status === 'paid') return 'already_paid'
    if (order.status === 'cancelled') return 'cancelled'
    const user = await tx.user.findUniqueOrThrow({
      where: { id: order.userId },
      select: { planId: true, planExpiresAt: true },
    })
    const now = new Date()
    await tx.user.update({
      where: { id: order.userId },
      data: planAfterPayment({ kind: order.plan.kind, planId: order.planId }, user, now),
    })
    await tx.order.update({ where: { id: orderId }, data: { status: 'paid', paidAt: now } })
    return 'activated'
  })
}
