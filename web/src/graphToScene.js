import { convertToExcalidrawElements } from '@excalidraw/excalidraw'

const KIND_COLOURS = {
  service: { stroke: '#1971c2', fill: '#d0ebff' },
  datastore: { stroke: '#2f9e44', fill: '#d3f9d8' },
  queue: { stroke: '#9c36b5', fill: '#f3d9fa' },
  device: { stroke: '#e8590c', fill: '#ffe8cc' },
  external: { stroke: '#868e96', fill: '#f1f3f5' },
  job: { stroke: '#0c8599', fill: '#c5f6fa' },
  ui: { stroke: '#5f3dc4', fill: '#e5dbff' }
}
const TOUCHED = { stroke: '#f08c00', fill: '#fff3bf' }

// Leave a little air between the box edge and the arrowhead.
const GAP = 6

// Where a line from this node's centre towards (tx, ty) crosses the node's border.
function borderPoint (node, tx, ty) {
  const cx = node.x + node.w / 2
  const cy = node.y + node.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (dx === 0 && dy === 0) return [cx, cy]
  // Scale the direction vector until it hits the nearer of the two edge pairs.
  const scaleX = dx === 0 ? Infinity : (node.w / 2) / Math.abs(dx)
  const scaleY = dy === 0 ? Infinity : (node.h / 2) / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  const len = Math.hypot(dx, dy)
  const gap = Math.min(GAP, len / 4)
  return [cx + dx * (scale + gap / len), cy + dy * (scale + gap / len)]
}

// graph.json -> Excalidraw elements.
// Ids are ours (regenerateIds: false) so arrows bind by node id, and every
// element carries customData so a click on the canvas resolves back to a node.
export function graphToElements (graph) {
  const skeleton = []
  const byId = new Map(graph.nodes.map(n => [n.id, n]))

  for (const node of graph.nodes) {
    const colour = node.touched ? TOUCHED : (KIND_COLOURS[node.kind] ?? KIND_COLOURS.external)
    skeleton.push({
      type: 'rectangle',
      id: `node:${node.id}`,
      x: node.x,
      y: node.y,
      width: node.w,
      height: node.h,
      strokeColor: colour.stroke,
      backgroundColor: colour.fill,
      fillStyle: 'solid',
      strokeWidth: node.touched ? 4 : 2,
      roundness: { type: 3 },
      label: { text: node.label, fontSize: 20, strokeColor: '#1e1e1e' },
      customData: { nodeId: node.id, kind: node.kind }
    })
  }

  for (const edge of graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue

    // An arrow skeleton MUST carry x/y. convertToExcalidrawElements reads them to
    // place the endpoints (startX = start.x || linearElement.x - width), so leaving
    // them off yields NaN geometry, not an auto-layout. The binding below still
    // owns the arrow once it exists - this is only the seed position.
    const [x1, y1] = borderPoint(from, to.x + to.w / 2, to.y + to.h / 2)
    const [x2, y2] = borderPoint(to, from.x + from.w / 2, from.y + from.h / 2)

    skeleton.push({
      type: 'arrow',
      id: `edge:${edge.id}`,
      x: x1,
      y: y1,
      points: [[0, 0], [x2 - x1, y2 - y1]],
      start: { id: `node:${edge.from}` },
      end: { id: `node:${edge.to}` },
      strokeColor: '#495057',
      ...(edge.label ? { label: { text: edge.label, fontSize: 14 } } : {}),
      customData: { edgeId: edge.id }
    })
  }

  return convertToExcalidrawElements(skeleton, { regenerateIds: false })
}

// Canvas -> graph: we only read back layout, never structure.
export function layoutFromElements (elements) {
  const positions = {}
  for (const el of elements) {
    const id = el.customData?.nodeId
    if (!id || el.isDeleted) continue
    if (![el.x, el.y, el.width, el.height].every(Number.isFinite)) continue
    positions[id] = { x: Math.round(el.x), y: Math.round(el.y), w: Math.round(el.width), h: Math.round(el.height) }
  }
  return positions
}
