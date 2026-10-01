import { convertToExcalidrawElements, FONT_FAMILY } from '@excalidraw/excalidraw'

// Every label on the diagram, and what the canvas types new text in. Nunito is
// Excalidraw's own "Normal" and ships in its fonts folder, so it is served locally
// like the rest - an arbitrary web font would need the plugin in vite.config.js.
export const FONT = FONT_FAMILY.Nunito

const KIND_COLOURS = {
  service: { stroke: '#1971c2', fill: '#d0ebff' },
  datastore: { stroke: '#2f9e44', fill: '#d3f9d8' },
  queue: { stroke: '#9c36b5', fill: '#f3d9fa' },
  device: { stroke: '#e8590c', fill: '#ffe8cc' },
  external: { stroke: '#868e96', fill: '#f1f3f5' },
  job: { stroke: '#0c8599', fill: '#c5f6fa' },
  ui: { stroke: '#5f3dc4', fill: '#e5dbff' }
}
const TOUCHED = { stroke: '#f08c00', fill: '#fff3bf' }

// What a box should look like right now. `touched` wins while it is waiting to be
// reviewed; a colour the user set wins over the kind's; the kind is the default,
// so clearing the override puts the box back in step with its kind.
export function colourFor (node) {
  if (node.touched) return TOUCHED
  const base = KIND_COLOURS[node.kind] ?? KIND_COLOURS.external
  return { stroke: node.stroke || base.stroke, fill: node.fill || base.fill }
}

// Air between the box edge and the arrowhead. Must clear MARGIN below, or every
// stub point lands inside a neighbouring box's obstacle margin and the routes that
// travel alongside a column are rejected before they start.
const GAP = 20

// Where a line from this node's centre towards (tx, ty) crosses the node's border.
function borderPoint (node, tx, ty) {
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  // Scale the direction vector until it hits the nearer of the two edge pairs.
  const scaleX = dx === 0 ? Infinity : (node.w / 2) / Math.abs(dx)
  const scaleY = dy === 0 ? Infinity : (node.h / 2) / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  const len = Math.hypot(dx, dy)
  const gap = Math.min(GAP, len / 4)
  return [cx + dx * (scale + gap / len), cy + dy * (scale + gap / len)]
}

// --- routing ----------------------------------------------------------------
// Straight centre-to-centre lines cut through whatever sits between two boxes,
// which is what makes a busy diagram unreadable. These route in three segments -
// a short stub out of the source face, a run along a corridor that is clear of
// every other box, then a stub into the target face - and fall back to a straight
// line only when nothing clear exists.

const MARGIN = 14
// Two lines closer than this read as one, and then you cannot tell which way
// either is going. Crossings are fine - those are unavoidable - but overlap is not.
const MIN_GAP = 14

const inflate = n => ({ x: n.x - MARGIN, y: n.y - MARGIN, w: n.w + 2 * MARGIN, h: n.h + 2 * MARGIN })
const centre = n => [n.x + n.w / 2, n.y + n.h / 2]
const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }

// Liang-Barsky: does the segment p->q pass through rect r at all?
function segHitsRect (p, q, r) {
  let t0 = 0
  let t1 = 1
  const dx = q[0] - p[0]
  const dy = q[1] - p[1]
  const tests = [[-dx, p[0] - r.x], [dx, r.x + r.w - p[0]], [-dy, p[1] - r.y], [dy, r.y + r.h - p[1]]]
  for (const [pp, qq] of tests) {
    if (pp === 0) {
      if (qq < 0) return false
      continue
    }
    const t = qq / pp
    if (pp < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t1 > t0
}

// Drop duplicate and collinear points, so a route that needed no bend is stored
// as a plain straight arrow.
function simplify (pts) {
  const out = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p)
  }
  const kept = [out[0]]
  for (let i = 1; i < out.length - 1; i++) {
    const [ax, ay] = kept[kept.length - 1]
    const [bx, by] = out[i]
    const [cx, cy] = out[i + 1]
    const straight = (ax === bx && bx === cx) || (ay === by && by === cy)
    if (!straight) kept.push(out[i])
  }
  if (out.length > 1) kept.push(out[out.length - 1])
  return kept
}

const facesFor = (a, b) => {
  const [ax, ay] = centre(a)
  const [bx, by] = centre(b)
  return Math.abs(bx - ax) >= Math.abs(by - ay)
    ? (bx > ax ? ['right', 'left'] : ['left', 'right'])
    : (by > ay ? ['bottom', 'top'] : ['top', 'bottom'])
}

