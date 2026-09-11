import express from 'express'
import path from 'node:path'
import {
  query, listSessions, getSessionMessages, renameSession, deleteSession
} from '@anthropic-ai/claude-agent-sdk'
import { readGraph, writeGraph, graphPathFor } from './graph.mjs'
import { createCanvasServer, CANVAS_TOOLS, isCanvasTool } from './tools.mjs'
import { pickFolder } from './pickFolder.mjs'
import { scanRepo } from './scan.mjs'
import {
  readConfig, addWorkspace, removeWorkspace, setActiveWorkspace,
  setActiveSession, activeWorkspace, isUsableDir, CONFIG_PATH
} from './workspaces.mjs'

const PORT = Number(process.env.PORT || 8787)

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
async function withWorkspace (res, fn) {
  const workspace = await activeWorkspace()
  if (!workspace) return res.status(409).json({ error: 'no workspace selected' })
  if (!isUsableDir(workspace.dir)) {
    return res.status(409).json({ error: `workspace folder is gone: ${workspace.dir}` })
  }
  try {
    return await fn(workspace)
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

app.get('/api/sessions', (req, res) => withWorkspace(res, async workspace => {
  const sessions = await listSessions({ dir: workspace.dir, limit: 50 })
  res.json({
    activeSessionId: workspace.activeSessionId,
    sessions: sessions.map(s => ({
      sessionId: s.sessionId,
      title: sessionTitle(s),
      lastModified: s.lastModified,
      gitBranch: s.gitBranch ?? null
    }))
  })
}))

// A new session has no id until its first turn; clearing the pointer is enough.
app.post('/api/sessions/new', (req, res) => withWorkspace(res, async workspace => {
  await setActiveSession(workspace.id, null)
  res.json({ activeSessionId: null })
}))

app.post('/api/sessions/:id/activate', (req, res) => withWorkspace(res, async workspace => {
  await setActiveSession(workspace.id, req.params.id)
  res.json({ activeSessionId: req.params.id })
}))

// Strip the scope block we append when sending, so replay shows what was typed.
const spoken = text => String(text).split('\n\n<selected-node')[0]

app.get('/api/sessions/:id/messages', (req, res) => withWorkspace(res, async workspace => {
  const raw = await getSessionMessages(req.params.id, { dir: workspace.dir })
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

app.patch('/api/sessions/:id', (req, res) => withWorkspace(res, async workspace => {
  await renameSession(req.params.id, String(req.body?.title ?? '').trim(), { dir: workspace.dir })
  res.json({ ok: true })
}))

app.delete('/api/sessions/:id', (req, res) => withWorkspace(res, async workspace => {
  await deleteSession(req.params.id, { dir: workspace.dir })
  if (workspace.activeSessionId === req.params.id) await setActiveSession(workspace.id, null)
  res.json({ ok: true })
}))

/* ---- graph ---- */

app.get('/api/graph', (req, res) => withWorkspace(res, async workspace => {
  res.json({
    graph: await readGraph(workspace.dir),
    projectDir: workspace.dir,
    graphPath: graphPathFor(workspace.dir),
    blocked: notReady(workspace)
  })
}))

// The canvas owns layout and node metadata; the agent owns structure.
app.put('/api/graph', (req, res) => withWorkspace(res, async workspace => {
  res.json({ graph: await writeGraph(workspace.dir, req.body) })
}))

// Clearing the "changed" markers is how you acknowledge a batch of work.
app.post('/api/acknowledge', (req, res) => withWorkspace(res, async workspace => {
  const graph = await readGraph(workspace.dir)
  const ids = req.body?.ids
  for (const node of graph.nodes) {
    if (!ids || ids.includes(node.id)) node.touched = false
  }
  res.json({ graph: await writeGraph(workspace.dir, graph) })
}))


/* ---- bootstrapping an overview ---- */

// Layout is the user's even when structure is rewritten, so existing boxes keep
// where they sit.
const pickLayout = node =>
  node ? { x: node.x, y: node.y, w: node.w, h: node.h } : {}

// Read-only preview: what the repo declares about itself.
app.get('/api/scan', (req, res) => withWorkspace(res, async workspace => {
  res.json(await scanRepo(workspace.dir))
}))

// Apply the scan. Positions of nodes that already exist are kept, because
// layout is the user's even when the structure is being rewritten.
app.post('/api/scan', (req, res) => withWorkspace(res, async workspace => {
  const draft = await scanRepo(workspace.dir)
  const current = await readGraph(workspace.dir)
  const placed = new Map(current.nodes.map(n => [n.id, n]))

  const nodes = draft.nodes.map(n => ({ ...n, ...pickLayout(placed.get(n.id)), touched: true }))
  const keep = req.body?.replace
    ? []
    : current.nodes.filter(n => !draft.nodes.some(d => d.id === n.id))
  const keptEdges = req.body?.replace
    ? []
    : current.edges.filter(e => !draft.edges.some(d => d.id === e.id))

  const graph = await writeGraph(workspace.dir, {
    version: 1,
    nodes: [...keep, ...nodes],
    edges: [...keptEdges, ...draft.edges]
  })
  res.json({ graph, detected: draft.detected })
}))

/* ---- structure by hand (server-side; the canvas still cannot do this) ---- */

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

app.post('/api/nodes', (req, res) => withWorkspace(res, async workspace => {
  const label = String(req.body?.label ?? '').trim()
  if (!label) throw new Error('give the component a name')
  const graph = await readGraph(workspace.dir)
  let id = slugify(req.body?.id || label) || 'component'
  for (let i = 2; graph.nodes.some(n => n.id === id); i++) id = `${slugify(label)}-${i}`
  graph.nodes.push({
    id,
    label,
    kind: req.body?.kind ?? 'service',
    paths: Array.isArray(req.body?.paths) ? req.body.paths : [],
    notes: req.body?.notes ?? ''
  })
  res.json({ graph: await writeGraph(workspace.dir, graph), id })
}))

app.delete('/api/nodes/:id', (req, res) => withWorkspace(res, async workspace => {
  const graph = await readGraph(workspace.dir)
  graph.nodes = graph.nodes.filter(n => n.id !== req.params.id)
  res.json({ graph: await writeGraph(workspace.dir, graph) })
}))

app.post('/api/edges', (req, res) => withWorkspace(res, async workspace => {
  const { from, to, label } = req.body ?? {}
  if (!from || !to || from === to) throw new Error('an edge needs two different nodes')
  const graph = await readGraph(workspace.dir)
  const id = `e-${from}-${to}`
  if (!graph.edges.some(e => e.id === id)) graph.edges.push({ id, from, to, label: label ?? '' })
  res.json({ graph: await writeGraph(workspace.dir, graph) })
}))

app.delete('/api/edges/:id', (req, res) => withWorkspace(res, async workspace => {
  const graph = await readGraph(workspace.dir)
  graph.edges = graph.edges.filter(e => e.id !== req.params.id)
  res.json({ graph: await writeGraph(workspace.dir, graph) })
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

app.post('/api/chat', async (req, res) => {
  const { prompt, nodeId } = req.body ?? {}
  if (!prompt?.trim()) return res.status(400).json({ error: 'empty prompt' })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // The Vite dev proxy, and anything else in front of us, must not buffer.
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders()
  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const workspace = await activeWorkspace()
  const stop = async (message) => {
    send('error', { message })
    send('done', { subtype: 'error', graph: workspace ? await readGraph(workspace.dir) : null })
    res.end()
  }

  const blocked = notReady(workspace)
  if (blocked) return stop(blocked)
  if (inFlight) return stop(`A turn is already running in "${inFlight}". Wait for it to finish.`)
  inFlight = workspace.name

  let scoped = prompt
  if (nodeId) {
    const graph = await readGraph(workspace.dir)
    const node = graph.nodes.find(n => n.id === nodeId)
    if (node) {
      scoped = `${prompt}\n\n<selected-node id="${node.id}" label="${node.label}">\nThe user selected this node on the canvas. Its code: ${node.paths.join(', ') || '(no paths set)'}. Scope your work here unless told otherwise.\n</selected-node>`
    }
  }

  try {
    for await (const message of query({
      prompt: scoped,
      options: {
        cwd: workspace.dir,
        resume: workspace.activeSessionId ?? undefined,
        mcpServers: { canvas: createCanvasServer(workspace.dir) },
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
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        // A fresh conversation gets its id here; remember it so the session
        // shows up in the picker and the next turn resumes it.
        await setActiveSession(workspace.id, message.session_id)
        send('session', { sessionId: message.session_id })
      }
      if (message.type === 'assistant') {
        if (message.error) send('error', { message: String(message.error) })
        for (const block of message.message.content) {
          if (block.type === 'text') send('text', { text: block.text })
          if (block.type === 'tool_use') send('tool', { name: block.name, input: block.input })
        }
      }
      if (message.type === 'result') {
        if (message.session_id) await setActiveSession(workspace.id, message.session_id)
        if (message.subtype !== 'success') {
          send('error', { message: message.result || `Turn ended: ${message.subtype}` })
        }
        send('done', { subtype: message.subtype, graph: await readGraph(workspace.dir) })
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
    // The client waits on 'done' to unlock the prompt box.
    send('done', { subtype: 'error', graph: await readGraph(workspace.dir) })
  } finally {
    inFlight = null
    res.end()
  }
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
