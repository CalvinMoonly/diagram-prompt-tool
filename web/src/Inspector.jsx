import React, { useEffect, useState } from 'react'

// Node metadata is the whole trick: the agent reads these fields, not the drawing.
export default function Inspector ({ node, onSave, onDelete, onResetColour, onClose, locked }) {
  const [draft, setDraft] = useState(node)
  // Two steps, because this removes the component and its connections from the
  // file a pull request reviews.
  const [confirming, setConfirming] = useState(false)
  useEffect(() => setDraft(node), [node?.id])
  useEffect(() => setConfirming(false), [node?.id])
  if (!draft) return null

  const set = (key, value) => setDraft(d => ({ ...d, [key]: value }))

  return (
    <aside className="inspector">
      <header>
        <strong>{draft.label}</strong>
        <button onClick={onClose} title="Close">x</button>
      </header>

      <label>Name
        <input value={draft.label} onChange={e => set('label', e.target.value)} />
      </label>

      <label>Kind
        <select value={draft.kind} onChange={e => set('kind', e.target.value)}>
          {['service', 'datastore', 'queue', 'device', 'external', 'job', 'ui'].map(k => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>

      <label>Owns these folders
        <textarea
          rows={3}
          placeholder={'apps/api\npackages/shared'}
          value={draft.paths.join('\n')}
          onChange={e => set('paths', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
        />
      </label>

      <label>Notes
        <textarea rows={3} value={draft.notes} onChange={e => set('notes', e.target.value)} />
      </label>

      {(node.stroke || node.fill) && (
        <p className="hint">
          This box has a colour of its own, so it no longer follows its kind.{' '}
          <button className="link" onClick={() => onResetColour(node.id)}>reset to the kind colour</button>
        </p>
      )}

      <div className="inspector-actions">
        <button className="primary" disabled={!!locked} onClick={() => onSave(draft)}>Save</button>
        {confirming ? (
          <>
            <button className="danger" onClick={() => onDelete(draft.id)}>Delete it</button>
            <button onClick={() => setConfirming(false)}>cancel</button>
          </>
        ) : (
          <button disabled={!!locked} onClick={() => setConfirming(true)}>delete</button>
        )}
      </div>
    </aside>
  )
}

// A connection has nothing to edit - no label route, no folders of its own - so its
// panel exists for one reason: to say what it joins and let you remove it. Same
// shell as the node inspector, which is also where it gets its z-index from.
export function EdgePanel ({ edge, fromLabel, toLabel, onRelabel, onDelete, onClose, locked }) {
  const [confirming, setConfirming] = useState(false)
  const [label, setLabel] = useState(edge?.label ?? '')
  useEffect(() => setConfirming(false), [edge?.id])
  useEffect(() => setLabel(edge?.label ?? ''), [edge?.id])
  if (!edge) return null

  return (
    <aside className="inspector">
      <header>
        <strong>{fromLabel} → {toLabel}</strong>
        <button onClick={onClose} title="Close">x</button>
      </header>

      <label>Label
        <input
          value={label}
          placeholder="publishes to"
          onChange={e => setLabel(e.target.value)}
        />
      </label>

      <p className="hint">
        Removing a connection leaves both components in place. Ask the agent if you want
        the code changed to match.
      </p>

      <div className="inspector-actions">
        <button
          className="primary"
          disabled={!!locked}
          onClick={() => onRelabel({ kind: 'edge', id: edge.id, label })}
        >Save</button>
        {confirming ? (
          <>
            <button className="danger" onClick={() => onDelete(edge.id)}>Delete it</button>
            <button onClick={() => setConfirming(false)}>cancel</button>
          </>
        ) : (
          <button disabled={!!locked} onClick={() => setConfirming(true)}>delete</button>
        )}
      </div>
    </aside>
  )
}