// Where each edge meets its boxes. Edges sharing a face are fanned out along it,
// so two arrows never leave from the same point and sit on top of each other.
function anchorPoints (graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const groups = new Map()
  const faces = new Map()

  for (const edge of graph.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    // A hand-routed arrow attaches where its route says, not in the fan.
    if (!a || !b || edge.route) continue
    const [fa, fb] = facesFor(a, b)
    faces.set(edge.id, [fa, fb])
    for (const [nodeId, face, other, end] of [[edge.from, fa, b, 'a'], [edge.to, fb, a, 'b']]) {
      const key = `${nodeId}:${face}`
      if (!groups.has(key)) groups.set(key, [])
      const vertical = face === 'left' || face === 'right'
      groups.get(key).push({ edge: edge.id, end, sort: centre(other)[vertical ? 1 : 0] })
    }
  }

  const at = new Map()
  for (const [key, list] of groups) {
    const face = key.slice(key.lastIndexOf(':') + 1)
    const node = byId.get(key.slice(0, key.lastIndexOf(':')))
    const vertical = face === 'left' || face === 'right'
    const usable = Math.max(0, (vertical ? node.h : node.w) - 24)
    // Never tighter than 5px, even when a face carries more edges than it can fit.
    const step = list.length > 1 ? Math.max(5, Math.min(MIN_GAP, usable / (list.length - 1))) : 0
    list.sort((p, q) => p.sort - q.sort)
    const mid = vertical ? node.y + node.h / 2 : node.x + node.w / 2
    const first = mid - (step * (list.length - 1)) / 2
    list.forEach((item, i) => {
      const along = first + i * step
      at.set(`${item.edge}:${item.end}`, vertical
        ? [face === 'left' ? node.x : node.x + node.w, along]
        : [along, face === 'top' ? node.y : node.y + node.h])
    })
  }
  return { at, faces }
}

// --- hand routes ---------------------------------------------------------------
// An arrow the user (or an Arrange turn) shaped: `route` is { from, to, via }, the
// side of each box it attaches to and the bends it passes through, in canvas units.
// Bends stay where they were put when a box moves; the ends re-attach to their
// side. It is still drawn square, whatever shape the bends were left in.

// Where an arrow leaves `face`, GAP out from the box: in line with `toward` when
// that lies along the face, so the first leg is straight, else as near as fits.
const INSET = 12
function stubAt (n, face, [tx, ty]) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const upright = face === 'left' || face === 'right'
  const [x, y] = upright
    ? [face === 'left' ? n.x : n.x + n.w, clamp(ty, n.y + INSET, n.y + n.h - INSET)]
    : [clamp(tx, n.x + INSET, n.x + n.w - INSET), face === 'top' ? n.y : n.y + n.h]
  // Whole units, like everything stored, or a redraw of a saved route is off by half.
  return [Math.round(x + NORMAL[face][0] * GAP), Math.round(y + NORMAL[face][1] * GAP)]
}

// Extend `path`, heading `dir`, to reach q at right angles, and return the heading
// it arrives on. Keep going first if q is ahead, turn first if it is behind - so
// dragging one bend moves the segments that meet at it rather than kinking them.
// When that corner would cut through a box and the other one would not, it takes
// the other one: two bends only fix the ends of the path between them.
function walk (path, dir, q, boxes = []) {
  const p = path[path.length - 1]
  if (p[0] === q[0] && p[1] === q[1]) return dir
  const unit = (from, to) => [Math.sign(to[0] - from[0]), Math.sign(to[1] - from[1])]
  const ahead = (q[0] - p[0]) * dir[0] + (q[1] - p[1]) * dir[1] > 0
  if (p[0] === q[0] || p[1] === q[1]) {
    path.push(q)
    return unit(p, q)
  }
  const flat = dir[1] === 0
  const [first, other] = ahead === flat ? [[q[0], p[1]], [p[0], q[1]]] : [[p[0], q[1]], [q[0], p[1]]]
  const hits = c => boxes.some(r => segHitsRect(p, c, r) || segHitsRect(c, q, r))
  const corner = hits(first) && !hits(other) ? other : first
  path.push(corner, q)
  return unit(corner, q)
}

