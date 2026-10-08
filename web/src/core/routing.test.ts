import { describe, expect, it } from 'vitest'
import {
  curveGeometry,
  routeParts,
  routePoints,
  routeX,
  sidesForRects,
  simplify,
  STUB,
  stubLength,
  TURN,
  type Dir,
} from './routing'

type Box = { left: number; right: number; top: number; bottom: number }

/** Small seeded generator, so a failing layout can be reproduced. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296
    return seed / 4294967296
  }
}

const overlaps2D = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

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
    for (let k = 0; k + 1 < pts.length; k++)
      expect(pts[k][0] === pts[k + 1][0] || pts[k][1] === pts[k + 1][1]).toBe(true)
  })
})

describe('moving the parts of a line', () => {
  // Source table ends at x=680 (line leaves right), target starts at x=1000 (line arrives from the left).
  const args = [680, 100, 1, 1000, 500, -1] as const
  const lane = routeX(680, 1, 1000, 500, -1)

  it('ys moves the source-side run up / down and nothing else', () => {
    const pts = routePoints(...args, { x: 0, y: 0, ys: -40 })
    expect(pts).toEqual([
      [680, 100],
      [680 + STUB, 100],
      [680 + STUB, 60],
      [lane, 60],
      [lane, 500],
      [1000, 500],
    ])
  })

  it('yt moves the target-side run up / down and nothing else', () => {
    const pts = routePoints(...args, { x: 0, y: 0, yt: 30 })
    expect(pts).toEqual([
      [680, 100],
      [lane, 100],
      [lane, 530],
      [1000 - STUB, 530],
      [1000 - STUB, 500],
      [1000, 500],
    ])
  })

  it('x still moves the lane sideways', () => {
    expect(routeX(680, 1, 1000, 500, -1, { x: 25, y: 0, ys: 10 })).toBe(lane + 25)
  })

  it('a line always starts and ends exactly on its columns, however it is moved', () => {
    for (const bend of [
      { x: 90, y: 0, ys: -200, yt: 300 },
      { x: -400, y: 0, ys: 80, yt: -80 },
      { x: 0, y: 0 },
    ]) {
      const pts = routePoints(...args, bend)
      expect(pts[0]).toEqual([680, 100])
      expect(pts[pts.length - 1]).toEqual([1000, 500])
    }
  })

  it('every piece stays horizontal or vertical (orthogonal lines)', () => {
    for (const bend of [undefined, { x: 60, y: 0, ys: -75, yt: 40 }, { x: -300, y: 0, ys: 200, yt: -150 }]) {
      for (const dirs of [
        [1, -1],
        [1, 1],
        [-1, -1],
      ] as const) {
        const pts = routePoints(500, 100, dirs[0], 900, 420, dirs[1], bend)
        for (let i = 1; i < pts.length; i++) {
          const same = pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]
          expect(same, JSON.stringify({ bend, dirs, pts })).toBe(true)
        }
      }
    }
  })

  it('the three parts join end to end and the lane is where routeX says', () => {
    const { source, lane: laneSeg, target } = routeParts(...args, { x: 10, y: 0, ys: -20, yt: 15 })
    expect(source[source.length - 1]).toEqual(laneSeg[0])
    expect(laneSeg[laneSeg.length - 1]).toEqual(target[0])
    expect(laneSeg[0][0]).toBe(lane + 10)
    expect(laneSeg[0][0]).toBe(laneSeg[1][0]) // the lane is vertical
  })

  it('ignores the old, unused bend.y of lines saved earlier', () => {
    expect(routePoints(...args, { x: 0, y: 99 })).toEqual(routePoints(...args))
    expect(routePoints(...args, { x: 20, y: -300 })).toEqual(routePoints(...args, { x: 20, y: 0 }))
  })

  it('simplify keeps only the real corners', () => {
    expect(
      simplify([
        [0, 0],
        [0, 0],
        [5, 0],
        [10, 0],
        [10, 7],
        [10, 9],
        [20, 9],
      ]),
    ).toEqual([
      [0, 0],
      [10, 0],
      [10, 9],
      [20, 9],
    ])
  })
})

describe('curved line style', () => {
  type Args = readonly [number, number, Dir, number, number, Dir]
  const across: Args = [203, 72, 1, 422, 179, -1] // tables side by side (the example page's first line)
  const bracket: Args = [680, 100, 1, 600, 500, 1] // both lines leave the right side (stacked tables)
  const selfLink: Args = [680, 100, 1, 680, 300, 1] // a table linked to itself: both ends on one edge

  /** Reads `M x,y C ... C ...` into its 3 + 3 + 1 points. */
  const parse = (d: string) => {
    const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    expect(n).toHaveLength(14)
    const pt = (i: number): [number, number] => [n[2 * i], n[2 * i + 1]]
    return { p0: pt(0), c1: pt(1), c2: pt(2), m: pt(3), c3: pt(4), c4: pt(5), p3: pt(6) }
  }
  const bez = (p: number[][], t: number) =>
    [0, 1].map(
      (k) =>
        (1 - t) ** 3 * p[0][k] + 3 * (1 - t) ** 2 * t * p[1][k] + 3 * (1 - t) * t ** 2 * p[2][k] + t ** 3 * p[3][k],
    )

  it('is the same single smooth curve as React Flow draws between side-by-side tables', () => {
    // From the example page: M203,72 C312.5,72 312.5,179 422,179
    const { p0, c1, c2, m, c3, c4, p3 } = parse(curveGeometry(...across).d)
    const single = [
      [203, 72],
      [312.5, 72],
      [312.5, 179],
      [422, 179],
    ]
    expect(p0).toEqual([203, 72])
    expect(p3).toEqual([422, 179])
    expect(m).toEqual([312.5, 125.5]) // halfway
    // Both halves lie exactly on the single curve: the first is t 0..0.5 of it, the second t 0.5..1.
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const [a1, a2] = [bez([p0, c1, c2, m], u), bez(single, u / 2)]
      const [b1, b2] = [bez([m, c3, c4, p3], u), bez(single, 0.5 + u / 2)]
      for (const k of [0, 1]) {
        expect(a1[k]).toBeCloseTo(a2[k], 1)
        expect(b1[k]).toBeCloseTo(b2[k], 1)
      }
    }
  })

  it('leaves and arrives level, right on the columns', () => {
    for (const args of [across, bracket, selfLink]) {
      const { p0, c1, c4, p3 } = parse(curveGeometry(...args).d)
      expect(p0).toEqual([args[0], args[1]])
      expect(p3).toEqual([args[3], args[4]])
      expect(c1[1]).toBe(args[1]) // first handle is level with the start
      expect(c4[1]).toBe(args[4]) // last handle is level with the end
      expect(curveGeometry(...args).d).not.toMatch(/NaN|undefined/)
    }
  })

  it('the middle point follows the drag exactly (x sideways, cy up / down), the ends stay', () => {
    const base = curveGeometry(...across).mid
    expect(curveGeometry(...across, { x: 40, y: 0 }).mid).toEqual([base[0] + 40, base[1]])
    expect(curveGeometry(...across, { x: 0, y: 0, cy: -70 }).mid).toEqual([base[0], base[1] - 70])
    const moved = parse(curveGeometry(...across, { x: 25, y: 0, cy: 60 }).d)
    expect(moved.p0).toEqual([203, 72])
    expect(moved.p3).toEqual([422, 179])
  })

  it('stays smooth through the middle after a drag (both halves share its tangent)', () => {
    const { c2, m, c3 } = parse(curveGeometry(...across, { x: 30, y: 0, cy: -90 }).d)
    expect(c2[0] + c3[0]).toBeCloseTo(2 * m[0], 1) // m is the midpoint of its two handles, so the line is smooth
    expect(c2[1] + c3[1]).toBeCloseTo(2 * m[1], 1)
  })

  it('stacked tables get a C-curve that bulges out past both', () => {
    const { c1, c4, m } = parse(curveGeometry(...bracket).d)
    expect(c1[0]).toBeGreaterThan(680) // the handle out of the first table reaches past its right edge
    expect(c4[0]).toBeGreaterThan(600) // and the one into the second table past its own
    expect(m[0]).toBeGreaterThan(680) // the middle of the curve is outside both
  })

  it('a table linked to itself still draws a visible loop (never a flat line on its border)', () => {
    const { m, c1 } = parse(curveGeometry(...selfLink).d)
    expect(c1[0]).toBeGreaterThanOrEqual(680 + 30)
    expect(m[0]).toBeGreaterThan(680 + 30)
  })

  it('the up / down offsets of the orthogonal style (ys, yt) do not change a curve, and cy does not change an orthogonal line', () => {
    expect(curveGeometry(...across, { x: 0, y: 0, ys: -90, yt: 60 })).toEqual(curveGeometry(...across))
    expect(routePoints(...across, { x: 0, y: 0, cy: 80 })).toEqual(routePoints(...across))
  })
})
