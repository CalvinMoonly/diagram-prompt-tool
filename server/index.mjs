import express from 'express'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  query, listSessions, getSessionMessages, getSessionInfo, renameSession, deleteSession,
  tagSession
} from '@anthropic-ai/claude-agent-sdk'
import {
  readGraph, writeGraph, graphPathFor, listDiagrams, createDiagram, uniqueDiagramName, MAIN
} from './graph.mjs'
import { createCanvasServer, CANVAS_TOOLS, isCanvasTool } from './tools.mjs'
import { pickFolder } from './pickFolder.mjs'
import { scanRepo } from './scan.mjs'
import {
  readConfig, addWorkspace, removeWorkspace, setActiveWorkspace,
  setActiveSession, setActiveDiagram, forgetSession, setPendingSession, setModel, activeWorkspace, isUsableDir, CONFIG_PATH
} from './workspaces.mjs'

const PORT = Number(process.env.PORT || 8787)

// Aliases rather than pinned ids, so a pick keeps working as versions move. The
// SDK reports the model it actually resolved to at `init`, and that is what the
// UI shows - so the label here never has to be the source of truth.
const MODELS = [
  { id: '', label: 'Default (SDK picks)' },
  { id: 'opus', label: 'Opus - most capable' },
  { id: 'sonnet', label: 'Sonnet - balanced' },
  { id: 'haiku', label: 'Haiku - fastest and cheapest' }
]

// The SDK stores sessions per project directory, so a repo's terminal Claude Code
// history shares a store with ours. Every session we start is tagged, and the
// picker lists only tagged ones, so your own terminal sessions stay out of it.
const SESSION_TAG = 'promptcanvas'
// listSessions applies `limit` before we get to filter, so read a wide window and
// trim after. A repo with a long terminal history must not push ours out of view.
const SESSION_SCAN = 200
const SESSION_LIMIT = 50

const THIRD_PARTY = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS']
const HAS_AUTH = !!process.env.ANTHROPIC_API_KEY || THIRD_PARTY.some(v => process.env[v])
const PLACEHOLDER_KEY = /^sk-ant-\.\.\.$/.test(process.env.ANTHROPIC_API_KEY ?? '')

if (!HAS_AUTH || PLACEHOLDER_KEY) {
  console.error('\n  No usable ANTHROPIC_API_KEY found.')
  console.error('  Put one in .env (see .env.example). Get a key at https://platform.claude.com/.')
  console.error('  Your Claude subscription does not cover agents you build yourself.')
  console.error('  Note: editing .env does not restart the server - node --watch only\n  watches imported modules. Restart npm run dev yourself.\n')
}

const app = express()
app.use(express.json({ limit: '4mb' }))

// Every graph route works against whichever workspace is active. Without one
// there is nothing to show, which is a normal empty state, not an error.
// The workspace remembers a diagram by name, and that file can be deleted from
// under it. Fall back to main rather than failing every read.
async function resolveDiagram (workspace) {
  const names = await listDiagrams(workspace.dir)
  return names.includes(workspace.diagram) ? workspace.diagram : MAIN
}

async function withWorkspace (res, fn) {
  const workspace = await activeWorkspace()
  if (!workspace) return res.status(409).json({ error: 'no workspace selected' })
  if (!isUsableDir(workspace.dir)) {
    return res.status(409).json({ error: `workspace folder is gone: ${workspace.dir}` })
  }
  try {
    return await fn(workspace, await resolveDiagram(workspace))
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }
}

// Why the agent cannot run right now, in one sentence, or null if it can.
function notReady (workspace) {
  if (!workspace) return 'Add a workspace first - pick the repo you want to work in.'
  if (!isUsableDir(workspace.dir)) return `Workspace folder is gone: ${workspace.dir}`
  if (!HAS_AUTH || PLACEHOLDER_KEY) return 'No ANTHROPIC_API_KEY in .env. Get a key at https://platform.claude.com/ and restart the server. A Claude subscription login does not work here.'
  return null
}

/* ---- workspaces ---- */

