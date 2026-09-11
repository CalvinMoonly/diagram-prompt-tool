import React, { useEffect, useRef, useState } from 'react'
import { Excalidraw } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { graphToElements, layoutFromElements } from './graphToScene.js'

export default function Canvas ({ graph, selectedId, onSelect, onLayout }) {
  const [api, setApi] = useState(null)
  const timer = useRef(null)
  // Structure version: only re-seed the scene when nodes/edges change, so the
  // agent's patches land without stomping on a drag the user is mid-way through.
  const structure = JSON.stringify(
    graph
      ? {
          n: graph.nodes.map(n => [n.id, n.label, n.kind, n.touched]),
          e: graph.edges.map(e => [e.id, e.from, e.to, e.label])
        }
      : null
  )

  // updateScene echoes back through onChange, and a snapshot taken while
  // Excalidraw is still settling arrow bindings has the bound boxes in the wrong
  // place. Persisting that would let a re-seed silently rewrite the user's
  // layout, so ignore changes until the scene has settled.
  const seedingUntil = useRef(0)

  useEffect(() => {
    if (!api || !graph) return
    seedingUntil.current = Date.now() + 1200
    api.updateScene({ elements: graphToElements(graph) })
  }, [api, structure])

  const handleChange = (elements, appState) => {
    const selected = Object.keys(appState.selectedElementIds ?? {})
    if (selected.length === 1) {
      const el = elements.find(e => e.id === selected[0])
      const nodeId = el?.customData?.nodeId ?? null
      if (nodeId !== selectedId) onSelect(nodeId)
    } else if (selected.length === 0 && selectedId) {
      onSelect(null)
    }

    if (Date.now() < seedingUntil.current) return

    clearTimeout(timer.current)
    timer.current = setTimeout(() => onLayout(layoutFromElements(elements)), 900)
  }

  return (
    <div className="canvas">
      <Excalidraw
        excalidrawAPI={setApi}
        onChange={handleChange}
        // Seeded, not controlled: Excalidraw owns the theme from here, so its own
        // menu can still toggle it. Dark inverts the canvas, so a white background
        // is what renders as near-black and matches the chat pane.
        initialData={{ appState: { theme: 'dark', viewBackgroundColor: '#ffffff' } }}
      />
    </div>
  )
}
