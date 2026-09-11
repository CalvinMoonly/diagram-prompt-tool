import React, { useEffect, useState } from 'react'

// Node metadata is the whole trick: the agent reads these fields, not the drawing.
export default function Inspector ({ node, onSave, onClose }) {
  const [draft, setDraft] = useState(node)
  useEffect(() => setDraft(node), [node?.id])
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

      <button className="primary" onClick={() => onSave(draft)}>Save</button>
    </aside>
  )
}