app.get('/api/workspaces', async (_req, res) => {
  const config = await readConfig()
  res.json({ ...config, configPath: CONFIG_PATH })
})

// Opens the OS folder dialog on the machine running the server. Starts from the
// folder holding the workspaces you already have, so it lands somewhere useful.
app.post('/api/pick-folder', async (_req, res) => {
  const config = await readConfig()
  const startIn = config.workspaces.length
    ? path.dirname(config.workspaces[config.workspaces.length - 1].dir)
    : undefined
  res.json(await pickFolder(startIn))
})

app.post('/api/workspaces', async (req, res) => {
  try {
    res.json(await addWorkspace(req.body?.dir))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Drops it from the bar. Nothing on disk is touched, graph.json included.
app.delete('/api/workspaces/:id', async (req, res) => {
  res.json(await removeWorkspace(req.params.id))
})

app.post('/api/workspaces/:id/activate', async (req, res) => {
  try {
    res.json(await setActiveWorkspace(req.params.id))
  } catch (err) {
    res.status(404).json({ error: err.message })
  }
})

/* ---- sessions (the SDK stores these; we only track which one is live) ---- */

const sessionTitle = s =>
  s.customTitle || s.summary || s.firstPrompt?.slice(0, 80) || 'Untitled session'

// A session the picker will not show must not be silently resumed either.
// A stored id can predate tagging, or be a terminal session picked before this
// rule existed; resuming one would pull that history into the next turn.
const ourSession = async (dir, sessionId) => {
  if (!sessionId) return null
  try {
    const info = await getSessionInfo(sessionId, { dir })
    return info?.tag === SESSION_TAG ? sessionId : null
  } catch {
    return null
  }
}

app.get('/api/sessions', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const all = await listSessions({ dir: workspace.dir, limit: SESSION_SCAN })
  const listed = all.filter(s => s.tag === SESSION_TAG).slice(0, SESSION_LIMIT)
  // The SDK writes a transcript on the first turn, so a session started from
  // `+ session` is not in its store yet. Show it anyway - it has an id and a
  // diagram already, and it behaves like any other entry.
  const pending = workspace.pendingSession
  const sessions = pending && !listed.some(s => s.sessionId === pending.id)
    ? [{ sessionId: pending.id, summary: pending.title, lastModified: pending.createdAt }, ...listed]
    : listed
  res.json({
    // A pending session is ours by construction; it just has no transcript for
    // ourSession() to check yet.
    activeSessionId: workspace.activeSessionId === pending?.id
      ? pending.id
      : await ourSession(workspace.dir, workspace.activeSessionId),
    sessions: sessions.map(s => ({
      sessionId: s.sessionId,
      title: sessionTitle(s),
      lastModified: s.lastModified,
      gitBranch: s.gitBranch ?? null
    }))
  })
}))

// Allocate the session up front - the SDK takes our id via `sessionId` - so it
// appears in the picker straight away instead of only after the first turn.
app.post('/api/sessions/new', (req, res) => withWorkspace(res, async workspace => {
  // Only one can be waiting for its first turn, so a second click lands back on
  // the one already open rather than littering ids and diagrams.
  if (workspace.pendingSession) {
    await setActiveSession(workspace.id, workspace.pendingSession.id)
    return res.json({ activeSessionId: workspace.pendingSession.id })
  }
  const id = randomUUID()
  // Its diagram exists from the start, or editing the canvas before the first
  // prompt would write into main.
  const name = await uniqueDiagramName(workspace.dir, 'session')
  await createDiagram(workspace.dir, name, MAIN)
  await setPendingSession(workspace.id, { id, title: 'New session', createdAt: Date.now() })
  await setActiveSession(workspace.id, id)
  await setActiveDiagram(workspace.id, name)
  res.json({ activeSessionId: id })
}))

app.post('/api/sessions/:id/activate', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  await setActiveSession(workspace.id, req.params.id)
  res.json({ activeSessionId: req.params.id })
}))

// Strip the scope block we append when sending, so replay shows what was typed.
const spoken = text => String(text).split('\n\n<selected-')[0]