// Join the end of `path` - heading dp - to q, arriving against dq: dq points out of
// q's box, or is null when q is just a bend. A strict end's leg must run exactly
// along its direction, because it leaves a box face or an arrowhead sits on it.
// Tries the few right-angled shapes that could fit - straight, two Ls, two Zs, and
// two Us that step out of each end first - drops any that set off backwards or
// arrive the wrong way, and keeps the one crossing fewest boxes, then the simplest.
// A U always fits, so something always does.
function join (path, dp, q, dq, boxes, strictP, strictQ) {
  const p = path[path.length - 1]
  if (p[0] === q[0] && p[1] === q[1]) return dp
  const unit = (u, v) => [Math.sign(v[0] - u[0]), Math.sign(v[1] - u[1])]
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1]
  const mid = (u, v) => Math.round((u + v) / 2)
  const po = [p[0] + dp[0] * GAP, p[1] + dp[1] * GAP]
  const qo = dq ? [q[0] + dq[0] * GAP, q[1] + dq[1] * GAP] : q
  const shapes = [
    [],
    [[q[0], p[1]]],
    [[p[0], q[1]]],
    [[mid(p[0], q[0]), p[1]], [mid(p[0], q[0]), q[1]]],
    [[p[0], mid(p[1], q[1])], [q[0], mid(p[1], q[1])]],
    [po, [qo[0], po[1]], qo],
    [po, [po[0], qo[1]], qo]
  ]
  let best = null
  for (const corners of shapes) {
    const route = simplify([p, ...corners, q])
    if (!route.every((v, i) => i === 0 || v[0] === route[i - 1][0] || v[1] === route[i - 1][1])) continue
    const first = unit(route[0], route[1])
    const last = unit(route[route.length - 2], route[route.length - 1])
    if (strictP ? first[0] !== dp[0] || first[1] !== dp[1] : dot(first, dp) < 0) continue
    if (dq && (strictQ ? last[0] !== -dq[0] || last[1] !== -dq[1] : dot(last, dq) > 0)) continue
    const score = routeScore(route, boxes)
    if (!best || score < best.score) best = { route, score }
  }
  // Only when q sits dead behind p on its own line, so every shape doubles back on
  // itself: go straight there rather than draw a loop.
  best ??= { route: simplify([p, [q[0], p[1]], q]) }
  path.push(...best.route.slice(1))
  return unit(best.route[best.route.length - 2], best.route[best.route.length - 1])
}

// `boxes` are the ones a leg should go round if it can: every box on the canvas,
// the arrow's own two included.
function handRoute (a, b, route, boxes = [a, b]) {
  const [autoA, autoB] = facesFor(a, b)
  const fa = route.from ?? autoA
  const fb = route.to ?? autoB
  const via = route.via ?? []
  const s = stubAt(a, fa, via[0] ?? centre(b))
  const t = stubAt(b, fb, via[via.length - 1] ?? centre(a))
  const [outA, intoB] = [NORMAL[fa], NORMAL[fb].map(v => -v)]

  // Every way of leaving the source face against every way of reaching the target
  // one, keeping the best. Deciding each end on its own went round the wrong end
  // of a box as often as not, because it could not see where the rest was coming from.
  let best = null
  for (const start of ports(a, fa, s)) {
    // Through the bends. Straight off the face the first leg must stay square-on;
    // between bends, walk() keeps a dragged bend's segments with it.
    const path = [...start.pts]
    let dir = start.dir
    let strict = start.strict
    for (const p of via) {
      dir = strict ? join(path, dir, p, null, boxes, true, false) : walk(path, dir, p, boxes)
      strict = false
    }
    for (const end of ports(b, fb, t)) {
      const full = [...path]
      join(full, dir, end.pts[end.pts.length - 1], end.dir, boxes, strict, end.strict)
      const route = simplify([...full, ...[...end.pts].reverse().slice(1)])
      const first = [Math.sign(route[1][0] - route[0][0]), Math.sign(route[1][1] - route[0][1])]
      const [p, q] = [route[route.length - 2], route[route.length - 1]]
      const last = [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1])]
      // Square-on at both faces, or the arrowhead points along its box.
      if (first[0] !== outA[0] || first[1] !== outA[1] || last[0] !== intoB[0] || last[1] !== intoB[1]) continue
      const score = routeScore(route, boxes)
      if (!best || score < best.score) best = { route, score }
    }
  }
  return best?.route ?? simplify([s, ...via, t])
}

