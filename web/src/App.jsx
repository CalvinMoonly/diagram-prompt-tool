import React, { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './Canvas.jsx'
import { crossingCount } from './graphToScene.js'
import Chat, { clock } from './Chat.jsx'
import Inspector, { EdgePanel } from './Inspector.jsx'
import Nav from './Nav.jsx'
import ScanPanel from './ScanPanel.jsx'

const json = async (url, options) => {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status}`)
  return body
}

// What the agent is asked after a scan. The evidence trail goes with it: the
// scanner's guesses are exactly what needs checking, so saying what it saw and
// what it inferred is worth more than asking cold.
const refinePrompt = detected => [
  'The diagram was just drafted by the repo scanner. It reads only declared evidence',
  '- compose services, dependency manifests, workspace packages - and cannot read code,',
  'so treat every node as a guess. Go over it against what this repo actually contains:',
  '',
  '- give each node the folders it really owns, and remove nodes that are not real components',
  '- correct labels and kinds the scanner guessed',
  '- add the edges that actually exist; the scanner emits almost none',
  '',
  'Use get_graph, then patch_graph. Change the diagram only - do not edit any source files.',
  '',
  'What the scan detected:',
  detected.join('\n')
].join('\n')

// What the agent is asked when you press "Arrange with AI". Deliberately not a
// grid: grouping by meaning is what makes a diagram readable, and a tidy grid that
// ignores the arrows is what we already have offline.
// What the agent is asked when you press "Arrange with AI". It cannot see the
// canvas, so the prompt has to say what is wrong in numbers - and say plainly that
// the current positions are the problem, or it reads them as a layout to preserve
// and hands the same thing back.
const arrangePrompt = ({ hits, counted }) => [
  'This diagram is unreadable and needs laying out again from scratch.',
  `Right now ${hits} of its ${counted} arrows run straight through a box that is not`,
  'either end of that arrow, which is what makes it unreadable.',
  '',
  'Ignore the current x/y completely - do not treat them as a starting point, and do',
  'not hand back positions close to the ones you were given. Call get_graph, decide',
  'placement from the edges alone, then call set_layout with every box.',
  '',
  '- Group boxes that talk to each other, and let the arrows run mostly one way so',
  '  the shape shows: what feeds what, and where the ends are.',
  '- Leave clear lanes between groups for arrows to travel down. Coordinates are the',
  '  top-left corner; boxes are 220 wide and 90 tall unless the graph says otherwise.',
  '- Nothing may overlap. It does not have to be a grid, and it should not be an even',
  '  one: uneven spacing that groups by meaning is what makes it readable.',
  '',
  'Positions only. Do not add, remove, rename or re-link anything, and do not edit',
  'files. Keep your reply to a couple of lines - the diagram is the output.'
].join('\n')

const post = (url, body) => json(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {})
})

export default function App () {
  const [workspaces, setWorkspaces] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(null)

  const [graph, setGraph] = useState(null)
  // One diagram per session, chosen by the server. Kept here only to key the
  // canvas and to label the bar - there is nothing to pick.
  const [diagram, setDiagram] = useState('main')
  // { kind: 'node' | 'edge', id } - an arrow is a legitimate thing to scope to.
  const [selection, setSelection] = useState(null)
  const [meta, setMeta] = useState({})
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [newComponent, setNewComponent] = useState(null)
  const [queuedPrompt, setQueuedPrompt] = useState(null)
  // The canvas re-seeds on structure, and deliberately ignores positions so a
  // re-seed cannot stomp a drag. A tidy changes only positions, so it needs to
  // ask for the re-seed explicitly.
  const [layoutNonce, setLayoutNonce] = useState(0)
  // Running total for the session, so the cost of a long arrange turn is visible
  // rather than guessed at.
  const [spend, setSpend] = useState({ turns: 0, input: 0, output: 0, costUSD: 0, ms: 0 })
  const [model, setModel] = useState('')
  const [models, setModels] = useState([])
  // What the SDK actually resolved the choice to, reported at init. The alias you
  // pick is a request; this is what ran.
  const [resolvedModel, setResolvedModel] = useState('')
  // A read-only look at the canonical map, and the one route back to it. Session
  // diagrams are gitignored working state; main is what a pull request reviews.
  const [mainGraph, setMainGraph] = useState(null)
  const [confirmPromote, setConfirmPromote] = useState(false)
  // Pane width is a per-machine preference, so it lives in localStorage rather
  // than in the workspace config that travels between repos.
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem('promptcanvas.chatWidth'))
      return Number.isFinite(saved) && saved > 0 ? saved : 380
    } catch {
      return 380
    }
  })
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)

  const push = useCallback(entry => setMessages(m => [...m, entry]), [])

  // Everything below the nav belongs to the active workspace, so it reloads as
  // one unit. The graph and the workspace id must land in the SAME render: the
  // canvas is keyed on the workspace, and remounting it while `graph` still
  // holds the previous repo's nodes would seed the wrong layout - which then
  // gets saved over the graph of the repo you just switched to.
  const loadActive = useCallback(async () => {
    const [c, g, s, m] = await Promise.all([
      json('/api/workspaces'),
      json('/api/graph').catch(err => ({ error: err.message })),
      json('/api/sessions').catch(() => ({ sessions: [], activeSessionId: null })),
      json('/api/models').catch(() => ({ model: '', options: [] }))
    ])
    setModel(m.model ?? '')
    setModels(m.options ?? [])

    setWorkspaces(c.workspaces)
    setActiveId(c.activeId)
    setSelection(null)
    if (g.error) {
      setGraph(null)
      setMeta({ blocked: c.workspaces.length ? g.error : null })
    } else {
      setGraph(g.graph)
      setDiagram(g.diagram ?? 'main')
      setMeta({ projectDir: g.projectDir, graphPath: g.graphPath, blocked: g.blocked })
    }
    setSessions(s.sessions ?? [])
    setActiveSessionId(s.activeSessionId ?? null)

    // The transcript does not affect the canvas, so it can settle afterwards.
    if (s.activeSessionId) {
      const t = await json(`/api/sessions/${s.activeSessionId}/messages`).catch(() => ({ messages: [] }))
      setMessages(t.messages)
    } else {
      setMessages([])
    }
  }, [])

  useEffect(() => { loadActive() }, [])

  // A reload drops the SSE stream, but the turn carries on server-side. Pick it
  // back up so the pane shows it is still working, and refresh when it lands -
  // otherwise you lose the prompt and the answer you were waiting for.
  useEffect(() => {
    let alive = true
    let sawBusy = false
    const tick = async () => {
      if (!alive) return
      const status = await json('/api/status').catch(() => null)
      if (!alive) return
      if (status?.busy) {
        sawBusy = true
        setBusy(true)
        setTimeout(tick, 2000)
        return
      }
      if (sawBusy) {
        setBusy(false)
        loadActive()
      }
    }
    tick()
    return () => { alive = false }
  }, [loadActive])

  const pickWorkspace = async id => {
    if (id === activeId) return
    await post(`/api/workspaces/${id}/activate`)
    await loadActive()
  }

  // The folder dialog opens on the machine running the server; this just waits.
  const browseForFolder = () => post('/api/pick-folder')

  const addWorkspace = async dir => {
    await post('/api/workspaces', { dir })
    await loadActive()
  }

  const removeWorkspace = async id => {
    await json(`/api/workspaces/${id}`, { method: 'DELETE' })
    await loadActive()
  }

  // Activating a session may switch the diagram under us - that is the point of
  // binding them - so reload the graph, not just the transcript.
  const pickSession = async sessionId => {
    if (!sessionId) return
    await post(`/api/sessions/${sessionId}/activate`)
    const [g, t] = await Promise.all([
      json('/api/graph'),
      json(`/api/sessions/${sessionId}/messages`)
    ])
    setActiveSessionId(sessionId)
    setGraph(g.graph)
    setDiagram(g.diagram ?? 'main')
    setSelection(null)
    setMessages(t.messages)
  }

  // The server allocates the session and its diagram now, so it is a normal
  // entry in the picker before a word has been typed.
  const newSession = async () => {
    const created = await post('/api/sessions/new')
    const [s, g] = await Promise.all([json('/api/sessions'), json('/api/graph')])
    setActiveSessionId(created.activeSessionId)
    setSessions(s.sessions ?? [])
    setGraph(g.graph)
    setDiagram(g.diagram ?? 'main')
    setSelection(null)
    setMessages([])
    setSpend({ turns: 0, input: 0, output: 0, costUSD: 0, ms: 0 })
  }

  const renameSession = async (sessionId, title) => {
    await json(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title })
    })
    setSessions(await json('/api/sessions').then(s => s.sessions))
  }

  const deleteSession = async sessionId => {
    await json(`/api/sessions/${sessionId}`, { method: 'DELETE' })
    const s = await json('/api/sessions')
    setSessions(s.sessions)
    setActiveSessionId(s.activeSessionId)
    if (!s.activeSessionId) setMessages([])
  }

  // A turn that starts a fresh conversation reports its new id; pick it up so the
  // session appears in the picker without a reload.
  const onSessionStarted = async sessionId => {
    setActiveSessionId(sessionId)
    // The turn that births a session also creates its diagram; pick up the name.
    json('/api/graph').then(g => setDiagram(g.diagram ?? 'main')).catch(() => {})
    setSessions(await json('/api/sessions').then(s => s.sessions).catch(() => sessions))
  }

  const previewScan = () => json('/api/scan')

  // The scanner reads only what the repo declares and cannot read code, so the
  // draft is a starting point. `refine` hands it straight to the agent to check
  // against the source - the two-step flow the README describes, one click.
  const applyScan = async (replace, refine) => {
    const res = await post('/api/scan', { replace })
    setGraph(res.graph)
    if (refine) setQueuedPrompt({ text: refinePrompt(res.detected ?? []) })
  }

  const pickModel = async id => {
    const res = await post('/api/model', { model: id })
    setModel(res.model)
    setResolvedModel('')
  }

  const arrangeWithAI = () => {
    if (!graph) return
    setQueuedPrompt({ text: arrangePrompt(crossingCount(graph)), allowLayout: true })
  }

  // A turn that only moved boxes leaves the structure key unchanged, so the canvas
  // would not redraw without being told.
  const onGraphChanged = next => {
    const moved = graph && next?.nodes?.some(n => {
      const before = graph.nodes.find(b => b.id === n.id)
      return before && (before.x !== n.x || before.y !== n.y)
    })
    setGraph(next)
    if (moved) setLayoutNonce(v => v + 1)
  }

  const viewMain = async () => {
    if (mainGraph) return setMainGraph(null)
    const res = await json('/api/graph/main')
    setSelection(null)
    setMainGraph(res.graph)
  }

  const promote = async () => {
    const res = await post('/api/promote')
    setConfirmPromote(false)
    if (mainGraph) setMainGraph(res.graph)
  }

  // Structure by hand goes through the server, exactly like the agent's patch.
  // Drawing a rectangle on the canvas still does nothing.
  const addComponent = async label => {
    const name = label.trim()
    if (!name) return
    const res = await post('/api/nodes', { label: name })
    setGraph(res.graph)
    setNewComponent(null)
    // Open it straight away: a component with no owned folders is not much use.
    setSelection({ kind: 'node', id: res.id })
  }

  const save = async next => {
    setGraph(next)
    await fetch('/api/graph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    })
  }

  // Drawing an arrow on the canvas now creates a real connection. It still goes
  // through the server, same as the agent's patch - the canvas never writes the
  // file directly.
  const addEdge = async (from, to) => {
    const res = await post('/api/edges', { from, to })
    setGraph(res.graph)
  }

  // Renaming in place, from the canvas or the inspector - both end up here.
  const relabel = async ({ kind, id, label }) => {
    if (kind === 'edge') {
      const res = await json(`/api/edges/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label })
      })
      return setGraph(res.graph)
    }
    const node = graph?.nodes.find(n => n.id === id)
    if (node) await save({ ...graph, nodes: graph.nodes.map(n => (n.id === id ? { ...n, label } : n)) })
  }

  const recolour = async (id, stroke, fill) => {
    if (!graph) return
    await save({
      ...graph,
      nodes: graph.nodes.map(n => (n.id === id ? { ...n, stroke, fill } : n))
    })
  }

  // Back to whatever this kind looks like.
  const resetColour = async id => {
    if (!graph) return
    await save({
      ...graph,
      nodes: graph.nodes.map(n => {
        if (n.id !== id) return n
        const { stroke, fill, ...rest } = n
        return rest
      })
    })
  }

  const relink = async (id, from, to) => {
    const res = await json(`/api/edges/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to })
    })
    setGraph(res.graph)
  }

  // A rectangle drawn on the canvas, kept where it was drawn.
  const addDrawnComponent = async ({ label, x, y, w, h }) => {
    const res = await post('/api/nodes', { label, x, y, w, h })
    setGraph(res.graph)
    setSelection({ kind: 'node', id: res.id })
  }

  const deleteEdge = async id => {
    const res = await json(`/api/edges/${id}`, { method: 'DELETE' })
    setGraph(res.graph)
    setSelection(null)
  }

  const deleteComponent = async id => {
    const res = await json(`/api/nodes/${id}`, { method: 'DELETE' })
    setGraph(res.graph)
    setSelection(null)
  }

  const saveNode = node =>
    save({ ...graph, nodes: graph.nodes.map(n => (n.id === node.id ? { ...n, ...node } : n)) })

  // Layout comes back from the canvas on a debounce; it never changes structure.
  const saveLayout = positions => {
    if (!graph) return
    const nodes = graph.nodes.map(n => (positions[n.id] ? { ...n, ...positions[n.id] } : n))
    if (JSON.stringify(nodes) === JSON.stringify(graph.nodes)) return
    save({ ...graph, nodes })
  }

  const acknowledge = async () => {
    const res = await post('/api/acknowledge')
    setGraph(res.graph)
  }

  // The button should name what you recognise. `diagram` is the file on disk
  // (session-5); the session's own title is what you picked it by.
  const currentSession = sessions.find(s => s.sessionId === activeSessionId) ?? null
  const backTo = currentSession?.title || diagram
  const backToShort = backTo.length > 26 ? `${backTo.slice(0, 25)}…` : backTo

  // The listeners go on the window, not the 6px handle: during a drag the pointer
  // is over the canvas almost the whole time. They are attached here rather than
  // in an effect because `setDragging` is async - an effect attaches a frame late
  // and a quick drag is already over by then.
  const beginDrag = e => {
    e.preventDefault()
    // A real mouse fires pointerdown AND mousedown; only the first should bind.
    if (draggingRef.current) return
    draggingRef.current = true
    setDragging(true)

    const move = ev => {
      const max = Math.max(320, window.innerWidth - 360)
      setChatWidth(Math.min(max, Math.max(280, ev.clientX)))
    }
    const stop = () => {
      for (const [type, fn] of pairs) window.removeEventListener(type, fn)
      draggingRef.current = false
      setDragging(false)
    }
    // Both families: pointer events cover touch and pen, and some environments
    // deliver only the mouse ones. Duplicate moves are idempotent.
    const pairs = [
      ['pointermove', move], ['mousemove', move],
      ['pointerup', stop], ['mouseup', stop], ['pointercancel', stop]
    ]
    for (const [type, fn] of pairs) window.addEventListener(type, fn)
  }

  // Persist once the drag settles, not on every pixel.
  useEffect(() => {
    if (dragging) return
    try { localStorage.setItem('promptcanvas.chatWidth', String(chatWidth)) } catch {}
  }, [dragging, chatWidth])

  const selectedEdge = selection?.kind === 'edge'
    ? graph?.edges.find(e => e.id === selection.id) ?? null
    : null

  // The Inspector edits nodes only; an edge has nothing to edit yet.
  const selectedNode = selection?.kind === 'node'
    ? graph?.nodes.find(n => n.id === selection.id) ?? null
    : null

  // What the prompt is scoped to, and what the chip says.
  const scope = (() => {
    if (!graph || !selection) return null
    if (selection.kind === 'node') {
      const n = graph.nodes.find(x => x.id === selection.id)
      return n ? { kind: 'node', id: n.id, label: n.label } : null
    }
    const e = graph.edges.find(x => x.id === selection.id)
    if (!e) return null
    const name = id => graph.nodes.find(n => n.id === id)?.label ?? id
    return { kind: 'edge', id: e.id, label: `${name(e.from)} → ${name(e.to)}` }
  })()
  const touched = graph?.nodes.filter(n => n.touched) ?? []

  return (
    <div
      className={`app${dragging ? ' dragging' : ''}`}
      style={{ '--chat-w': `${chatWidth}px` }}
    >
      <Nav
        workspaces={workspaces}
        activeId={activeId}
        sessions={sessions}
        activeSessionId={activeSessionId}
        busy={busy}
        onPickWorkspace={pickWorkspace}
        onAddWorkspace={addWorkspace}
        onBrowse={browseForFolder}
        onRemoveWorkspace={removeWorkspace}
        onPickSession={pickSession}
        onNewSession={newSession}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
      />

      <Chat
        model={model}
        models={models}
        resolvedModel={resolvedModel}
        onPickModel={pickModel}
        onStop={() => post('/api/stop').catch(() => {})}
        onModelResolved={setResolvedModel}
        onUsage={u => setSpend(p => ({
          turns: p.turns + 1,
          input: p.input + u.input + u.cacheRead,
          output: p.output + u.output,
          costUSD: p.costUSD + u.costUSD,
          ms: p.ms + u.ms
        }))}
        spend={spend}
        queuedPrompt={queuedPrompt}
        onQueuedConsumed={() => setQueuedPrompt(null)}
        scope={scope}
        messages={messages}
        onPush={push}
        busy={busy}
        onBusy={setBusy}
        disabled={!activeId}
        onClearScope={() => setSelection(null)}
        onGraphChanged={onGraphChanged}
        onSessionStarted={onSessionStarted}
      />

      <div
        className={`splitter${dragging ? ' on' : ''}`}
        onPointerDown={beginDrag}
        onMouseDown={beginDrag}
        title="Drag to resize"
      />

      <main>
        <header className="bar">
          <span className="dir" title={meta.projectDir}>{meta.projectDir ?? ''}</span>
          {graph && (
            <span className="dir-diagram" title={meta.graphPath}>
              {mainGraph ? 'main - read only' : diagram}
            </span>
          )}
          {graph && (
            <span className="bar-tools">
              {(diagram !== 'main' || mainGraph) && (
                <button
                  onClick={viewMain}
                  title={mainGraph
                    ? `Back to ${backTo}`
                    : 'Look at the canonical graph.json without leaving your session'}
                >
                  {mainGraph ? `back to ${backToShort}` : 'view main'}
                </button>
              )}
              {diagram !== 'main' && (confirmPromote ? (
                <>
                  <button className="primary" onClick={promote}>Overwrite main</button>
                  <button onClick={() => setConfirmPromote(false)}>cancel</button>
                </>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => setConfirmPromote(true)}
                  title="Copy this session's diagram over .promptcanvas/graph.json - the file that gets committed"
                >promote to main</button>
              ))}
            </span>
          )}
          {graph && (
            <span className="bar-tools">
              <button onClick={() => setScanning(true)}>Scan repo</button>
              <button
                disabled={busy}
                onClick={arrangeWithAI}
                title="Let the agent place the boxes by meaning. Moves your boxes - costs a turn."
              >Arrange with AI</button>
              {newComponent === null ? (
                <button onClick={() => setNewComponent('')}>+ component</button>
              ) : (
                <form
                  className="add"
                  onSubmit={e => { e.preventDefault(); addComponent(newComponent) }}
                >
                  <input
                    autoFocus
                    value={newComponent}
                    placeholder="Component name"
                    onChange={e => setNewComponent(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setNewComponent(null) }}
                  />
                  <button className="primary" type="submit" disabled={!newComponent.trim()}>Add</button>
                </form>
              )}
            </span>
          )}
          {touched.length > 0 && (
            <button onClick={acknowledge}>
              {touched.length} changed - mark reviewed
            </button>
          )}
        </header>

        {graph ? (
          // Keyed by workspace so each repo gets its own canvas. Without this a
          // switch between two graphs of identical shape leaves the previous
          // repo's boxes on screen, and its layout gets saved over the new one.
          <Canvas
            key={`${activeId}:${mainGraph ? 'main-preview' : diagram}`}
            layoutNonce={layoutNonce}
            locked={busy || !!mainGraph}
            graph={mainGraph ?? graph}
            selection={selection}
            onSelect={setSelection}
            onLayout={saveLayout}
            onAddEdge={addEdge}
            onRelabel={relabel}
            onRelink={relink}
            onRecolour={recolour}
            onAddComponent={addDrawnComponent}
          />
        ) : (
          <div className="blank">
            {workspaces.length === 0
              ? 'Add a repo above to get started.'
              : (meta.blocked ?? 'Loading...')}
          </div>
        )}

        {selectedNode && (
          <Inspector
            node={selectedNode}
            onSave={saveNode}
            onDelete={deleteComponent}
            onResetColour={resetColour}
            onClose={() => setSelection(null)}
            // Looking is fine while a turn runs or while previewing main;
            // writing is not - it would race the agent, or write the session's
            // graph while main is on screen.
            locked={busy || !!mainGraph}
          />
        )}

        {selectedEdge && (
          <EdgePanel
            edge={selectedEdge}
            fromLabel={graph?.nodes.find(n => n.id === selectedEdge.from)?.label ?? selectedEdge.from}
            toLabel={graph?.nodes.find(n => n.id === selectedEdge.to)?.label ?? selectedEdge.to}
            onRelabel={relabel}
            onDelete={deleteEdge}
            onClose={() => setSelection(null)}
            locked={busy || !!mainGraph}
          />
        )}

        {scanning && (
          <ScanPanel
            onPreview={previewScan}
            onApply={applyScan}
            onClose={() => setScanning(false)}
          />
        )}
      </main>
    </div>
  )
}