app.get('/api/sessions/:id/messages', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  // A pending session has no transcript until its first turn writes one - but
  // mid-turn it does, and that is exactly when a reload needs it.
  let raw = []
  try {
    raw = await getSessionMessages(req.params.id, { dir: workspace.dir })
  } catch (err) {
    if (workspace.pendingSession?.id !== req.params.id) throw err
  }
  const messages = []
  for (const entry of raw) {
    const content = entry?.message?.content
    if (entry.type === 'user') {
      if (typeof content === 'string') messages.push({ role: 'user', text: spoken(content) })
      else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'text') messages.push({ role: 'user', text: spoken(b.text) })
        }
      }
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'text') messages.push({ role: 'assistant', text: b.text })
        if (b?.type === 'tool_use') {
          messages.push({ role: 'tool', text: b.name.replace('mcp__canvas__', 'canvas.') })
        }
      }
    }
  }
  res.json({ messages })
}))

app.patch('/api/sessions/:id', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const title = String(req.body?.title ?? '').trim()
  if (!title) throw new Error('give the session a name')
  // A pending session has no transcript for the SDK to write a title into, so
  // hold the name here; the first turn applies it once the transcript exists.
  if (workspace.pendingSession?.id === req.params.id) {
    await setPendingSession(workspace.id, { ...workspace.pendingSession, title })
    return res.json({ ok: true, pending: true })
  }
  await renameSession(req.params.id, title, { dir: workspace.dir })
  res.json({ ok: true })
}))

app.delete('/api/sessions/:id', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  if (workspace.pendingSession?.id === req.params.id) {
    // Never reached the SDK's store, so there is no transcript to delete.
    await setPendingSession(workspace.id, null)
  } else {
    await deleteSession(req.params.id, { dir: workspace.dir })
  }
  await forgetSession(workspace.id, req.params.id)
  if (workspace.activeSessionId === req.params.id) await setActiveSession(workspace.id, null)
  res.json({ ok: true })
}))

/* ---- model ---- */

app.get('/api/models', async (req, res) => {
  const config = await readConfig()
  res.json({ model: config.model ?? '', options: MODELS })
})

app.post('/api/model', async (req, res) => {
  const id = String(req.body?.model ?? '')
  if (!MODELS.some(m => m.id === id)) return res.status(400).json({ error: `unknown model "${id}"` })
  const config = await setModel(id)
  res.json({ model: config.model })
})

/* ---- graph ---- */

app.get('/api/graph', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  res.json({
    graph: await readGraph(workspace.dir, diagram),
    projectDir: workspace.dir,
    graphPath: graphPathFor(workspace.dir, diagram),
    diagram,
    blocked: notReady(workspace)
  })
}))

// The canvas owns layout and node metadata; the agent owns structure.
app.put('/api/graph', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  res.json({ graph: await writeGraph(workspace.dir, diagram, req.body) })
}))

// Clearing the "changed" markers is how you acknowledge a batch of work.
app.post('/api/acknowledge', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const graph = await readGraph(workspace.dir, diagram)
  const ids = req.body?.ids
  for (const node of graph.nodes) {
    if (!ids || ids.includes(node.id)) node.touched = false
  }
  res.json({ graph: await writeGraph(workspace.dir, diagram, graph) })
}))


/* ---- bootstrapping an overview ---- */

// Layout is the user's even when structure is rewritten, so existing boxes keep
// where they sit.
const pickLayout = node =>
  node ? { x: node.x, y: node.y, w: node.w, h: node.h } : {}

// Read-only preview: what the repo declares about itself.
app.get('/api/scan', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  res.json(await scanRepo(workspace.dir))
}))