// Fewest boxes crossed, then fewest corners, then shortest.
function routeScore (route, boxes) {
  let hits = 0
  let length = 0
  for (let k = 0; k < route.length - 1; k++) {
    if (boxes.some(r => segHitsRect(route[k], route[k + 1], r))) hits++
    length += Math.abs(route[k + 1][0] - route[k][0]) + Math.abs(route[k + 1][1] - route[k][1])
  }
  return hits * 1e6 + route.length * 1e3 + length
}

// The ways a route can meet `face` of box n at stub point p: straight off it, one
// step further out, or stepped out and round either end of the face - so it can
// set off towards whatever it has to reach without doubling back through the box.
// `dir` is the heading at the last point, pointing away from the box.
function ports (n, face, p) {
  const dir = NORMAL[face]
  const out = [p[0] + dir[0] * GAP, p[1] + dir[1] * GAP]
  const along = face === 'left' || face === 'right' ? 1 : 0
  const [lo, hi] = along ? [n.y, n.y + n.h] : [n.x, n.x + n.w]
  const list = [{ pts: [p], dir, strict: true }, { pts: [p, out], dir, strict: false }]
  for (const end of [lo - GAP, hi + GAP]) {
    const round = [...out]
    round[along] = end
    const heading = [0, 0]
    heading[along] = Math.sign(end - out[along])
    list.push({ pts: [p, out, round], dir: heading, strict: false })
  }
  return list
}

// Which side of a box a point is on - the one it is furthest out past.
function faceOf (n, [px, py]) {
  const dx = px < n.x ? n.x - px : Math.max(0, px - (n.x + n.w))
  const dy = py < n.y ? n.y - py : Math.max(0, py - (n.y + n.h))
  if (dx === 0 && dy === 0) {
    const d = { left: px - n.x, right: n.x + n.w - px, top: py - n.y, bottom: n.y + n.h - py }
    return Object.keys(d).reduce((m, k) => (d[k] < d[m] ? k : m))
  }
  return dx >= dy ? (px < n.x ? 'left' : 'right') : (py < n.y ? 'top' : 'bottom')
}

// Has the user reshaped this arrow, compared with the path we last drew? Only the
// bends and the sides count: Excalidraw nudges a bound arrow's ends by a pixel or
// so on its own, and sliding an end along the same side changes nothing we keep.
export function reshaped (drawn, now, a, b) {
  if (!drawn || !a || !b) return false
  const [was, is] = [drawn.slice(1, -1), now.slice(1, -1)]
  if (was.length !== is.length) return true
  if (was.some((p, i) => Math.abs(p[0] - is[i][0]) > 1 || Math.abs(p[1] - is[i][1]) > 1)) return true
  return faceOf(a, drawn[0]) !== faceOf(a, now[0]) ||
    faceOf(b, drawn[drawn.length - 1]) !== faceOf(b, now[now.length - 1])
}

// An arrow as the user left it -> the route to store. `points` are absolute, ends
// included; `a`, `b` and `boxes` (all of them) are as they are on screen now, and
// `before` is the path as it was drawn. What is stored is the squared-up path, not
// the raw drag, so the file holds what the canvas shows.
export function routeFromEdit (points, a, b, boxes = [a, b], before = null) {
  let pts = points.map(([x, y]) => [Math.round(x), Math.round(y)])
  // One bend deleted. Corners on a square route work in pairs - the next one turns
  // the line back - so dropping only the one picked leaves a diagonal that squaring
  // up can turn straight back into the same corner, and the bend never goes. Take
  // its partner with it; whatever corner the ends still need is put back.
  if (before?.length === pts.length + 1) {
    const k = before.findIndex((p, i) => !pts[i] || Math.abs(p[0] - pts[i][0]) > 1 || Math.abs(p[1] - pts[i][1]) > 1)
    if (k > 0 && k < before.length - 1) {
      const partner = k + 1 < before.length - 1 ? k + 1 : k - 1
      pts = [pts[0], ...before.slice(1, -1).filter((_, i) => i + 1 !== k && i + 1 !== partner), pts[pts.length - 1]]
        .map(([x, y]) => [Math.round(x), Math.round(y)])
    }
  }
  // A corner dragged somewhere takes both of its segments with it: its untouched
  // neighbours slide along to keep them square. Otherwise the neighbour pins one
  // of them, and the corner only half goes where it was put.
  if (before?.length === pts.length) {
    const moved = i => Math.abs(pts[i][0] - before[i][0]) > 1 || Math.abs(pts[i][1] - before[i][1]) > 1
    for (let i = 1; i < pts.length - 1; i++) {
      if (!moved(i)) continue
      for (const j of [i - 1, i + 1]) {
        if (j === 0 || j === pts.length - 1 || moved(j)) continue
        if (Math.abs(before[j][0] - before[i][0]) < 1) pts[j] = [pts[i][0], pts[j][1]]
        else if (Math.abs(before[j][1] - before[i][1]) < 1) pts[j] = [pts[j][0], pts[i][1]]
      }
    }
  }
  const path = simplify(pts)
  const raw = { from: faceOf(a, path[0]), to: faceOf(b, path[path.length - 1]), via: path.slice(1, -1) }
  const drawn = handRoute(a, b, raw, boxes)
  // A straight arrow still keeps one point on its line: with no bends at all, a
  // redraw aims each end at the other box's centre and comes back as a Z.
  const [s, t] = [drawn[0], drawn[drawn.length - 1]]
  const via = drawn.length > 2 ? drawn.slice(1, -1) : [[Math.round((s[0] + t[0]) / 2), Math.round((s[1] + t[1]) / 2)]]
  return { from: raw.from, to: raw.to, via }
}

