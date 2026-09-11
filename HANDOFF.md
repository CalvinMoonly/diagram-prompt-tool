# Continue PromptCanvas

Paste everything below into Claude Code from the project root.

---

I'm building **PromptCanvas**: a local tool where I drive development by prompt and
watch the architecture as a diagram. Chat on the left, diagram canvas on the right,
running in a browser window on my second monitor. My code editing stays in VS Code on
the other screen — this tool is deliberately not an editor.

## The idea

The diagram is the agent's map of the system, not documentation. Every node owns a set
of repo folders. The agent reads that mapping to know where code lives, and when it
changes the shape of the system it must update the diagram in the same turn. Nodes it
touched are highlighted until I mark them reviewed — that's my monitoring surface,
instead of reading every diff.

## Invariants — do not break these

- **Structure** (nodes, edges, owned folders) belongs to the agent, via `patch_graph`.
- **Layout** (x/y/w/h) belongs to me, by dragging. This is enforced, not just asked for:
  `applyPatch` in `server/graph.mjs` strips x/y/w/h off every incoming patch.
- **The canvas never creates structure.** Drawing a rectangle in Excalidraw does nothing.
  The `+ component` button POSTs to the server, same as the agent's patch.
- `.promptcanvas/graph.json` stays human-readable and small enough to review in a PR
  diff: fixed key order, defaults omitted, `touched` written only when true.
- Not a code editor. No file tree, no Monaco, no diff viewer — VS Code does that.
- If you find yourself blurring those lines, stop and tell me.

## Where things live

```
server/index.mjs       Express + Agent SDK, SSE stream, all routes
server/workspaces.mjs  ~/.promptcanvas/workspaces.json — the repo list, the only
                       state outside the projects it drives. Atomic writes + .bak.
server/graph.mjs       per-workspace read/write of graph.json, applyPatch,
                       free-slot auto-placement, PR-friendly serialisation
server/tools.mjs       in-process MCP server: get_graph, get_node, patch_graph.
                       Built per turn with the workspace dir closed over.
server/scan.mjs        evidence-based repo scanner (no LLM, no network)
server/pickFolder.mjs  native OS folder dialog, spawned server-side
web/src/App.jsx        state, loading, layout/structure wiring
web/src/Nav.jsx        workspace tabs + session picker
web/src/Chat.jsx       prompt box, scope chip, hand-rolled SSE reader
web/src/Canvas.jsx     Excalidraw, re-seeds on structure change, debounced layout save
web/src/graphToScene.js graph.json -> Excalidraw elements
web/src/Inspector.jsx  edit a node's label, kind, owned folders, notes
web/src/ScanPanel.jsx  scan preview with Replace / Merge
```

## What works, and is verified

- Workspaces: add by path or **Browse…** (native OS dialog), switch, remove.
- Sessions: per workspace, from the Agent SDK's own store (`listSessions`,
  `getSessionMessages`, rename, delete). Transcript replays when you switch.
- Canvas: bound arrows, kind colours, dark theme, drag-to-save layout, mark reviewed.
- **Scan repo**: reads compose services, composer/package manifests and workspace
  packages into a draft diagram. No API key, no tokens, nothing leaves the machine.
- `+ component` adds a node by hand; the Inspector edits label/kind/paths/notes.
- The full agent loop (prompt → `patch_graph` → new box appears highlighted → mark
  reviewed) was proven end to end, but **before** the workspace/session rewrite.

## Start here

1. **Fix the workspace config.** I just moved this repo. `~/.promptcanvas/workspaces.json`
   stores absolute paths, so its entry for this project now points at the old location
   and will show as "workspace folder is gone". Either re-add it with **Browse…** or
   rewrite the path in that file.
2. **Put a working `ANTHROPIC_API_KEY` in `.env`, then restart `npm run dev` yourself** —
   `node --watch` only watches imported modules, so editing `.env` does NOT restart it.
3. **Prove a turn still works.** No agent turn has run since workspaces and sessions were
   added; the chat path is the one thing not re-verified. Select a node, send a prompt
   that adds a component, confirm `patch_graph` fires and the box appears highlighted.

## Known gaps

- `POST/DELETE /api/edges` exist but have no UI, so a hand-added component lands
  unconnected. An edge editor in the Inspector is the obvious next thing.
- Selecting a box also opens Excalidraw's own style panel (Stroke/Background/Fill).
  It's misleading — colour comes from `kind`, so anything changed there is wiped on the
  next re-seed. Worth hiding.
- Enter-to-submit on the inline nav/toolbar forms is unconfirmed (the markup is correct
  for implicit submission; it just was never verified with a real keypress).
- Session lists come from the same store Claude Code uses, so my own terminal sessions
  for a repo show up in the picker. `tagSession()` is the hook if that should change.

## Gotchas already paid for — don't rediscover these

- **Arrows must carry explicit `x`/`y` and `points`.** `convertToExcalidrawElements` does
  NOT position bound arrows from `start`/`end`; it reads the arrow's own `x`/`y` to place
  the endpoints, so omitting them yields NaN geometry. `graphToScene.js` computes them.
- **The canvas re-seed key must include workspace identity.** It deliberately omits
  positions so a re-seed can't stomp a live drag — but two repos with the same shape then
  produce an identical key, the canvas keeps showing the previous repo's boxes, and the
  debounced save writes them into the new repo's graph.json. Fixed by keying `<Canvas>`
  on the workspace id; the graph and the workspace id must land in the **same render**,
  which is why `loadActive()` fetches everything in one `Promise.all`.
- **The Inspector needs `z-index`** above Excalidraw's canvas layers (1–5) or it renders
  invisible and unclickable underneath them.
- **`allowedTools` is auto-approve, not a restriction** (use `tools` to restrict). With no
  `canUseTool`, a tool outside the list has nothing to ask and the stream just stalls
  silently — hence the explicit deny-with-a-message callback.
- **`systemPrompt: { type: 'preset', preset: 'claude_code', append }` is correct** as of
  SDK 0.3.269. Verified, don't "fix" it.
- **Excalidraw fetches element fonts from esm.sh by default.** `web/index.html` sets
  `EXCALIDRAW_ASSET_PATH` and a plugin in `vite.config.js` serves them locally. The CDN
  URL is hardcoded as a last-resort `src` fallback and cannot be removed; it serves no
  bytes once the local one succeeds.
- **Never generate nodes from the folder tree.** A node needs *evidence* — a declared
  dependency, a compose service, a workspace package. A diagram built from directories is
  just the directory tree, which is the thing this tool exists not to be.
- **Sessions are keyed by project directory**, so moving a repo orphans its history.
