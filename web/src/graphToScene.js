import { convertToExcalidrawElements } from '@excalidraw/excalidraw'

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
    if (!a || !b) continue
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

  for (const edge of graph.edges) {
    const a = byId.get(edge.from)
    const b = byId.get(edge.to)
    if (!a || !b) continue
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
    // because the clear corridor is often outside the direct span.
    const candidates = []
    const steps = 40
    for (let i = -12; i <= steps + 12; i++) {
      const f = i / steps
      const mid = from + (to - from) * f
      candidates.push({
        axis: horizontal,
        mid,
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
    for (const lane of horizontal
      ? [Math.min(...box.map(n => n.y)) - 40, Math.max(...box.map(n => n.y + n.h)) + 40]
      : [Math.min(...box.map(n => n.x)) - 40, Math.max(...box.map(n => n.x + n.w)) + 40]) {
      candidates.push({
        axis: !horizontal,
        mid: lane,
        route: horizontal
          ? [s, [s[0], lane], [t[0], lane], t]
          : [s, [lane, s[1]], [lane, t[1]], t],
        near: 1.5
      })
    }

    let best = null
    for (const c of candidates) {
      let blocked = 0
      for (let k = 0; k < c.route.length - 1; k++) {
        if (blockers.some(r => segHitsRect(c.route[k], c.route[k + 1], r))) blocked++
      }
      const used = c.axis ? usedV : usedH
      const score = blocked * 10 + clashes(used, c.mid, lo, hi) * 3 + c.near
      if (!best || score < best.score) best = { ...c, score }
    }
    ;(best.axis ? usedV : usedH).push({ pos: best.mid, lo, hi })
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
      label: { text: node.label, fontSize: 20, strokeColor: '#1e1e1e', opacity },
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
      ...(edge.label ? { label: { text: edge.label, fontSize: 14, opacity: edgeOpacity } } : {}),
      customData: { edgeId: edge.id }
    })
  }

  return convertToExcalidrawElements(skeleton, { regenerateIds: false })
}

// How many arrows currently run through a box that is not their own endpoint.
// The agent cannot see the canvas, so this is how the problem gets described to it.
export function crossingCount (graph) {
  const routes = routeAll(graph)
  let hits = 0
  let counted = 0
  for (const edge of graph.edges) {
    const route = routes.get(edge.id)
    if (!route) continue
    counted++
    const rects = graph.nodes
      .filter(n => n.id !== edge.from && n.id !== edge.to)
      .map(inflate)
    const crosses = route.slice(0, -1).some((p, i) => rects.some(r => segHitsRect(p, route[i + 1], r)))
    if (crosses) hits++
  }
  return { hits, counted }
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