// Every route is orthogonal - a diagonal gives no clue where it is going. When no
// corridor is clear, the least-bad one is chosen rather than falling back to a
// straight line across the diagram.
export function routeAll (graph) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const { at, faces } = anchorPoints(graph)
  const usedV = []
  const usedH = []
  const routes = new Map()

  const clashes = (used, pos, lo, hi) =>
    used.filter(u => Math.abs(u.pos - pos) < MIN_GAP && u.hi > lo && u.lo < hi).length

  // Hand routes first: they are fixed, and the automatic ones should keep clear
  // of them the same way they keep clear of each other.
  for (const edge of graph.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b || !edge.route) continue
    const route = handRoute(a, b, edge.route, graph.nodes)
    for (let k = 0; k < route.length - 1; k++) {
      const [[x1, y1], [x2, y2]] = [route[k], route[k + 1]]
      if (x1 === x2) usedV.push({ pos: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) })
      else usedH.push({ pos: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) })
    }
    routes.set(edge.id, route)
  }

  for (const edge of graph.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b || edge.route) continue
    const [fa, fb] = faces.get(edge.id)
    const pa = at.get(`${edge.id}:a`)
    const pb = at.get(`${edge.id}:b`)
    const s = [pa[0] + NORMAL[fa][0] * GAP, pa[1] + NORMAL[fa][1] * GAP]
    const t = [pb[0] + NORMAL[fb][0] * GAP, pb[1] + NORMAL[fb][1] * GAP]
    const horizontal = fa === 'left' || fa === 'right'
    const blockers = graph.nodes.filter(n => n.id !== edge.from && n.id !== edge.to).map(inflate)

    const lo = horizontal ? Math.min(s[1], t[1]) : Math.min(s[0], t[0])
    const hi = horizontal ? Math.max(s[1], t[1]) : Math.max(s[0], t[0])
    const from = horizontal ? s[0] : s[1]
    const to = horizontal ? t[0] : t[1]

    // Two shapes, both orthogonal: a corridor across the gap between the boxes,
    // or a lane that goes around everything in the way. Sampled past both ends,
    // because the clear corridor is often outside the direct span. `run` is the
    // extent of the long middle segment, which is what other routes must keep clear of.
    const candidates = []
    const steps = 40
    for (let i = -12; i <= steps + 12; i++) {
      const f = i / steps
      const mid = from + (to - from) * f
      candidates.push({
        axis: horizontal,
        mid,
        run: [lo, hi],
        route: horizontal
          ? [s, [mid, s[1]], [mid, t[1]], t]
          : [s, [s[0], mid], [t[0], mid], t],
        near: Math.abs(f - 0.5)
      })
    }
    const near = graph.nodes.filter(n =>
      n.x + n.w > Math.min(s[0], t[0]) - 300 && n.x < Math.max(s[0], t[0]) + 300 &&
      n.y + n.h > Math.min(s[1], t[1]) - 300 && n.y < Math.max(s[1], t[1]) + 300)
    const box = near.length ? near : graph.nodes
    // Lanes go round the outside of everything near, and through every gap between
    // rows (or columns) of boxes, a track either side of its middle. With only the
    // two outer lanes, a grid - where each row's boxes sit on one line, so a
    // corridor's legs run through the neighbours in between - sent every long arrow
    // down the same outer lane, drawn on top of each other: 12 overlaps on bab-lc.
    const ends = (horizontal ? box.flatMap(n => [n.y, n.y + n.h]) : box.flatMap(n => [n.x, n.x + n.w]))
      .sort((p, q) => p - q)
    const lanes = new Set([ends[0] - 40, ends[ends.length - 1] + 40])
    for (let i = 0; i < ends.length - 1; i++) {
      if (ends[i + 1] - ends[i] < 2 * (MARGIN + MIN_GAP)) continue
      const m = Math.round((ends[i] + ends[i + 1]) / 2)
      for (const at of [m, m - MIN_GAP, m + MIN_GAP]) lanes.add(at)
    }
    const [aEnd, bEnd] = horizontal ? [s[1], t[1]] : [s[0], t[0]]
    for (const lane of lanes) {
      candidates.push({
        axis: !horizontal,
        mid: lane,
        run: [Math.min(from, to), Math.max(from, to)],
        route: horizontal
          ? [s, [s[0], lane], [t[0], lane], t]
          : [s, [lane, s[1]], [lane, t[1]], t],
        // Always behind a clear corridor (those score under 0.8); between lanes,
        // the one that strays least from the two ends.
        near: 1 + (Math.abs(aEnd - lane) + Math.abs(lane - bEnd) - Math.abs(aEnd - bEnd)) / 1000
      })
    }

    let best = null
    for (const c of candidates) {
      let blocked = 0
      for (let k = 0; k < c.route.length - 1; k++) {
        if (blockers.some(r => segHitsRect(c.route[k], c.route[k + 1], r))) blocked++
      }
      const used = c.axis ? usedV : usedH
      const score = blocked * 10 + clashes(used, c.mid, c.run[0], c.run[1]) * 3 + c.near
      if (!best || score < best.score) best = { ...c, score }
    }
    ;(best.axis ? usedV : usedH).push({ pos: best.mid, lo: best.run[0], hi: best.run[1] })
    routes.set(edge.id, simplify(best.route))
  }
  return routes
}

