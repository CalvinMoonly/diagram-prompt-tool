import React, { useEffect, useRef, useState } from 'react'
import { Excalidraw, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import { graphToElements, applyFocus, rerouteArrows, layoutFromElements, colourFor } from './graphToScene.js'

export default function Canvas ({
  graph, selection, onSelect, onLayout,
  onAddEdge, onRelabel, onRelink, onRecolour, onAddComponent,
  layoutNonce, locked
}) {
  const [api, setApi] = useState(null)
  const timer = useRef(null)
  const routeTimer = useRef(null)
  // Pairs already sent to the server, so the several onChange events a single
  // drawn arrow produces do not each POST the same edge.
  const submitted = useRef(new Set())
  // The colours we last drew, per node. A colour that differs from the graph but
  // matches what we drew is not the user's choice - it is an element we have not
  // re-seeded yet. Without this, resetting a colour is undone by the next change
  // event, which still carries the old element and reads as "they picked that".
  const drawn = useRef(new Map())
  // Structure version: only re-seed the scene when nodes/edges change, so the
  // agent's patches land without stomping on a drag the user is mid-way through.
  // Focus is deliberately NOT in here. Re-seeding replaces every element, which
  // mid-drag snaps the box back and desyncs its label - and the settle window it
  // opens swallows the drag so it never gets saved. Focus is applied in place
  // below instead. Positions stay out too, as before.
  const structure = JSON.stringify(
    graph
      ? {
          n: graph.nodes.map(n => [n.id, n.label, n.kind, n.touched, n.stroke, n.fill]),
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
    // Re-seeding drops Excalidraw's selection, and the echoed onChange then reads
    // as "user deselected", losing the focus. Put the selection back in the same
    // call.
    drawn.current = new Map(graph.nodes.map(n => [n.id, colourFor(n)]))
    api.updateScene({
      elements: graphToElements(graph, selection),
      appState: {
        selectedElementIds: selection
          ? { [`${selection.kind}:${selection.id}`]: true }
          : {}
      }
    })
  }, [api, structure, layoutNonce])

  // Focus on its own only changes opacity, so recolour the scene that is already
  // there. No geometry is touched, nothing snaps back, and no settle window is
  // opened for a drag to fall into.
  useEffect(() => {
    if (!api || !graph) return
    api.updateScene({ elements: applyFocus(api.getSceneElements(), graph, selection) })
  }, [api, selection?.kind, selection?.id])

  // Without this a debounced save outlives the unmount: switch workspace or
  // diagram inside the 900 ms and the old scene's positions land on the new
  // one. Diagrams branch from each other, so the node ids usually match and the
  // write goes through silently.
  useEffect(() => () => {
    clearTimeout(timer.current)
    clearTimeout(routeTimer.current)
  }, [])

  const handleChange = (elements, appState) => {
    if (Date.now() < seedingUntil.current) return
    // Switching into view mode makes Excalidraw drop its own selection, which
    // would read here as "the user deselected" and lose the focus mid-turn. While
    // locked, focus is ours (pickWhileLocked) and nothing can be edited anyway,
    // so there is nothing in here worth listening to.
    if (locked) return
    // The canvas is a view, not the source of truth: deleting here changes nothing
    // in graph.json. Put it straight back rather than letting a Cmd+A/Backspace
    // look like it worked until the next reload.
    // Everything the user can change on the canvas is picked up here and sent to
    // the server. The canvas still never writes graph.json itself.
    if (graph && !locked) {
      const nodeOf = id => (typeof id === 'string' && id.startsWith('node:') ? id.slice(5) : null)
      // Returns null when there is no bound label at all, which is NOT the same as
      // an empty one: an element whose label has not been rendered yet would
      // otherwise read as "the user cleared it" and wipe the real value.
      const textIn = containerId => {
        const el = elements.find(e => e.type === 'text' && e.containerId === containerId && !e.isDeleted)
        return el ? (el.originalText ?? el.text ?? '').trim() : null
      }
      const once = (key, run) => {
        if (submitted.current.has(key)) return
        submitted.current.add(key)
        run()
      }

      for (const el of elements) {
        if (el.isDeleted) continue

        // Drawn from scratch: an arrow bound at both ends is a new connection, a
        // rectangle is a new component. Ours carry customData; these do not.
        if (el.type === 'arrow' && !el.customData?.edgeId) {
          const from = nodeOf(el.startBinding?.elementId)
          const to = nodeOf(el.endBinding?.elementId)
          if (from && to && from !== to) once(`add:${from}->${to}`, () => onAddEdge?.(from, to))
          continue
        }
        if (el.type === 'rectangle' && !el.customData?.nodeId) {
          const label = textIn(el.id) || 'New component'
          once(`new:${el.id}`, () => onAddComponent?.({
            label, x: el.x, y: el.y, w: el.width, h: el.height
          }))
          continue
        }

        // Renamed or recoloured in place.
        const nodeId = el.customData?.nodeId
        if (nodeId && el.type === 'rectangle') {
          const node = graph.nodes.find(n => n.id === nodeId)
          if (!node) continue
          const text = textIn(el.id)
          if (text && text !== node.label) {
            once(`label:${nodeId}:${text}`, () => onRelabel?.({ kind: 'node', id: nodeId, label: text }))
          }
          // Only when it differs from what we drew. Persisting on every change
          // would pin every box to its kind's colour, and changing kind would
          // then stop recolouring anything.
          const shown = colourFor(node)
          const last = drawn.current.get(nodeId)
          const differsFromGraph = el.strokeColor !== shown.stroke || el.backgroundColor !== shown.fill
          const differsFromDrawn = !last || el.strokeColor !== last.stroke || el.backgroundColor !== last.fill
          if (differsFromGraph && differsFromDrawn) {
            once(`colour:${nodeId}:${el.strokeColor}:${el.backgroundColor}`, () => onRecolour?.(
              nodeId, el.strokeColor, el.backgroundColor
            ))
          }
          continue
        }

        const edgeId = el.customData?.edgeId
        if (edgeId && el.type === 'arrow') {
          const edge = graph.edges.find(e => e.id === edgeId)
          if (!edge) continue
          const text = textIn(el.id)
          if (text !== null && text !== (edge.label ?? '')) {
            once(`label:${edgeId}:${text}`, () => onRelabel?.({ kind: 'edge', id: edgeId, label: text }))
          }
          // Dragged onto a different box: the connection moved, not the arrow.
          const from = nodeOf(el.startBinding?.elementId)
          const to = nodeOf(el.endBinding?.elementId)
          if (from && to && from !== to && (from !== edge.from || to !== edge.to)) {
            once(`relink:${edgeId}:${from}->${to}`, () => onRelink?.(edgeId, from, to))
          }
        }
      }
    }

    const nodesOnScreen = elements.filter(e => !e.isDeleted && e.customData?.nodeId).length
    const edgesOnScreen = elements.filter(e => !e.isDeleted && e.customData?.edgeId).length
    // Edges whose endpoints are both present are the only ones ever drawn, so they
    // are what the count has to be measured against.
    const ids = new Set(graph?.nodes.map(n => n.id) ?? [])
    const edgesExpected = (graph?.edges ?? []).filter(e => ids.has(e.from) && ids.has(e.to)).length
    if (graph && (nodesOnScreen < graph.nodes.length || edgesOnScreen < edgesExpected)) {
      submitted.current.clear()
      seedingUntil.current = Date.now() + 600
      api.updateScene({ elements: graphToElements(graph, selection) })
      return
    }

    const selected = Object.keys(appState.selectedElementIds ?? {})
    if (selected.length === 1) {
      const el = elements.find(e => e.id === selected[0])
      // An arrow is a legitimate thing to scope a prompt to, so resolve both.
      const next = el?.customData?.nodeId
        ? { kind: 'node', id: el.customData.nodeId }
        : el?.customData?.edgeId
          ? { kind: 'edge', id: el.customData.edgeId }
          : null
      if (next?.id !== selection?.id || next?.kind !== selection?.kind) onSelect(next)
    } else if (selected.length === 0 && selection) {
      onSelect(null)
    }

    // Two beats. Re-routing is cosmetic and wants to be quick: Excalidraw re-renders
    // a bound arrow's endpoints from the moved box while keeping our points, so the
    // leg between box edge and path shows as a diagonal until the path is rebuilt.
    // Saving stays on the slower beat so a drag is written once, not per frame.
    clearTimeout(routeTimer.current)
    routeTimer.current = setTimeout(() => {
      const { elements: routed, changed } = rerouteArrows(api.getSceneElements(), graph)
      if (!changed) return
      // Short guard: this updateScene echoes back through onChange, and without it
      // the echo schedules another save and another re-route.
      seedingUntil.current = Date.now() + 300
      api.updateScene({ elements: routed })
    }, 220)

    clearTimeout(timer.current)
    timer.current = setTimeout(() => onLayout(layoutFromElements(elements)), 900)
  }

  // View mode blocks Excalidraw's own selection, but focus is not an edit: you
  // should still be able to look at a different component while a turn runs. The
  // turn is unaffected either way - its scope was fixed when the prompt was sent.
  const pickWhileLocked = e => {
    if (!locked || !api || !graph) return
    const box = e.currentTarget.getBoundingClientRect()
    const { scrollX, scrollY, zoom } = api.getAppState()
    const { x, y } = viewportCoordsToSceneCoords(
      { clientX: e.clientX, clientY: e.clientY },
      { zoom, scrollX, scrollY, offsetLeft: box.left, offsetTop: box.top }
    )
    const node = [...graph.nodes].reverse()
      .find(n => x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h)
    if (node) return onSelect({ kind: 'node', id: node.id })

    // Nothing under the point as a box - try the arrows, which are polylines, so
    // measure distance to each segment rather than a bounding box.
    const near = (px, py, ax, ay, bx, by) => {
      const dx = bx - ax
      const dy = by - ay
      const len = dx * dx + dy * dy
      const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }
    for (const el of api.getSceneElements()) {
      const id = el.customData?.edgeId
      if (!id || !el.points) continue
      for (let i = 0; i < el.points.length - 1; i++) {
        const a = [el.x + el.points[i][0], el.y + el.points[i][1]]
        const b = [el.x + el.points[i + 1][0], el.y + el.points[i + 1][1]]
        if (near(x, y, a[0], a[1], b[0], b[1]) < 8) return onSelect({ kind: 'edge', id })
      }
    }
    onSelect(null)
  }

  return (
    <div className="canvas" onPointerDownCapture={pickWhileLocked}>
      <Excalidraw
        // Visible and pannable during a turn, but not editable: the agent is
        // writing to the same graph, and a drag saved mid-write would race it.
        viewModeEnabled={!!locked}
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