// Apply the scan. Positions of nodes that already exist are kept, because
// layout is the user's even when the structure is being rewritten.
app.post('/api/scan', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const draft = await scanRepo(workspace.dir)
  const current = await readGraph(workspace.dir, diagram)
  const placed = new Map(current.nodes.map(n => [n.id, n]))

  const nodes = draft.nodes.map(n => ({ ...n, ...pickLayout(placed.get(n.id)), touched: true }))
  const keep = req.body?.replace
    ? []
    : current.nodes.filter(n => !draft.nodes.some(d => d.id === n.id))
  const keptEdges = req.body?.replace
    ? []
    : current.edges.filter(e => !draft.edges.some(d => d.id === e.id))

  const graph = await writeGraph(workspace.dir, diagram, {
    version: 1,
    nodes: [...keep, ...nodes],
    edges: [...keptEdges, ...draft.edges]
  })
  res.json({ graph, detected: draft.detected })
}))

// Read-only peek at the canonical map, without touching which diagram the session
// is bound to. Not a picker - you cannot work in here, only look.
app.get('/api/graph/main', (req, res) => withWorkspace(res, async workspace => {
  res.json({ graph: await readGraph(workspace.dir, MAIN), graphPath: graphPathFor(workspace.dir, MAIN) })
}))

// The only route back from a session diagram to the one that gets committed.
// Session diagrams are gitignored working state; main is what a PR reviews, so
// without this the shared map could never be updated from real work.
app.post('/api/promote', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  if (diagram === MAIN) throw new Error('already on main')
  const graph = await readGraph(workspace.dir, diagram)
  res.json({ graph: await writeGraph(workspace.dir, MAIN, graph), from: diagram })
}))

/* ---- structure by hand (server-side; the canvas still cannot do this) ---- */

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

app.post('/api/nodes', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const label = String(req.body?.label ?? '').trim()
  if (!label) throw new Error('give the component a name')
  const graph = await readGraph(workspace.dir, diagram)
  let id = slugify(req.body?.id || label) || 'component'
  for (let i = 2; graph.nodes.some(n => n.id === id); i++) id = `${slugify(label)}-${i}`
  const at = ['x', 'y', 'w', 'h'].every(k => Number.isFinite(req.body?.[k]))
    // Drawn on the canvas: keep it where it was put, rather than auto-placing it
    // somewhere else and leaving the user to find it.
    // Keep where it was drawn, but not a box too small to read a label in.
    ? {
        x: Math.round(req.body.x),
        y: Math.round(req.body.y),
        w: Math.max(160, Math.round(req.body.w)),
        h: Math.max(70, Math.round(req.body.h))
      }
    : {}
  graph.nodes.push({
    id,
    label,
    kind: req.body?.kind ?? 'service',
    paths: Array.isArray(req.body?.paths) ? req.body.paths : [],
    notes: req.body?.notes ?? '',
    ...at
  })
  res.json({ graph: await writeGraph(workspace.dir, diagram, graph), id })
}))

app.delete('/api/nodes/:id', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const id = req.params.id
  const graph = await readGraph(workspace.dir, diagram)
  // Its connections go too. Leaving them behind puts edges in graph.json that point
  // at a node which no longer exists: invisible on the canvas, but still in the file
  // and still in a PR diff.
  const edges = graph.edges.filter(e => e.from !== id && e.to !== id)
  const removedEdges = graph.edges.length - edges.length
  const nodes = graph.nodes.filter(n => n.id !== id)
  const saved = await writeGraph(workspace.dir, diagram, { ...graph, nodes, edges })
  res.json({ graph: saved, removedEdges })
}))

app.post('/api/edges', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const { from, to, label } = req.body ?? {}
  if (!from || !to || from === to) throw new Error('an edge needs two different nodes')
  const graph = await readGraph(workspace.dir, diagram)
  const id = `e-${from}-${to}`
  if (!graph.edges.some(e => e.id === id)) graph.edges.push({ id, from, to, label: label ?? '' })
  res.json({ graph: await writeGraph(workspace.dir, diagram, graph) })
}))

// Label and endpoints are the only things an edge has. The id stays put even when
// the ends change, so anything already pointing at this edge keeps working.
app.patch('/api/edges/:id', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const graph = await readGraph(workspace.dir, diagram)
  const edge = graph.edges.find(e => e.id === req.params.id)
  if (!edge) throw new Error(`no connection "${req.params.id}"`)

  if (typeof req.body?.label === 'string') edge.label = req.body.label.trim()
  for (const end of ['from', 'to']) {
    const next = req.body?.[end]
    if (typeof next !== 'string' || !next) continue
    if (!graph.nodes.some(n => n.id === next)) throw new Error(`no component "${next}"`)
    edge[end] = next
  }
  if (edge.from === edge.to) throw new Error('a connection needs two different components')

  res.json({ graph: await writeGraph(workspace.dir, diagram, graph) })
}))

