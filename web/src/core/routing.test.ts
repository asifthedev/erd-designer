import { describe, expect, it } from 'vitest'
import { routePoints, routeX, sidesForRects, STUB, stubLength, TURN, type Dir } from './routing'

type Box = { left: number; right: number; top: number; bottom: number }

/** Small seeded generator, so a failing layout can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

const overlaps2D = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Does the axis-aligned segment p->q pass through the inside of the box? (touching the border is fine) */
function cuts(box: Box, [x1, y1]: [number, number], [x2, y2]: [number, number]) {
  if (y1 === y2) {
    return y1 > box.top && y1 < box.bottom && Math.max(x1, x2) > box.left && Math.min(x1, x2) < box.right
  }
  return x1 > box.left && x1 < box.right && Math.max(y1, y2) > box.top && Math.min(y1, y2) < box.bottom
}

describe('sidesForRects', () => {
  const box = (left: number, width = 680) => ({ left, right: left + width })

  it('joins tables that are side by side across the gap, however small it is', () => {
    expect(sidesForRects(box(0), box(800))).toEqual(['r', 'l'])
    expect(sidesForRects(box(800), box(0))).toEqual(['l', 'r'])
    expect(sidesForRects(box(0), box(680 + 2 * STUB))).toEqual(['r', 'l'])
    expect(sidesForRects(box(0), box(690))).toEqual(['r', 'l']) // 10px gap: going round would cut through a table
  })

  it('uses one shared side when the tables overlap in x, i.e. are stacked (the screenshot case)', () => {
    expect(sidesForRects(box(0), box(300))[0]).toBe(sidesForRects(box(0), box(300))[1])
    expect(sidesForRects(box(0), box(680))[0]).toBe(sidesForRects(box(0), box(680))[1]) // touching edges: no gap
  })

  it('picks the side with the shorter detour', () => {
    // b hangs out to the right of a: going round the right side costs 120, the left side 560
    expect(sidesForRects({ left: 0, right: 680 }, { left: 120, right: 800 })).toEqual(['r', 'r'])
    expect(sidesForRects({ left: 120, right: 800 }, { left: 0, right: 680 })).toEqual(['r', 'r'])
    expect(sidesForRects({ left: 120, right: 800 }, { left: 0, right: 680 })).toEqual(['r', 'r'])
    expect(sidesForRects({ left: 0, right: 680 }, { left: -120, right: 400 })).toEqual(['l', 'l'])
  })
})

describe('routePoints', () => {
  it('automatic routes never pass through either table, whatever the layout or row', () => {
    const rand = rng(42)
    const between = (lo: number, hi: number) => lo + rand() * (hi - lo)
    let checked = 0
    for (let i = 0; i < 6000; i++) {
      const mk = (): Box => {
        const left = between(-1500, 1500)
        const top = between(-1000, 1000)
        return { left, right: left + between(300, 760), top, bottom: top + between(110, 420) }
      }
      const a = mk()
      const b = mk()
      if (overlaps2D(a, b)) continue // one table dropped on top of another: nothing sensible to route around
      checked++

      const [sa, sb] = sidesForRects(a, b)
      const sDir: Dir = sa === 'r' ? 1 : -1
      const tDir: Dir = sb === 'r' ? 1 : -1
      const sx = sa === 'r' ? a.right : a.left
      const tx = sb === 'r' ? b.right : b.left
      const sy = between(a.top + 20, a.bottom - 20)
      const ty = between(b.top + 20, b.bottom - 20)

      const pts = routePoints(sx, sy, sDir, tx, ty, tDir)
      const label = JSON.stringify({ a, b, sa, sb })
      for (let k = 0; k + 1 < pts.length; k++) {
        expect(cuts(a, pts[k], pts[k + 1]), `cuts the source table: ${label}`).toBe(false)
        expect(cuts(b, pts[k], pts[k + 1]), `cuts the target table: ${label}`).toBe(false)
      }
      // each end leaves its table straight, for at least a stub's length, in the direction it faces
      const stub = stubLength(sx, sDir, tx, tDir)
      expect((pts[1][0] - sx) * sDir, `source stub: ${label}`).toBeGreaterThanOrEqual(stub - 1e-9)
      expect((pts[2][0] - tx) * tDir, `target stub: ${label}`).toBeGreaterThanOrEqual(stub - 1e-9)
    }
    expect(checked).toBeGreaterThan(3000) // the loop really exercised thousands of layouts
  })

  it('shares a small gap between the two stubs instead of cutting into a table', () => {
    expect(stubLength(680, 1, 730, -1)).toBe(25) // 50px gap: 25 each
    expect(stubLength(680, 1, 2000, -1)).toBe(STUB) // plenty of room: the normal stub
    expect(routeX(680, 1, 730, 100, -1)).toBeGreaterThanOrEqual(680)
    expect(routeX(680, 1, 730, 100, -1)).toBeLessThanOrEqual(730)
  })

  it('puts a bracket just outside both tables, and the lane between them when there is a gap', () => {
    const bracket = routeX(680, 1, 380, 500, 1) // both leave the right side; the second table ends at 380 < 680
    expect(bracket).toBe(680 + STUB + TURN)
    const across = routeX(680, 1, 1000, 500, -1) // 680..1000 gap
    expect(across).toBeGreaterThanOrEqual(680 + STUB)
    expect(across).toBeLessThanOrEqual(1000 - STUB)
  })

  it('lets the user drag the lane anywhere: the route follows by exactly that much, with no stops or dead zones', () => {
    const auto = routeX(680, 1, 1000, 500, -1)
    for (const dx of [-999, -300, -48, -1, 1, 47, 300, 999]) {
      expect(routeX(680, 1, 1000, 500, -1, { x: dx, y: 0 })).toBe(auto + dx)
    }
    // brackets too, and the path stays orthogonal (every step is horizontal or vertical)
    const pts = routePoints(680, 100, 1, 380, 500, 1, { x: -200, y: 0 })
    expect(pts.map((p) => p[0])).toEqual([680, 680 + STUB + TURN - 200, 680 + STUB + TURN - 200, 380])
    for (let k = 0; k + 1 < pts.length; k++) expect(pts[k][0] === pts[k + 1][0] || pts[k][1] === pts[k + 1][1]).toBe(true)
  })
})
