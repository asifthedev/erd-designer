import { Router } from 'express'
import { requireAuth } from '../middleware/auth'
import { entitlementOf, listActivePlans } from '../plans'

/** The plans on offer, with their prices and what is included. Public: the pricing page is open to everyone. */
export const plansRouter = Router()

plansRouter.get('/', async (_req, res) => {
  // A short cache is enough: a price the admin changes shows within half a minute.
  res.set('Cache-Control', 'public, max-age=30')
  res.json({ plans: await listActivePlans() })
})

/** The signed-in user's own plan right now (the web app asks again after a purchase is confirmed). */
plansRouter.get('/mine', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ plan: await entitlementOf(req.user!.id) })
})
