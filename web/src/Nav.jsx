import React, { useState } from 'react'

function ago (ms) {
  if (!ms) return ''
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// Navigation only: which repo, which conversation. Deliberately not a file tree -
// the code lives in VS Code on the other screen.
export default function Nav ({
  workspaces, activeId, sessions, activeSessionId, busy,
  onPickWorkspace, onAddWorkspace, onRemoveWorkspace, onBrowse,
  onPickSession, onNewSession, onRenameSession, onDeleteSession
}) {
  const [adding, setAdding] = useState(false)
  const [dir, setDir] = useState('')
  const [error, setError] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [title, setTitle] = useState('')

  const active = workspaces.find(w => w.id === activeId) ?? null
  const current = sessions.find(s => s.sessionId === activeSessionId) ?? null

  const [browsing, setBrowsing] = useState(false)

  const submitAdd = async e => {
    e.preventDefault()
    setError('')
    try {
      await onAddWorkspace(dir)
      setDir('')
      setAdding(false)
    } catch (err) {
      setError(err.message)
    }
  }

  // The dialog opens on the machine running the server, not in the page.
  const browse = async () => {
    setError('')
    setBrowsing(true)
    try {
      const picked = await onBrowse()
      if (picked?.busy) return
      if (picked?.supported === false) {
        setError(`${picked.reason} - type the path instead`)
        return
      }
      if (picked?.dir) {
        await onAddWorkspace(picked.dir)
        setDir('')
        setAdding(false)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setBrowsing(false)
    }
  }

  const submitRename = async e => {
    e.preventDefault()
    if (title.trim()) await onRenameSession(activeSessionId, title.trim())
    setRenaming(false)
  }

  return (
    <nav className="nav">
      <div className="nav-group">
        <span className="nav-label">Workspace</span>
        {workspaces.map(w => (
          <span key={w.id} className={`tab ${w.id === activeId ? 'on' : ''}`}>
            <button className="tab-name" onClick={() => onPickWorkspace(w.id)} title={w.dir}>
              {w.name}
            </button>
            <button
              className="tab-x"
              title={`Remove ${w.name} from this bar (nothing on disk is deleted)`}
              onClick={() => onRemoveWorkspace(w.id)}
            >×</button>
          </span>
        ))}

        {adding ? (
          <form className="add" onSubmit={submitAdd}>
            <button type="button" className="primary" disabled={browsing} onClick={browse}>
              {browsing ? 'Pick a folder...' : 'Browse...'}
            </button>
            <input
              value={dir}
              placeholder="or type a path"
              onChange={e => setDir(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') { setAdding(false); setError('') } }}
            />
            <button type="submit" disabled={!dir.trim()}>Add</button>
          </form>
        ) : (
          <button onClick={() => setAdding(true)}>+ repo</button>
        )}
        {error && <span className="nav-error">{error}</span>}
      </div>

      <div className="nav-group right">
        {active && (
          <>
            <span className="nav-label">Session</span>
            {renaming ? (
              <form className="add" onSubmit={submitRename}>
                <input
                  autoFocus
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') setRenaming(false) }}
                />
                <button className="primary" type="submit">Save</button>
              </form>
            ) : (
              <>
                <select
                  value={activeSessionId ?? ''}
                  disabled={busy}
                  onChange={e => onPickSession(e.target.value || null)}
                >
                  <option value="">{activeSessionId ? 'Switch to...' : 'New session (unsaved)'}</option>
                  {sessions.map(s => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.title} - {ago(s.lastModified)}
                    </option>
                  ))}
                </select>
                {current && (
                  <>
                    <button
                      title="Rename this session"
                      onClick={() => { setTitle(current.title); setRenaming(true) }}
                    >rename</button>
                    <button
                      title="Delete this session and its transcript"
                      onClick={() => onDeleteSession(current.sessionId)}
                    >delete</button>
                  </>
                )}
                <button className="primary" disabled={busy} onClick={onNewSession}>+ session</button>
              </>
            )}
          </>
        )}
      </div>
    </nav>
  )
}