app.delete('/api/edges/:id', (req, res) => withWorkspace(res, async (workspace, diagram) => {
  const graph = await readGraph(workspace.dir, diagram)
  graph.edges = graph.edges.filter(e => e.id !== req.params.id)
  res.json({ graph: await writeGraph(workspace.dir, diagram, graph) })
}))

/* ---- chat ---- */

const SYSTEM_RULES = `
You are working inside PromptCanvas. The project's architecture lives in a graph
the user sees as a diagram beside this conversation.

Rules:
- Call get_graph before you decide where code lives. Node "paths" are authoritative.
- When you change the SHAPE of the system (a new component, a component removed,
  a new dependency between two of them), call patch_graph in the same turn.
  A code change that moves the architecture without a graph patch is incomplete.
- Do not set node positions. The user arranges the canvas; you only describe
  structure. Any x/y/w/h you send to patch_graph is discarded by the server.
- When the user has selected a node, treat its paths as the blast radius unless
  they say otherwise.
`.trim()

// Built-ins the agent may use without asking. Anything outside this set is denied
// with a message rather than left waiting on a prompt that can never be answered.
const ALLOWED_BUILTINS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite', 'NotebookEdit']

// One turn at a time, anywhere. Switching workspaces mid-turn is fine for
// looking around; starting a second turn is not.
let inFlight = null
// The turn in progress, so it can be stopped from another request. `interrupt()`
// is the graceful stop; the AbortController is the backstop if it does not take.
let running = null

// The SDK's own guidance: modelUsage is the field for token accounting (it covers
// subagents and internal calls, which `usage` does not). Summed across models so a
// turn fits on one line.
const summariseUsage = result => {
  const models = Object.values(result.modelUsage ?? {})
  if (!models.length) return null
  const sum = k => models.reduce((t, m) => t + (m[k] ?? 0), 0)
  return {
    input: sum('inputTokens'),
    output: sum('outputTokens'),
    cacheRead: sum('cacheReadInputTokens'),
    cacheWrite: sum('cacheCreationInputTokens'),
    costUSD: result.total_cost_usd ?? sum('costUSD'),
    ms: result.duration_ms ?? 0
  }
}