// graph.json -> Excalidraw elements.
// Ids are ours (regenerateIds: false) so arrows bind by node id, and every
// element carries customData so a click on the canvas resolves back to a node.
// Focus: 65 edges cannot be read at once, so selecting a box fades everything it
// does not touch. Neighbourhood is one hop - the box, whatever it talks to, and
// the edges between them. Nothing is hidden, so the shape is still visible behind.
const DIM_NODE = 20
const DIM_EDGE = 10

// Focus is `{ kind: 'node' | 'edge', id }`. A node lights itself, what it talks to
// and the edges between; an edge lights itself and the two boxes it joins.
function neighbourhood (graph, focus) {
  if (!focus?.id) return null
  if (focus.kind === 'edge') {
    const edge = graph.edges.find(e => e.id === focus.id)
    return edge ? { nodes: new Set([edge.from, edge.to]), edges: new Set([edge.id]) } : null
  }
  if (!graph.nodes.some(n => n.id === focus.id)) return null
  const nodes = new Set([focus.id])
  const edges = new Set()
  for (const e of graph.edges) {
    if (e.from === focus.id) { nodes.add(e.to); edges.add(e.id) }
    if (e.to === focus.id) { nodes.add(e.from); edges.add(e.id) }
  }
  return { nodes, edges }
}

// Focus changes nothing about geometry, so it must never go through a full
// re-seed: that replaces every element, which snaps a box back mid-drag and
// opens a settle window in which the user's own drag is ignored. This recolours
// the live scene in place instead.
export function applyFocus (elements, graph, selection) {
  const focus = neighbourhood(graph, selection)
  return elements.map(el => {
    const nodeId = el.customData?.nodeId ?? null
    const edgeId = el.customData?.edgeId ?? null
    let opacity = 100
    if (focus) {
      if (nodeId) opacity = focus.nodes.has(nodeId) ? 100 : DIM_NODE
      else if (edgeId) opacity = focus.edges.has(edgeId) ? 100 : DIM_EDGE
      else if (el.containerId) {
        // bound label: follow whatever it is attached to
        const owner = elements.find(o => o.id === el.containerId)
        const oid = owner?.customData?.nodeId ?? null
        const oeid = owner?.customData?.edgeId ?? null
        opacity = oid
          ? (focus.nodes.has(oid) ? 100 : DIM_NODE)
          : oeid ? (focus.edges.has(oeid) ? 100 : DIM_EDGE) : 100
      }
    }
    return el.opacity === opacity ? el : { ...el, opacity }
  })
}

