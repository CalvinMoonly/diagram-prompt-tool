import React, { useEffect, useState } from 'react'

// What the repo says about itself, before anything is written. Nothing here
// touches graph.json until you pick Replace or Merge.
export default function ScanPanel ({ onApply, onClose, onPreview }) {
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    onPreview().then(setDraft).catch(err => setError(err.message))
  }, [])

  const apply = async replace => {
    setBusy(true)
    try {
      await onApply(replace)
      onClose()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <aside className="inspector scan">
      <header>
        <strong>Scan of this repo</strong>
        <button onClick={onClose} title="Close">x</button>
      </header>

      {error && <p className="msg error">{error}</p>}
      {!draft && !error && <p className="hint">Reading manifests...</p>}

      {draft && (
        <>
          <p className="hint">
            Read from what the repo declares - compose services, dependencies,
            workspace packages. Folders are never turned into components.
          </p>

          {draft.nodes.length === 0 ? (
            <p className="hint">
              Nothing recognisable found. Add components by hand, or ask the agent
              to map the repo.
            </p>
          ) : (
            <ul className="scan-list">
              {draft.nodes.map(n => (
                <li key={n.id}>
                  <span className={`dot ${n.kind}`} />
                  <b>{n.label}</b>
                  <span className="muted">{n.paths.join(', ') || n.notes || n.kind}</span>
                </li>
              ))}
            </ul>
          )}

          <details>
            <summary className="hint">Evidence ({draft.detected.length})</summary>
            <pre className="scan-evidence">{draft.detected.join('\n')}</pre>
          </details>

          {draft.nodes.length > 0 && (
            <div className="scan-actions">
              <button className="primary" disabled={busy} onClick={() => apply(true)}>
                Replace diagram
              </button>
              <button disabled={busy} onClick={() => apply(false)}>Merge in</button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}
