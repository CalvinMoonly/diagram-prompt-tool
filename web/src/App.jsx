import React, { useCallback, useEffect, useState } from 'react'
import Canvas from './Canvas.jsx'
import Chat from './Chat.jsx'
import Inspector from './Inspector.jsx'
import Nav from './Nav.jsx'
import ScanPanel from './ScanPanel.jsx'

const json = async (url, options) => {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `${res.status}`)
  return body
}

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
  const [selectedId, setSelectedId] = useState(null)
  const [meta, setMeta] = useState({})
  const [messages, setMessages] = useState([])
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [newComponent, setNewComponent] = useState(null)

  const push = useCallback(entry => setMessages(m => [...m, entry]), [])

  // Everything below the nav belongs to the active workspace, so it reloads as
  // one unit. The graph and the workspace id must land in the SAME render: the
  // canvas is keyed on the workspace, and remounting it while `graph` still
  // holds the previous repo's nodes would seed the wrong layout - which then
  // gets saved over the graph of the repo you just switched to.
  const loadActive = useCallback(async () => {
    const [c, g, s] = await Promise.all([
      json('/api/workspaces'),
      json('/api/graph').catch(err => ({ error: err.message })),
      json('/api/sessions').catch(() => ({ sessions: [], activeSessionId: null }))
    ])

    setWorkspaces(c.workspaces)
    setActiveId(c.activeId)
    setSelectedId(null)
    if (g.error) {
      setGraph(null)
      setMeta({ blocked: c.workspaces.length ? g.error : null })
    } else {
      setGraph(g.graph)
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

  const pickSession = async sessionId => {
    if (!sessionId) return
    await post(`/api/sessions/${sessionId}/activate`)
    setActiveSessionId(sessionId)
    const t = await json(`/api/sessions/${sessionId}/messages`)
    setMessages(t.messages)
  }

  const newSession = async () => {
    await post('/api/sessions/new')
    setActiveSessionId(null)
    setMessages([])
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
    setSessions(await json('/api/sessions').then(s => s.sessions).catch(() => sessions))
  }

  const previewScan = () => json('/api/scan')

  const applyScan = async replace => {
    const res = await post('/api/scan', { replace })
    setGraph(res.graph)
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
    setSelectedId(res.id)
  }

  const save = async next => {
    setGraph(next)
    await fetch('/api/graph', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    })
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

  const selected = graph?.nodes.find(n => n.id === selectedId) ?? null
  const touched = graph?.nodes.filter(n => n.touched) ?? []

  return (
    <div className="app">
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
        scope={selected}
        messages={messages}
        onPush={push}
        busy={busy}
        onBusy={setBusy}
        disabled={!activeId}
        onClearScope={() => setSelectedId(null)}
        onGraphChanged={setGraph}
        onSessionStarted={onSessionStarted}
      />

      <main>
        <header className="bar">
          <span className="dir" title={meta.graphPath}>{meta.projectDir ?? ''}</span>
          {graph && (
            <span className="bar-tools">
              <button onClick={() => setScanning(true)}>Scan repo</button>
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
            key={activeId}
            graph={graph}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onLayout={saveLayout}
          />
        ) : (
          <div className="blank">
            {workspaces.length === 0
              ? 'Add a repo above to get started.'
              : (meta.blocked ?? 'Loading...')}
          </div>
        )}

        {selected && (
          <Inspector node={selected} onSave={saveNode} onClose={() => setSelectedId(null)} />
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
