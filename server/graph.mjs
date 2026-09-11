import fs from 'node:fs/promises'
import path from 'node:path'

// The graph belongs to the workspace, so every read and write is told which one.
// Nothing here is module-global any more: that was what pinned the server to a
// single project directory.
export const graphPathFor = dir => path.join(dir, '.promptcanvas', 'graph.json')

const SEED = {
  version: 1,
  nodes: [
    { id: 'web', label: 'Web app', kind: 'service', paths: ['apps/web'], x: 80, y: 120 },
    { id: 'api', label: 'API', kind: 'service', paths: ['apps/api'], x: 420, y: 120 },
    { id: 'db', label: 'Postgres', kind: 'datastore', paths: [], x: 760, y: 120 }
  ],
  edges: [
    { id: 'e-web-api', from: 'web', to: 'api', label: 'REST' },
    { id: 'e-api-db', from: 'api', to: 'db', label: 'SQL' }
  ]
}

const NODE_W = 220
const NODE_H = 90
const COL_W = 340
const ROW_H = 220
const ORIGIN_X = 80
const ORIGIN_Y = 120
const COLS = 4

export const KINDS = ['service', 'datastore', 'queue', 'device', 'external', 'job', 'ui']

export async function readGraph (dir) {
  try {
    const raw = await fs.readFile(graphPathFor(dir), 'utf8')
    return normalise(JSON.parse(raw))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    await writeGraph(dir, SEED)
    return normalise(SEED)
  }
}

export async function writeGraph (dir, graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    throw new Error('refusing to write a graph without a nodes array')
  }
  const next = normalise(graph)
  await fs.mkdir(path.dirname(graphPathFor(dir)), { recursive: true })
  await fs.writeFile(graphPathFor(dir), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

// Hands out the next grid slot that nothing already sits on, so a node the agent
// adds never lands underneath a box the user dragged there.
function freeSlots (taken) {
  let i = 0
  return () => {
    for (; ; i++) {
      const slot = {
        x: ORIGIN_X + (i % COLS) * COL_W,
        y: ORIGIN_Y + Math.floor(i / COLS) * ROW_H,
        w: NODE_W,
        h: NODE_H
      }
      if (!taken.some(t => overlaps(slot, t))) {
        taken.push(slot)
        i++
        return slot
      }
    }
  }
}

// Keys are written in a fixed, readable order and defaults are left out, so a
// structure change shows up in a PR diff as the line that actually changed.
function normalise (graph) {
  const incoming = (graph.nodes || []).filter(n => n && n.id)

  const sized = incoming.map(n => ({
    raw: n,
    w: Number.isFinite(n.w) ? n.w : NODE_W,
    h: Number.isFinite(n.h) ? n.h : NODE_H,
    placed: Number.isFinite(n.x) && Number.isFinite(n.y)
  }))
  const nextSlot = freeSlots(
    sized.filter(s => s.placed).map(s => ({ x: s.raw.x, y: s.raw.y, w: s.w, h: s.h }))
  )

  const nodes = sized.map(({ raw, w, h, placed }) => {
    const at = placed ? { x: raw.x, y: raw.y } : nextSlot()
    const node = {
      id: raw.id,
      label: raw.label ?? raw.id,
      kind: KINDS.includes(raw.kind) ? raw.kind : 'service',
      paths: Array.isArray(raw.paths) ? raw.paths : [],
      notes: raw.notes ?? '',
      x: Math.round(at.x),
      y: Math.round(at.y),
      w: Math.round(w),
      h: Math.round(h)
    }
    if (raw.touched) node.touched = true
    return node
  })

  const ids = new Set(nodes.map(n => n.id))
  const edges = (graph.edges || [])
    .filter(e => e && ids.has(e.from) && ids.has(e.to))
    .map(e => {
      const edge = { id: e.id || `e-${e.from}-${e.to}`, from: e.from, to: e.to }
      if (e.label) edge.label = e.label
      return edge
    })

  return { version: 1, nodes, edges }
}

// Applied by the agent's patch_graph tool.
export function applyPatch (graph, patch) {
  const nodes = [...graph.nodes]
  const edges = [...graph.edges]
  const touched = []

  for (const incoming of patch.upsertNodes ?? []) {
    const i = nodes.findIndex(n => n.id === incoming.id)
    // Positions are the user's. Strip anything the agent tried to set.
    const { x, y, w, h, ...structure } = incoming
    if (i === -1) nodes.push({ ...structure, touched: true })
    else nodes[i] = { ...nodes[i], ...structure, touched: true }
    touched.push(incoming.id)
  }
  for (const id of patch.removeNodeIds ?? []) {
    const i = nodes.findIndex(n => n.id === id)
    if (i !== -1) nodes.splice(i, 1)
  }
  for (const incoming of patch.upsertEdges ?? []) {
    const id = incoming.id || `e-${incoming.from}-${incoming.to}`
    const i = edges.findIndex(e => e.id === id)
    if (i === -1) edges.push({ ...incoming, id })
    else edges[i] = { ...edges[i], ...incoming, id }
    // A changed dependency implicates both ends, so both light up. Without this
    // the tool reports endpoints as marked that were never actually flagged.
    for (const end of [incoming.from, incoming.to]) {
      const j = nodes.findIndex(n => n.id === end)
      if (j !== -1) nodes[j] = { ...nodes[j], touched: true }
      touched.push(end)
    }
  }
  for (const id of patch.removeEdgeIds ?? []) {
    const i = edges.findIndex(e => e.id === id)
    if (i !== -1) edges.splice(i, 1)
  }

  // Only nodes that still exist can be flagged for review.
  const live = new Set(nodes.map(n => n.id))
  return { graph: { ...graph, nodes, edges }, touched: [...new Set(touched)].filter(id => live.has(id)) }
}
