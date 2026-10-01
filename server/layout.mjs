// Arrange with AI: the agent decides which column and row each box sits in - the
// part that takes judgement - and this turns that into pixels. Every gap is sized to
// the labels on the arrows that will run through it. That is what the agent's own
// pixel layouts got wrong: on bab-lc it packed boxes 120px apart and 17 of 47 arrow
// labels landed on a box, where the user's hand layout had none. Placing pixels was
// also where the time went: 19.7k tokens of reasoning for ~800 tokens of positions.

const ORIGIN = 80
// Gaps with nothing written in them. The user's own layout never went below 192px
// between columns or 108px between rows.
const MIN_COL_GAP = 180
const MIN_ROW_GAP = 110
// A column or row the agent leaves empty is an aisle between regions, this wide.
const AISLE = 120
// Arrow labels are 14px Nunito, ~7.2px a character, and Excalidraw wraps one near
// 154px when the arrow is short. AIR is the stub out of each box plus the arrowhead,
// so a label sits in clear space rather than against a box.
const CHAR_W = 7.2
const LINE_H = 18
const WRAP_W = 154
const AIR = 70

export function labelSize (text) {
  const chars = String(text ?? '').length
  if (!chars) return { w: 0, h: 0 }
  const lines = Math.ceil((chars * CHAR_W) / WRAP_W)
  return { w: Math.min(WRAP_W, chars * CHAR_W), h: lines * LINE_H }
}

// The gap a label lands in: an arrow's label sits at the middle of its route, so
// between neighbours it is the gap between them, and for a longer arrow the middle
// one of the gaps it crosses.
const middleGap = (a, b) => Math.floor((Math.min(a, b) + Math.max(a, b) - 1) / 2)

// cells: [{ id, col, row }]. Returns { error } and writes nothing if any box is
// missing or two share a cell, so a bad call is refused whole rather than half-laid.
export function placeCells (graph, cells) {
  const known = new Set(graph.nodes.map(n => n.id))
  const at = new Map()
  const unknown = []
  for (const c of cells) {
    if (!known.has(c.id)) unknown.push(c.id)
    else if (!at.has(c.id)) at.set(c.id, { col: c.col, row: c.row })
  }
  const missing = graph.nodes.filter(n => !at.has(n.id)).map(n => n.id)
  if (missing.length) return { error: `Every box needs a cell. Missing: ${missing.join(', ')}. Nothing was moved.` }
  const taken = new Map()
  const clashes = []
  for (const [id, { col, row }] of at) {
    const key = `${col},${row}`
    if (taken.has(key)) clashes.push(`(${key}) ${taken.get(key)} and ${id}`)
    else taken.set(key, id)
  }
  if (clashes.length) return { error: `One box per cell. Shared: ${clashes.join('; ')}. Nothing was moved.` }

  // Leading empty columns or rows would only push everything away from the origin.
  const minCol = Math.min(...[...at.values()].map(c => c.col))
  const minRow = Math.min(...[...at.values()].map(c => c.row))
  for (const c of at.values()) { c.col -= minCol; c.row -= minRow }
  const cols = Math.max(...[...at.values()].map(c => c.col)) + 1
  const rows = Math.max(...[...at.values()].map(c => c.row)) + 1

  const width = Array(cols).fill(0)
  const height = Array(rows).fill(0)
  for (const n of graph.nodes) {
    const { col, row } = at.get(n.id)
    width[col] = Math.max(width[col], n.w)
    height[row] = Math.max(height[row], n.h)
  }
  for (let c = 0; c < cols; c++) if (!width[c]) width[c] = AISLE
  for (let r = 0; r < rows; r++) if (!height[r]) height[r] = AISLE

  const colGap = Array(Math.max(0, cols - 1)).fill(MIN_COL_GAP)
  const rowGap = Array(Math.max(0, rows - 1)).fill(MIN_ROW_GAP)
  for (const e of graph.edges) {
    const a = at.get(e.from)
    const b = at.get(e.to)
    if (!a || !b) continue
    const label = labelSize(e.label)
    // Across columns the label has to fit side to side; across rows, top to bottom.
    if (a.col !== b.col) {
      const g = middleGap(a.col, b.col)
      colGap[g] = Math.max(colGap[g], label.w + AIR)
    }
    if (a.row !== b.row) {
      const g = middleGap(a.row, b.row)
      rowGap[g] = Math.max(rowGap[g], label.h + AIR)
    }
  }

  const colX = [ORIGIN]
  for (let c = 1; c < cols; c++) colX[c] = colX[c - 1] + width[c - 1] + colGap[c - 1]
  const rowY = [ORIGIN]
  for (let r = 1; r < rows; r++) rowY[r] = rowY[r - 1] + height[r - 1] + rowGap[r - 1]

  // Centred in the cell, so boxes sharing a row or column line up exactly and the
  // arrow between them is one straight run - a box nudged by a pixel gets a jog.
  const positions = new Map()
  for (const n of graph.nodes) {
    const { col, row } = at.get(n.id)
    positions.set(n.id, {
      x: Math.round(colX[col] + (width[col] - n.w) / 2),
      y: Math.round(rowY[row] + (height[row] - n.h) / 2)
    })
  }
  return { positions, cols, rows, colGap, rowGap, unknown }
}
