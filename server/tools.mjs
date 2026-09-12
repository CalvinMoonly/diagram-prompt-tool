import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { readGraph, writeGraph, applyPatch, KINDS } from './graph.mjs'

// The canvas is the agent's map of the system. It reads meaning from here,
// never from pixels: every node carries the folders it owns.
//
// The tools are built per turn with the active workspace's directory closed
// over, so the agent can only ever read and patch the graph of the project it
// was actually launched against.

const nodeShape = z.object({
  id: z.string().describe('Stable slug, e.g. "ota-api". Reuse the existing id when updating.'),
  label: z.string().optional().describe('Human name shown on the canvas'),
  kind: z.enum(KINDS).optional().describe('What sort of component this is'),
  paths: z.array(z.string()).optional().describe('Repo-relative folders this node owns'),
  notes: z.string().optional().describe('One or two lines of context')
})

const edgeShape = z.object({
  id: z.string().optional(),
  from: z.string().describe('Source node id'),
  to: z.string().describe('Target node id'),
  label: z.string().optional().describe('What flows across, e.g. "publishes build manifest"')
})

function summarise (graph) {
  const nodes = graph.nodes
    .map(n => `  ${n.id} "${n.label}" [${n.kind}] <- ${n.paths.join(', ') || 'no paths'}`)
    .join('\n')
  const edges = graph.edges
    .map(e => `  ${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}`)
    .join('\n')
  return `nodes:\n${nodes || '  (none)'}\nedges:\n${edges || '  (none)'}`
}

function buildTools (dir, activeDiagram, { layout = false, onWrite } = {}) {
  // A function, not a name: for a new session the diagram does not exist yet when
  // this server is built, so every call resolves it fresh.
  const diagram = () => (typeof activeDiagram === 'function' ? activeDiagram() : activeDiagram)
  const getGraph = tool(
    'get_graph',
    'Read the architecture graph: every node (component) with the repo paths it owns, and every edge between them. Call this before reasoning about where code lives.',
    {},
    async () => {
      const graph = await readGraph(dir, diagram())
      return {
        content: [{ type: 'text', text: summarise(graph) }],
        structuredContent: graph
      }
    },
    { annotations: { readOnlyHint: true } }
  )

  const getNode = tool(
    'get_node',
    'Read one node of the architecture graph by id, including the repo paths it owns and its neighbours.',
    { id: z.string().describe('Node id, e.g. "api"') },
    async (args) => {
      const graph = await readGraph(dir, diagram())
      const node = graph.nodes.find(n => n.id === args.id)
      if (!node) {
        return {
          content: [{ type: 'text', text: `No node "${args.id}". Known ids: ${graph.nodes.map(n => n.id).join(', ')}` }],
          isError: true
        }
      }
      const neighbours = graph.edges
        .filter(e => e.from === args.id || e.to === args.id)
        .map(e => `${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}`)
      return {
        content: [{
          type: 'text',
          text: [
            `${node.label} [${node.kind}] id=${node.id}`,
            `paths: ${node.paths.join(', ') || '(none yet)'}`,
            node.notes ? `notes: ${node.notes}` : null,
            neighbours.length ? `edges:\n  ${neighbours.join('\n  ')}` : null
          ].filter(Boolean).join('\n')
        }],
        structuredContent: node
      }
    },
    { annotations: { readOnlyHint: true } }
  )

  const patchGraph = tool(
    'patch_graph',
    'Update the architecture graph after you change the shape of the system: add or edit nodes and edges, remove ones that no longer exist. Call this in the SAME turn as the code change, never as a separate follow-up. Do not set positions; the canvas owns layout.',
    {
      upsertNodes: z.array(nodeShape).default([]),
      removeNodeIds: z.array(z.string()).default([]),
      upsertEdges: z.array(edgeShape).default([]),
      removeEdgeIds: z.array(z.string()).default([]),
      why: z.string().default('').describe('One sentence: what changed in the system and why the diagram moved with it')
    },
    async (args) => {
      const current = await readGraph(dir, diagram())
      const { graph, touched } = applyPatch(current, args)
      const saved = await writeGraph(dir, diagram(), graph)
      onWrite?.(saved)
      return {
        content: [{
          type: 'text',
          text: `Graph updated${args.why ? `: ${args.why}` : ''}. Marked as changed: ${touched.join(', ') || '(none)'}.\n\n${summarise(saved)}`
        }],
        structuredContent: { touched, graph: saved }
      }
    }
  )

  // Positions only, and only handed to the agent on a turn the user started from
  // "Arrange with AI". Every other turn gets the three tools above, so layout stays
  // the user's exactly as before.
  const setLayout = tool(
    'set_layout',
    'Move boxes on the canvas. Positions only: this cannot add, remove, rename or re-link anything. Coordinates are the top-left corner of a box in canvas units, x rightwards and y downwards. Boxes are 220 wide and 90 tall unless the graph says otherwise.',
    {
      positions: z.array(z.object({
        id: z.string().describe('Node id'),
        x: z.number(),
        y: z.number()
      })).describe('Where each box should sit. Nodes you leave out keep their current position.'),
      why: z.string().default('').describe('One sentence: how you arranged it')
    },
    async (args) => {
      const graph = await readGraph(dir, diagram())
      const moved = new Map(args.positions.map(p => [p.id, p]))
      const unknown = args.positions.filter(p => !graph.nodes.some(n => n.id === p.id)).map(p => p.id)
      const nodes = graph.nodes.map(n => (
        moved.has(n.id)
          ? { ...n, x: Math.round(moved.get(n.id).x), y: Math.round(moved.get(n.id).y) }
          : n
      ))
      const saved = await writeGraph(dir, diagram(), { ...graph, nodes })
      onWrite?.(saved)
      return {
        content: [{
          type: 'text',
          text: `Moved ${args.positions.length - unknown.length} of ${saved.nodes.length} boxes${args.why ? `: ${args.why}` : ''}.` +
            (unknown.length ? ` Unknown ids ignored: ${unknown.join(', ')}.` : '')
        }],
        structuredContent: { graph: saved }
      }
    }
  )

  return layout ? [getGraph, getNode, patchGraph, setLayout] : [getGraph, getNode, patchGraph]
}

// Built per turn with the workspace dir AND the diagram it is working on closed
// over, so the agent can only touch the one the user is looking at.
export function createCanvasServer (dir, activeDiagram, opts) {
  return createSdkMcpServer({
    name: 'canvas', version: '0.1.0', tools: buildTools(dir, activeDiagram, opts)
  })
}

// The wildcard is the allow rule the SDK wants; the exact names are for the
// permission callback. Both derive from the same tool list, so a tool added in
// buildTools needs no further wiring to become usable on the next message.
export const CANVAS_TOOLS = ['mcp__canvas__*']
const CANVAS_TOOL_NAMES = new Set(buildTools('.', null, { layout: true }).map(t => `mcp__canvas__${t.name}`))
export const isCanvasTool = name => CANVAS_TOOL_NAMES.has(name)