app.post('/api/chat', async (req, res) => {
  const { prompt, scope, allowLayout } = req.body ?? {}
  if (!prompt?.trim()) return res.status(400).json({ error: 'empty prompt' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // The Vite dev proxy, and anything else in front of us, must not buffer.
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()
  let finished = false
  const send = (event, data) => {
    if (event === 'done') finished = true
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const workspace = await activeWorkspace()
  const stop = async (message) => {
    send('error', { message })
    send('done', { subtype: 'error', graph: workspace ? await readGraph(workspace.dir, await resolveDiagram(workspace)) : null })
    res.end()
  }

  const blocked = notReady(workspace)
  if (blocked) return stop(blocked)
  if (inFlight) return stop(`A turn is already running in "${inFlight}". Wait for it to finish.`)
  inFlight = workspace.name
  let diagram = await resolveDiagram(workspace)
  const { model } = await readConfig()

  // Drop a pointer to anything that is not ours before it reaches `resume`.
  // A pending session is exempt: it has no transcript yet, so it never looks
  // like ours - and clearing it here would reset its diagram to main mid-turn.
  let pendingId = workspace.pendingSession?.id ?? null
  // A name set before the first turn has nowhere to live yet; apply it once the
  // SDK has written the transcript.
  const pendingTitle = workspace.pendingSession?.title ?? ''
  const bornPending = pendingId
  // A pending session whose transcript already exists means an earlier turn got as
  // far as creating it but never tagged it - a crash, or the server reloading
  // mid-turn. Adopt it and resume: sending `sessionId` again is refused with
  // "Session ID is already in use", which wedges the session for good.
  if (pendingId) {
    const existing = await getSessionInfo(pendingId, { dir: workspace.dir }).catch(() => null)
    if (existing) {
      await tagSession(pendingId, SESSION_TAG, { dir: workspace.dir }).catch(() => {})
      await setPendingSession(workspace.id, null)
      pendingId = null
    }
  }
  const resumeId = await ourSession(workspace.dir, workspace.activeSessionId)
  if (workspace.activeSessionId && !resumeId && workspace.activeSessionId !== pendingId) {
    await setActiveSession(workspace.id, null)
  }

  // The transcript file does not exist yet when `init` hands us the session id,
  // so tagSession cannot find it there. Claim the session at the end of the turn
  // instead - on the failure path too, or an errored turn is left unresumable.
  let sessionId = null
  let claimed = false
  const claim = async () => {
    if (!sessionId || claimed || sessionId === resumeId) return
    claimed = true
    try {
      await tagSession(sessionId, SESSION_TAG, { dir: workspace.dir })
      if (sessionId === bornPending && pendingTitle && pendingTitle !== 'New session') {
        await renameSession(sessionId, pendingTitle, { dir: workspace.dir }).catch(() => {})
      }
      // The SDK's store lists it now, so the placeholder has done its job.
      if (sessionId === pendingId) await setPendingSession(workspace.id, null)
    } catch (err) {
      send('notice', { text: `could not tag session (${err?.message ?? err})` })
    }
  }

  let scoped = prompt
  if (scope?.id) {
    const graph = await readGraph(workspace.dir, diagram)
    const label = id => graph.nodes.find(n => n.id === id)?.label ?? id
    const owns = id => graph.nodes.find(n => n.id === id)?.paths?.join(', ') || '(no paths set)'

    if (scope.kind === 'edge') {
      // An edge is a question about the wire, so give both ends: the connection
      // itself has no code, but the two things it joins do.
      const edge = graph.edges.find(e => e.id === scope.id)
      if (edge) {
        scoped = `${prompt}\n\n<selected-edge id="${edge.id}"${edge.label ? ` label="${edge.label}"` : ''}>\nThe user selected this connection on the canvas: ${label(edge.from)} -> ${label(edge.to)}${edge.label ? ` ("${edge.label}")` : ''}.\nCode at the "from" end (${label(edge.from)}): ${owns(edge.from)}\nCode at the "to" end (${label(edge.to)}): ${owns(edge.to)}\nScope your work to this connection and the two components it joins, unless told otherwise.\n</selected-edge>`
      }
    } else {
      const node = graph.nodes.find(n => n.id === scope.id)
      if (node) {
        scoped = `${prompt}\n\n<selected-node id="${node.id}" label="${node.label}">\nThe user selected this node on the canvas. Its code: ${owns(node.id)}. Scope your work here unless told otherwise.\n</selected-node>`
      }
    }
  }

  try {
    const abort = new AbortController()
    const turn = query({
      prompt: scoped,
      options: {
        abortController: abort,
        cwd: workspace.dir,
        ...(model ? { model } : {}),
        // A session started from `+ session` already has an id and a diagram, so
        // hand the SDK that id rather than letting it mint a second one.
        ...(resumeId ? { resume: resumeId } : pendingId ? { sessionId: pendingId } : {}),
        // set_layout exists only on a turn the user started from "Arrange with AI".
        mcpServers: {
          // Every write goes straight down the stream, so the canvas follows the
          // turn instead of jumping at the end of it.
          canvas: createCanvasServer(workspace.dir, () => diagram, {
            layout: !!allowLayout,
            onWrite: graph => send('graph', { graph })
          })
        },
        allowedTools: [...CANVAS_TOOLS, ...ALLOWED_BUILTINS],
        permissionMode: 'acceptEdits',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_RULES },
        canUseTool: async (toolName, input) => {
          if (isCanvasTool(toolName) || ALLOWED_BUILTINS.includes(toolName)) {
            return { behavior: 'allow', updatedInput: input }
          }
          // Nothing here can prompt a human, so say no out loud instead of hanging.
          send('notice', { text: `denied ${toolName} (not in the allowed set)` })
          return { behavior: 'deny', message: `${toolName} is not available in PromptCanvas.` }
        }
      }
    })
    running = { turn, abort, workspace: workspace.name }

    for await (const message of turn) {
      if (message.type === 'system' && message.subtype === 'init') {
        // A fresh conversation gets its id here; remember it so the session
        // shows up in the picker and the next turn resumes it.
        sessionId = message.session_id
        if (message.session_id !== resumeId && message.session_id !== pendingId) {
          // One diagram per session. A session born here (rather than from
          // `+ session`) has none yet, and its id only arrives now - which is why
          // the tool server resolves the name per call rather than at build time.
          const name = await uniqueDiagramName(workspace.dir, prompt)
          await createDiagram(workspace.dir, name, MAIN)
          diagram = name
        }
        await setActiveSession(workspace.id, message.session_id)
        if (diagram !== MAIN) await setActiveDiagram(workspace.id, diagram)
        send('session', { sessionId: message.session_id })
        if (message.model) send('model', { model: message.model })
      }
      if (message.type === 'assistant') {
        if (message.error) send('error', { message: String(message.error) })
        for (const block of message.message.content) {
          if (block.type === 'text') send('text', { text: block.text })
          if (block.type === 'tool_use') send('tool', { name: block.name, input: block.input })
        }
      }
      if (message.type === 'result') {
        if (message.session_id) {
          sessionId = message.session_id
          await setActiveSession(workspace.id, message.session_id)
        }
        await claim()
        if (message.subtype !== 'success') {
          send('error', { message: message.result || `Turn ended: ${message.subtype}` })
        }
        send('done', {
          subtype: message.subtype,
          graph: await readGraph(workspace.dir, diagram),
          usage: summariseUsage(message)
        })
      }
    }
  } catch (err) {
    const raw = err?.message ?? String(err)
    const isAuth = /authenticat|OAuth|API key|Not logged in/i.test(raw)
    send('error', {
      message: isAuth
        ? `Auth failed: ${raw}\n\nSet ANTHROPIC_API_KEY in .env and restart the server. A Claude subscription login does not work here - the Agent SDK needs an API key from https://platform.claude.com/.`
        : raw
    })
    await claim()
    // The client waits on 'done' to unlock the prompt box.
    send('done', { subtype: 'error', graph: await readGraph(workspace.dir, diagram) })
  } finally {
    inFlight = null
    running = null
    // An interrupted turn can end without a result message. Without this the
    // prompt box stays locked until the page is reloaded.
    if (!finished) {
      try {
        send('done', { subtype: 'stopped', graph: await readGraph(workspace.dir, diagram) })
      } catch {}
    }
    res.end()
  }
})

// Stop the turn in progress. Graceful first; the abort signal is the backstop.
app.post('/api/stop', async (req, res) => {
  if (!running) return res.json({ stopped: false, reason: 'nothing running' })
  const { turn, abort } = running
  try {
    await turn.interrupt?.()
  } catch {
    // interrupt is best-effort; fall through to the hard stop
  }
  try { abort.abort() } catch {}
  res.json({ stopped: true })
})

// So a reload can tell that a turn it started is still going.
app.get('/api/status', async (req, res) => {
  const workspace = await activeWorkspace()
  res.json({
    busy: !!inFlight,
    busyIn: inFlight,
    sessionId: workspace?.activeSessionId ?? null
  })
})

// vite builds into web/dist, because its root is web/.
app.use(express.static(path.join(process.cwd(), 'web', 'dist')))

app.listen(PORT, async () => {
  const config = await readConfig()
  const active = config.workspaces.find(w => w.id === config.activeId)
  console.log(`PromptCanvas server on http://localhost:${PORT}`)
  console.log(`  workspaces: ${CONFIG_PATH} (${config.workspaces.length})`)
  console.log(`  active:     ${active ? active.dir : '(none - add one in the UI)'}`)
})