// Excalidraw owns a bound arrow once it exists: move a box and it recomputes the
// endpoints and throws our corners away, leaving a diagonal. Re-route from where
// the boxes actually are now - the live scene, not the graph, which may not have
// caught up with the drag yet. Boxes are left untouched, so nothing snaps back.
export function rerouteArrows (elements, graph) {
  const nodes = elements
    .filter(el => el.customData?.nodeId && el.type === 'rectangle')
    .map(el => ({ id: el.customData.nodeId, x: el.x, y: el.y, w: el.width, h: el.height }))
  if (!nodes.length) return { elements, changed: false }

  const routes = routeAll({ nodes, edges: graph.edges })
  let changed = false
  const next = elements.map(el => {
    const id = el.customData?.edgeId
    if (!id) return el
    const route = routes.get(id)
    if (!route) return el
    const [x1, y1] = route[0]
    const points = route.map(([px, py]) => [px - x1, py - y1])
    const same = el.points?.length === points.length &&
      Math.abs(el.x - x1) < 0.5 && Math.abs(el.y - y1) < 0.5 &&
      points.every((p, i) => Math.abs(p[0] - el.points[i][0]) < 0.5 && Math.abs(p[1] - el.points[i][1]) < 0.5)
    if (same) return el
    changed = true
    return { ...el, x: x1, y: y1, points }
  })
  return { elements: next, changed }
}

export function graphToElements (graph, selection) {
  const skeleton = []
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const focus = neighbourhood(graph, selection)
  // Routed as a set, not one at a time: keeping lines apart needs to know where
  // the others already went.
  const routes = routeAll(graph)

  for (const node of graph.nodes) {
    const colour = colourFor(node)
    const opacity = !focus || focus.nodes.has(node.id) ? 100 : DIM_NODE
    skeleton.push({
      opacity,
      type: 'rectangle',
      id: `node:${node.id}`,
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      strokeColor: colour.stroke,
      backgroundColor: colour.fill,
      fillStyle: 'solid',
      strokeWidth: node.touched ? 4 : 2,
      roundness: { type: 3 },
      label: { text: node.label, fontSize: 20, fontFamily: FONT, strokeColor: '#1e1e1e', opacity },
      customData: { nodeId: node.id, kind: node.kind }
    })
  }

  for (const edge of graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue

    // An arrow skeleton MUST carry x/y. convertToExcalidrawElements reads them to
    // place the endpoints (startX = start.x || linearElement.x - width), so leaving
    // them off yields NaN geometry, not an auto-layout. The binding below still
    // owns the arrow once it exists - this is only the seed position. Intermediate
    // points survive binding, which is what makes the routing hold.
    const route = routes.get(edge.id)
    if (!route) continue
    const [x1, y1] = route[0]

    const edgeOpacity = !focus || focus.edges.has(edge.id) ? 100 : DIM_EDGE
    skeleton.push({
      opacity: edgeOpacity,
      type: 'arrow',
      id: `edge:${edge.id}`,
      x: x1,
      y: y1,
      points: route.map(([px, py]) => [px - x1, py - y1]),
      start: { id: `node:${edge.from}` },
      end: { id: `node:${edge.to}` },
      strokeColor: '#495057',
      ...(edge.label ? { label: { text: edge.label, fontSize: 14, fontFamily: FONT, opacity: edgeOpacity } } : {}),
      customData: { edgeId: edge.id }
    })
  }

  return convertToExcalidrawElements(skeleton, { regenerateIds: false })
}

// Canvas -> graph: we only read back layout, never structure.
export function layoutFromElements (elements) {
  const positions = {}
  for (const el of elements) {
    const id = el.customData?.nodeId
    if (!id || el.isDeleted) continue
    if (![el.x, el.y, el.width, el.height].every(Number.isFinite)) continue
    positions[id] = { x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height) }
  }
  return positions
}
