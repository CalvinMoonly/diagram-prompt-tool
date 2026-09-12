import fs from 'node:fs/promises'
import path from 'node:path'

// The graph belongs to the workspace, so every read and write is told which one.
// Nothing here is module-global any more: that was what pinned the server to a
// single project directory.
export const MAIN = 'main'

// A diagram name becomes a file name, so the rule is strict: anything that could
// climb out of .promptcanvas/graphs is not a name.
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
export const isDiagramName = n => typeof n === 'string' && NAME.test(n)
export const toDiagramName = s =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

// `main` keeps the canonical path, so the diagram a pull request reviews stays
// exactly where it has always been. Named ones sit beside it.
export function graphPathFor (dir, name = MAIN) {
  if (!name || name === MAIN) return path.join(dir, '.promptcanvas', 'graph.json')
  if (!isDiagramName(name)) throw new Error(`bad diagram name: ${name}`)
  return path.join(dir, '.promptcanvas', 'graphs', `${name}.json`)
}

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

export async function readGraph (dir, name = MAIN) {
  try {
    const raw = await fs.readFile(graphPathFor(dir, name), 'utf8')
    return normalise(JSON.parse(raw))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    await writeGraph(dir, name, SEED)
    return normalise(SEED)
  }
}

export async function writeGraph (dir, name, graph) {
  if (!graph || !Array.isArray(graph.nodes)) {
    throw new Error('refusing to write a graph without a nodes array')
  }
  const next = normalise(graph)
  const file = graphPathFor(dir, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// `main` is always listed, whether or not its file exists yet.
export async function listDiagrams (dir) {
  const names = [MAIN]
  try {
    for (const file of await fs.readdir(path.join(dir, '.promptcanvas', 'graphs'))) {
      const name = file.endsWith('.json') ? file.slice(0, -5) : null
      if (name && isDiagramName(name)) names.push(name)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  return names
}

// Copies `from`, so a new diagram starts as a branch of the one you were looking
// at rather than the placeholder seed.
// Session diagrams are named from the prompt that started them, so the files stay
// readable. Capped short of the 40-char limit to leave room for the -2, -3 suffix.
export async function uniqueDiagramName (dir, base) {
  const taken = new Set(await listDiagrams(dir))
  const full = toDiagramName(base)
  // Cut on a word boundary, so the file name reads instead of ending mid-word.
  const root = (full.length > 28 ? full.slice(0, 28).replace(/-[^-]*$/, '') : full)
    .replace(/-+$/, '') || 'session'
  if (root !== MAIN && !taken.has(root)) return root
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function createDiagram (dir, name, from = MAIN) {
  if (!isDiagramName(name)) throw new Error(`bad diagram name: ${name}`)
  if (name === MAIN) throw new Error('"main" already exists')
  if ((await listDiagrams(dir)).includes(name)) throw new Error(`diagram "${name}" already exists`)
  return writeGraph(dir, name, await readGraph(dir, from))
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
  // Ids must be unique, whoever supplied them - the agent can collide too. A
  // duplicate is worse than a missing node: applyPatch finds only the first, so
  // the second can never be edited or removed, and the canvas draws a box that
  // nothing can reach.
  const seen = new Set()
  const incoming = (graph.nodes || []).filter(n => {
    if (!n || !n.id || seen.has(n.id)) return false
    seen.add(n.id)
    return true
  })

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
    // Colour overrides are the user's, and optional: absent means "whatever this
    // kind looks like", so changing kind still recolours the box.
    if (typeof raw.stroke === 'string' && raw.stroke) node.stroke = raw.stroke
    if (typeof raw.fill === 'string' && raw.fill) node.fill = raw.fill
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
    // Appearance is the user's - position, size and colour. The agent's lever on
    // how a box looks is `kind`, which means something. Strip the rest.
    const { x, y, w, h, stroke, fill, ...structure } = incoming
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
