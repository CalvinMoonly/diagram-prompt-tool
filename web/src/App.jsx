import React, { useCallback, useEffect, useRef, useState } from 'react'
import Canvas from './Canvas.jsx'
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

// What the agent is asked when you press "Arrange with AI". It picks a grid cell
// per box and the server does the pixels (server/layout.mjs), so the prompt is about
// who sits next to whom - the part that needs judgement. The rules come from a
// bab-lc layout the user corrected by hand: the agent's own had boxes 120px apart
// with 17 of 47 arrow labels on a box, and connected boxes far apart (11 of 28 had a
// neighbour they talk to as their nearest box; the user's version, 21). Spacing for
// labels is now the server's job; locality and regions are the prompt's.
const ARRANGE_PROMPT = [
  'Lay this diagram out again from scratch, on a grid. Call get_graph, then call',
  'set_layout once with a column and a row for every box. Do not start from the',
  'current positions.',
  '',
  'You only choose cells. The server turns them into pixels and makes every gap wide',
  'enough for the labels on the arrows crossing it, so do not reason about pixels or',
  'spacing - only about which box sits next to which.',
  '',
  '- Put every box next to a box it talks to: connected boxes in neighbouring cells,',
  '  in the same row or the same column where you can. The arrow between them is',
  '  then straight, with its label in the gap.',
  '- Give each subsystem its own region - for example ingest, web and billing,',
  '  background workers, data stores. A chain of boxes that only talk along the chain',
  '  goes in a straight line, across a row or down a column. Leave an empty row or',
  '  column between regions as an aisle.',
  '- The busiest boxes go in the middle of what they connect to, not at an edge.',
  '- Let the arrows mostly run one way, from what feeds into what: top-left towards',
  '  bottom-right.',
  '- Keep it wider than tall: about half as many rows as columns.',
  '',
  'Layout only: do not add, remove, rename or re-link anything, do not edit files,',
  'and do not route arrows - they route themselves. Reply in a couple of lines.'
].join('\n')

const UNDO_KEYS = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘Z' : 'Ctrl+Z'
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  const graphRef = useRef(null)
  graphRef.current = graph
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
  // Clearing empties the whole session diagram, so it warns first. `cleared` is
  // what it removed, held so Ctrl+Z can put it back.
  const [confirmClear, setConfirmClear] = useState(false)
  const [cleared, setCleared] = useState(null)
  const clearAnchor = useRef(null)
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
    setQueuedPrompt({ text: ARRANGE_PROMPT, allowLayout: true })
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

  // Which repo and diagram a clear came from. Undo must land on the same one.
  const diagramKey = `${activeId}:${diagram}`

  const clearCanvas = async () => {
    setConfirmClear(false)
    const res = await post('/api/graph/clear')
    setSelection(null)
    setGraph(res.graph)
    setCleared({ key: diagramKey, graph: res.previous })
  }

  // A plain save of what the server handed back, positions and colours included.
  const undoClear = async () => {
    if (!cleared) return
    setCleared(null)
    await save(cleared.graph)
  }

  // Undo is only good while the diagram is still the empty one the clear left.
  // Once anything lands on it - a drawn box, an agent turn - restoring would throw
  // that away too; on another diagram it would overwrite the wrong one.
  useEffect(() => {
    if (!cleared) return
    const empty = graph && !graph.nodes.length && !graph.edges.length
    if (!empty || cleared.key !== diagramKey) setCleared(null)
  }, [graph, diagramKey])

  // An open warning must not outlive the diagram it was about.
  useEffect(() => setConfirmClear(false), [diagramKey, busy, !!mainGraph])

  useEffect(() => {
    if (!confirmClear) return
    const away = e => { if (!clearAnchor.current?.contains(e.target)) setConfirmClear(false) }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [confirmClear])

  // Caught on the way down, ahead of Excalidraw: its own history knows nothing
  // about graph.json, and would bring back boxes the graph no longer has. Typing
  // in the prompt box or a label keeps its own undo.
  useEffect(() => {
    if (!cleared || busy || mainGraph) return
    const onKey = e => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key?.toLowerCase() !== 'z') return
      const t = e.target
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      e.preventDefault()
      e.stopPropagation()
      undoClear()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cleared, busy, mainGraph])

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

  // An arrow's shape is layout, like a box's position, so nothing is marked as
  // changed. null puts it back on the automatic route.
  const reroute = async (id, route) => {
    const res = await json(`/api/edges/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route })
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
  // It reads the latest graph, not the one from when the timer was set: anything
  // saved in between - a reshaped arrow, a rename - would otherwise be written
  // back over with the older copy.
  const saveLayout = positions => {
    const current = graphRef.current
    if (!current) return
    const nodes = current.nodes.map(n => (positions[n.id] ? { ...n, ...positions[n.id] } : n))
    if (JSON.stringify(nodes) === JSON.stringify(current.nodes)) return
    save({ ...current, nodes })
  }

  const acknowledge = async () => {
    const res = await post('/api/acknowledge')
    setGraph(res.graph)
  }

  // The button should name what you recognise. `diagram` is the file on disk
  // (session-5); the session's own title is what you picked it by.
  const currentSession = sessions.find(s => s.sessionId === activeSessionId) ?? null
  const sessionName = currentSession?.title || diagram
  const backToShort = sessionName.length > 26 ? `${sessionName.slice(0, 25)}…` : sessionName

  // Main is the committed map, so clearing is for a session's own diagram only.
  const canClear = !busy && !mainGraph && diagram !== 'main' && !!graph?.nodes.length
  const clearTitle = diagram === 'main'
    ? 'Start a session to clear a diagram - main is the committed map'
    : graph?.nodes.length
      ? "Remove every component and connection from this session's diagram"
      : 'Nothing to clear'

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
                    ? `Back to ${sessionName}`
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
                title="Let the agent place the boxes by meaning. Moves every box and clears hand-drawn arrow routes - costs a turn."
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
              {cleared ? (
                <button
                  disabled={busy || !!mainGraph}
                  onClick={undoClear}
                  title={`Put back what Clear canvas removed (${UNDO_KEYS})`}
                >undo clear</button>
              ) : (
                <span className="pop-anchor" ref={clearAnchor}>
                  <button
                    disabled={!canClear}
                    onClick={() => setConfirmClear(v => !v)}
                    title={clearTitle}
                  >Clear canvas</button>
                  {confirmClear && (
                    <div
                      className="confirm-pop"
                      role="alertdialog"
                      aria-labelledby="clear-title"
                      onKeyDown={e => { if (e.key === 'Escape') setConfirmClear(false) }}
                    >
                      <strong id="clear-title">Clear this diagram?</strong>
                      <p>
                        Removes all {plural(graph.nodes.length, 'component')} and{' '}
                        {plural(graph.edges.length, 'connection')} from <b>{sessionName}</b>.{' '}
                        {UNDO_KEYS} puts them back.
                      </p>
                      <div className="confirm-actions">
                        <button className="danger" onClick={clearCanvas}>Clear it</button>
                        {/* Focused, so a stray Enter cancels rather than clears. */}
                        <button autoFocus onClick={() => setConfirmClear(false)}>cancel</button>
                      </div>
                    </div>
                  )}
                </span>
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
            onReroute={reroute}
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
            onResetRoute={id => reroute(id, null)}
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
