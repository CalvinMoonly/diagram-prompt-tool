# PromptCanvas

A local tool for driving development by prompt while watching the architecture as a
diagram. Chat on the left, Excalidraw canvas on the right, running in a browser on a
second monitor. Code editing happens in VS Code on the other screen — this tool is
deliberately not an editor.

The diagram is your map of the system, not documentation. Every node owns a set of repo
folders; read that mapping to know where code lives. When you change the shape of the
system, update the diagram in the same turn. Nodes you touch stay highlighted until the
user marks them reviewed — that is their review surface, instead of reading every diff.

## Invariants — do not break these

- **Structure** (nodes, edges, owned folders) is yours, via `patch_graph`.
- **A prompt can be scoped to a node OR an edge.** Selection is `{ kind: 'node' | 'edge',
  id }` end to end. A node's block carries its owned folders; an edge's carries both ends
  and their folders, because the connection itself has no code but the things it joins
  do. `spoken()` strips any `<selected-…>` block on replay, so the transcript shows what
  was typed.
- **Appearance is the user's: position, size and colour.** `applyPatch` strips
  `x/y/w/h/stroke/fill` off every incoming patch. The agent's lever on how a box looks is
  `kind`, which *means* something; a node's `stroke`/`fill` are optional overrides and
  absent means "follow the kind", so changing kind still recolours an untouched box.
  `colourFor()` is the one place that resolves it: touched wins, then the override, then
  the kind.
- **Layout** (x/y/w/h) is the user's, by dragging. This is enforced, not just asked for:
  `applyPatch` in `server/graph.mjs` strips x/y/w/h off every incoming patch. The one
  exception is deliberate and contained: the **Arrange with AI** button runs a turn with
  a fourth tool, `set_layout`, which writes positions and nothing else. It exists only on
  that turn - `createCanvasServer(dir, diagram, { layout: true })` - so an ordinary turn
  still cannot move a box.
- **The canvas is a real editor, but it still never writes `graph.json` itself.** Drawing
  a box or an arrow, renaming either in place, and dragging an arrow's end onto another
  box all work - `handleChange` spots the change and calls the same server routes the
  agent's patch goes through. The user is meant to be able to do anything here.
- **Deleting on the canvas is the exception: it is refused.** `handleChange` notices when
  the scene holds fewer elements than the graph and puts them straight back; deleting is
  done from the inspector, which confirms first. Count **both** nodes and edges - checking
  nodes alone lets a deleted arrow through - and measure edges against those whose
  endpoints both exist, since those are the only ones ever drawn.
- **A colour we drew is not a colour the user chose.** Excalidraw's style panel now
  writes a real per-node override, but `handleChange` must compare the element against
  *what was last drawn* as well as against the graph. Otherwise resetting a colour is
  immediately undone: the change event still carries the old element, which differs from
  the freshly-cleared graph and reads as "they just picked that". `drawn` in `Canvas.jsx`
  is that record. Colour also belongs in the re-seed key, or a reset never redraws.
- **"No bound label" is not "an empty label".** Reading a label off the canvas must
  distinguish a text element that says nothing from no text element at all: an element
  whose label has not been rendered yet otherwise reads as the user clearing it, and the
  real value gets wiped. This cost a live edge label before it was caught.
- **Never generate nodes from the folder tree.** A node needs *evidence* — a declared
  dependency, a compose service, a workspace package. A diagram built from directories is
  just the directory tree, which is the thing this tool exists not to be.
- `.promptcanvas/graph.json` is the canonical map — the one a pull request reviews. It
  stays human-readable and small enough to read in a diff: fixed key order, defaults
  omitted, `touched` written only when true.
- **One diagram per session.** `+ session` allocates the session id and creates its
  `.promptcanvas/graphs/<name>.json` up front, branched from `main`; a session that
  instead gets born on a turn (no `+ session` first) has its diagram named after the
  opening prompt. Either way that session owns it for life. There is no diagram picker:
  switching session is the only thing that switches the canvas. `main` (`graph.json`)
  is the baseline every new diagram branches from, and what you see before a session
  has one. You only ever read and write the active session's diagram.
- Not a code editor. No file tree, no Monaco, no diff viewer — VS Code does that.
- If you find yourself blurring those lines, stop and say so.

## Where things live

```
server/index.mjs       Express + Agent SDK, SSE stream, all routes
server/workspaces.mjs  ~/.promptcanvas/workspaces.json — the repo list, the only
                       state outside the projects it drives. Atomic writes + .bak.
server/graph.mjs       per-workspace, per-diagram read/write, applyPatch, free-slot
                       auto-placement, PR-friendly serialisation. Diagram names are
                       validated here: they become file names.
server/tools.mjs       in-process MCP server: get_graph, get_node, patch_graph, and
                       set_layout on an Arrange turn only. Built per turn, taking a
                       function for the diagram name and an onWrite callback.
server/scan.mjs        evidence-based repo scanner (no LLM, no network). Reads
                       compose image/build context/environment/command/depends_on,
                       and resolves declared commands to the file that runs them.
server/pickFolder.mjs  native OS folder dialog, spawned server-side
web/src/App.jsx        state, loading, layout/structure wiring, the drag-to-resize
                       divider, and the view-main / promote-to-main pair
web/src/main.jsx       entry point
web/src/Nav.jsx        workspace and session dropdowns
web/src/styles.css     every style; one shared rule covers all three pickers
web/src/Chat.jsx       prompt box, scope chip, hand-rolled SSE reader, working
                       spinner with elapsed time, Stop, per-turn and per-session
                       usage, and the model picker
web/src/markdown.jsx   small markdown renderer for agent replies. Builds React
                       elements, never innerHTML. No dependency.
web/src/Canvas.jsx     Excalidraw, re-seeds on structure change, debounced layout
                       save, view-mode while a turn is running
web/src/graphToScene.js graph.json -> Excalidraw elements. routeAll() routes every
                       arrow orthogonally, fans out edges sharing a box face and
                       keeps parallel runs apart; plus focus dimming and the
                       crossingCount metric the arrange prompt quotes
web/src/Inspector.jsx  edit a node's label, kind, owned folders, notes; delete it
                       (two-step, and the server drops its edges with it). Also
                       exports EdgePanel: what a selected connection joins, and
                       a two-step delete for it.
web/src/ScanPanel.jsx  scan preview with Replace / Merge, and the option to hand
                       the applied draft straight to the agent to check
```

## Gotchas already paid for — don't rediscover these

- **Arrows must carry explicit `x`/`y` and `points`.** `convertToExcalidrawElements` does
  NOT position bound arrows from `start`/`end`; it reads the arrow's own `x`/`y` to place
  the endpoints, so omitting them yields NaN geometry. `graphToScene.js` computes them.
- **The canvas re-seed key must include workspace AND diagram identity.** It deliberately omits
  positions so a re-seed can't stomp a live drag — but two repos with the same shape then
  produce an identical key, the canvas keeps showing the previous repo's boxes, and the
  debounced save writes them into the new repo's graph.json. Fixed by keying `<Canvas>`
  on `workspace:diagram`; the graph and both names must land in the **same render**,
  which is why `loadActive()` fetches everything in one `Promise.all`. Diagrams branch
  from each other so their node ids usually match, which makes a stray save land
  silently — `<Canvas>` also clears its debounce timer on unmount for the same reason.
- **Moving a box leaves its arrows looking diagonal, and the stored geometry is fine.**
  Excalidraw keeps the `points` we supplied but re-renders a bound arrow's endpoints
  from where the box now is, so the leg between the box edge and our path renders as a
  diagonal. Measuring the scene shows zero diagonal segments while the screen clearly
  shows one - the discrepancy is the giveaway. `rerouteArrows()` rebuilds the paths from
  the live element positions (not from `graph`, which has not caught up with the drag
  yet) on a 220 ms beat, separate from the 900 ms save beat: re-routing is cosmetic and
  wants to be quick, saving wants to happen once.
- **Arrow midpoints survive binding; `elbowed` does not do anything.** Setting
  `elbowed: true` on an arrow skeleton is kept on the element, but
  `convertToExcalidrawElements` never computes the orthogonal route, so it still renders
  as a 2-point diagonal - the routing only happens inside Excalidraw's own editor.
  Intermediate `points` you supply DO survive binding (bindings stay intact), which is
  why `routeEdge` computes the path itself.
- **Layout-only changes do not re-seed the canvas.** The re-seed key deliberately omits
  positions so a re-seed cannot stomp a live drag - which also means a change that moves
  only positions redraws nothing unless it asks. `<Canvas>` takes a `layoutNonce` for
  exactly that, bumped when a turn comes back with boxes in new places.
- **`GAP` must be larger than `MARGIN`, or routing silently collapses.** The stub out
  of a box face is `GAP` long and obstacles are inflated by `MARGIN`; with GAP below
  MARGIN every stub point lands inside a neighbouring box's margin, so every route
  alongside a column is rejected before it starts. Raising GAP from 6 to 20 took arrows
  crossing a box from 65% to 12% on bab-lc - nothing else changed.
- **Routes are computed as a set, never one at a time.** `routeAll` fans out edges that
  share a box face and records the corridors it has used, so parallel lines stay at
  least 5px apart - two lines closer than that read as one and you cannot tell which way
  either is going. Crossing lines are fine and unavoidable; overlapping ones are not.
  Every route is orthogonal: when nothing is clear it picks the least-bad right-angled
  option rather than falling back to a diagonal, which gives no clue where it goes.
- **The canvas follows a turn live.** `createCanvasServer` takes an `onWrite` callback;
  every `patch_graph`/`set_layout` write is sent down the SSE stream as a `graph` event.
  The canvas is put in `viewModeEnabled` while `busy`, so it stays visible and pannable
  but a drag cannot race the agent's writes.
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
- **`tagSession` cannot tag a session at `init`.** The transcript file does not exist on
  disk yet when the SDK hands over the session id, and the call fails with "not found in
  project directory". Tag at the `result` message instead — and on the error path too, or
  a turn that dies partway leaves an untagged session the picker will never show.
- **Hiding a session from the picker is only half the job.** The stored `activeSessionId`
  is what `resume` gets, so an untagged id left in `workspaces.json` would pull that
  history into the next turn invisibly. Filter the list and gate `resume` on the same
  check.
- **Panes need `min-height: 0` or the page scrolls instead of the pane.** Grid and flex
  items default to `min-height: auto` and refuse to shrink below their content, so
  `overflow-y: auto` on `.messages` never engages and a long transcript makes the whole
  document tall. `.chat`, `main`, `.messages` and `.canvas` all carry it.
- **`options.sessionId` cannot name a session that already exists.** The SDK rejects it
  with "Session ID is already in use" and the turn dies instantly. This bites when a
  pending session's first turn creates the transcript but never tags it - a crash, or
  `node --watch` reloading mid-turn - because `pendingSession` is then never cleared and
  every later turn re-sends the same id. The session is wedged for good. The chat route
  now checks `getSessionInfo(pendingId)` first and, if the transcript exists, adopts it
  (tag, clear pending) and resumes instead.
- **An interrupted turn can end without a `result` message.** The client unlocks on
  `done`, so the chat route tracks whether one was sent and emits `{ subtype: 'stopped' }`
  from its `finally` if not. Without it, Stop leaves the prompt box locked until reload.
- **A turn outlives its client.** Reloading drops the SSE stream but not the turn, which
  keeps running and holding the lock. `GET /api/status` reports it, and the app polls on
  mount so a reload shows the spinner and refreshes the transcript when the turn lands.
  The elapsed counter restarts from the reload, not from when the turn began.
- **Renaming a pending session cannot go through the SDK.** `renameSession` writes a
  custom-title entry into the transcript, so before the first turn it fails with "not
  found in project directory" - the same root cause as `tagSession` at `init`. The PATCH
  route holds the name in `pendingSession` instead, and the first turn applies it with
  `renameSession` once the transcript exists.
- **A session exists before the SDK knows about it.** `+ session` mints a UUID and
  passes it to the next turn as `options.sessionId`, so the picker can list the session
  immediately. Until that turn, there is no transcript on disk — which means
  `listSessions` cannot see it (the picker merges it in from `pendingSession` in
  `workspaces.json`), `getSessionMessages` and `deleteSession` have nothing to work on,
  and `ourSession()` returns null for it. That last one matters: the chat route's "drop
  anything that is not ours" guard must exempt the pending id, or the first turn clears
  the pointer and resets the diagram to `main` underneath itself.
- **The canvas tool server resolves its diagram per call, not at construction.** A new
  session's diagram cannot exist when `query()` is called — the session id only arrives
  at `init`, mid-turn — so `createCanvasServer` takes a function, not a name. Pass it a
  name and the first turn of every new session writes to the previous diagram.
- **ScanPanel renders inside `.inspector`, so the inspector's own rules reach it.**
  `.inspector label` stacks its fields in a column and out-specifies a bare `.scan-refine`,
  which silently put the checkbox above its text. Scope panel rules under `.inspector`.
- **A declared command can be a prefix of another.** `kafka:consume-spbv1` is a prefix
  of `kafka:consume-spbv1-bd-events`, so a substring search hands the wrong file to the
  wrong worker. `findCommandFile` matches the whole signature token.
- **`scrollIntoView({ behavior: 'smooth' })` silently does nothing** in the messages
  container - the plain call works. Chat follows the tail by setting `scrollTop`, and
  only while already at the bottom, so reading back mid-turn is not interrupted.
- **The model is chosen by alias, and reported back resolved.** `~/.promptcanvas/workspaces.json`
  holds one `model` for the whole tool (`opus`/`sonnet`/`haiku`, or empty for the SDK
  default) and it goes into `query` options. What the UI shows is `message.model` from
  the `init` message - the id the SDK actually resolved to - so the label is never the
  source of truth.
- **`modelUsage` is the field for token accounting, not `usage`.** The SDK says so in
  its own docs: `usage` is the main loop only, while `modelUsage` covers subagents and
  internal calls, and carries `costUSD` per model. `total_cost_usd` is the running total
  for the query. All estimates, not a bill.
- **An agent asked to re-arrange a diagram hands back the layout it was given.** The
  first `Arrange with AI` run returned positions identical to the existing ones for all
  34 boxes - while describing placement it had not done, so the prose is no evidence. It
  cannot see the canvas, so the prompt has to say the current layout is the problem,
  quantify it (`crossingCount`), and tell it explicitly to ignore the current x/y.
- **Sessions are keyed by project directory**, so moving a repo orphans its history.
- **Editing `.env` does not restart the server.** `node --watch` only watches imported
  modules, so restart `npm run dev` by hand after touching it.

- **Measure any layout change with the segment/rect test before believing it.** On
  bab-lc, arrows crossing a box they do not terminate at:
    - arrival-order grid: 68%.
    - flow-based layering (the old `Tidy layout`): 56% -> 54% on one graph, 68% -> **77%**
      on another. Removed - it made things worse about as often as better.
    - 3x the spacing: 25% -> 14%, with the diagonal fallbacks unmoved (23 -> 22). Which
      box sits next to which matters; how far apart they are does not.
    - orthogonal routing, once `GAP > MARGIN` was fixed: **12%, no diagonals**.
    - **Arrange with AI**, on Opus: **0%**. The agent placed all 36 boxes so that no arrow
      crosses any box, at the cost of a 2080x5220 canvas. Best result by a distance, and
      the only turn whose own account of its work matched the measurements.
  Focus mode is the other half: past ~30 nodes, dimming everything more than one hop from
  the selection is what makes a dense graph readable at all.
- **A turn's prose is not evidence of what it did.** An arrange turn once reported "all 34
  boxes repositioned", describing placement reasoning in detail, having handed back
  positions identical to the existing ones for all 34. Check the graph, not the summary.
- **Focus must survive a turn, and three separate things took it away.** Entering view
  mode makes Excalidraw drop its own selection, and `handleChange` read that as the user
  deselecting - so `handleChange` ignores everything while `locked`. A re-seed replaces
  every element and loses the selection too, so `updateScene` restores
  `selectedElementIds` in the same call. And view mode blocks Excalidraw's selection
  entirely, so focus during a turn is ours: `pickWhileLocked` hit-tests the click against
  node rects via `viewportCoordsToSceneCoords`.
- **Changing focus mid-turn cannot affect the turn.** The scope is captured into the
  request body when the prompt is sent, and the sent message keeps its own chip in the
  transcript, so what the run is using stays visible after you look elsewhere.
- **`locked` means read-only everywhere, not just the canvas.** The Inspector's Save is
  disabled by the same flag - otherwise you can edit a node's paths while the agent is
  writing the same graph, or write the session's graph while main is on screen.
- **Focus must NOT be in the canvas re-seed key**, even though dimming lives in element
  opacity. Putting it there cost two bugs at once: clicking a box re-seeded the whole
  scene just as the drag began, so the label visibly lagged its box, and the 1200 ms
  settle window that a re-seed opens swallowed the drag so the new position was never
  saved. `applyFocus()` recolours the scene that is already on screen instead - no
  geometry touched, nothing snaps back, no settle window. The full re-seed stays for
  shape changes only, and bakes focus in as it builds.

## Current state

All verified end to end against a real repo (bab-lc: 33 compose services, Laravel plus a
Python codebase).

**Workspaces and sessions.** Workspaces are a dropdown (add by path or native
**Browse…**, switch, remove). `+ session` mints the session id up front and hands it to
the next turn as `options.sessionId`, so a new session is a normal entry in the picker
before you type. The picker lists only PromptCanvas's own sessions - every turn tags its
session `promptcanvas`, and both the list and `resume` ignore anything untagged, so your
terminal Claude Code history never leaks in. `ourSession()` is the gate.

**Diagrams** are one per session and automatic: `+ session` branches `main` into the
session's own `.promptcanvas/graphs/<name>.json`, and activating that session brings it
back. Nothing in the UI picks one; the bar shows which diagram the session owns.

**The canvas is a full editor.** Draw a box or an arrow, rename either in place, drag an
arrow's end onto another box, recolour a box, drag and resize - every one of those goes
through the same server routes the agent's patch uses, so `graph.json` has one writer.
Deleting is the deliberate exception: the canvas puts it straight back, and deletion is
done from the inspector, which confirms first. Also:
- *Orthogonal routing* - every arrow is right-angled, edges sharing a box face are fanned
  out, and parallel runs are kept apart. No diagonals.
- *Focus* - selecting a box dims everything more than one hop away.
- *Live updates* - `patch_graph`/`set_layout` writes stream to the canvas mid-turn, and
  the canvas goes read-only (`viewModeEnabled`) while a turn runs.
- *Arrange with AI* - a turn with `set_layout`, the only thing that moves boxes.

**Scanning.** `Scan repo` reads compose image/build-context/environment/command/
depends_on and resolves declared commands to the file that runs them; the panel offers to
hand the applied draft straight to the agent to check against the code.

**Chat.** Markdown rendering, a working spinner with elapsed time, per-turn and
per-session token usage and cost, a model picker (alias in, resolved id shown back), and
a **Stop** button that interrupts the running turn. A reload mid-turn is safe: the turn
keeps going server-side and the pane picks it back up.

**Panes.** The chat/canvas divider (`.splitter`) drags to resize, remembered in `localStorage`. The
drag listeners go on the window and are bound in the `pointerdown` handler itself, not in
an effect - `setDragging` is async and an effect binds a frame too late for a quick drag.
Both pointer and mouse events are bound, deduped by a ref, since some environments
deliver only one family.

**The canonical map.** Session diagrams are gitignored working state; `.promptcanvas/
graph.json` is what gets committed. **view main** is a read-only look at it without
leaving your session, and **promote to main** copies the active diagram over it - the
only route from session work back to the map other developers get.

## Next

1. **Make `set_layout` cheaper to call.** Emitting 34 JSON position objects took a turn
   about eight minutes of pure generation. A compact form (`id:x,y; id:x,y`) or coarse
   cluster coordinates the server expands would cut that a lot.
2. **Make an empty scan explain itself** - see the gaps below.
3. **Adding a connection has no form.** Drawing one on the canvas works, and so does the
   agent, but there is no equivalent of `+ component` for an edge.

## Known gaps

- **A scan of this repo finds nothing, and does not say why.** The React branch in
  `scan.mjs` only fires when `src`/`app`/`pages`/`components` sits at the repo root; ours
  is `web/src`, so `realPaths` comes back empty and the branch emits neither a node nor a
  `detected` line — you get `{nodes:[],edges:[],detected:[]}` with no explanation.
  PromptCanvas cannot scan itself. An empty scan should still report what it looked at.
- **`patch_graph`'s array arguments are not really optional.** They are declared
  `z.array(...).default([])`, and the JSON Schema says `"default": []`, but validation
  rejects a call that omits them - two separate agents hit this and had to resend with
  explicit empty arrays, wasting a call each time. `.optional().default([])` in the Zod
  shape is the likely fix.
- **The 5px line-separation rule is not fully met.** Within a box the fan-out guarantees
  it, but two horizontal stubs from *different* boxes whose anchors happen to land near
  the same y can still come out 3-4px apart - two pairs out of ~190 segments on bab-lc.
  Fixing it properly means a nudge pass over the finished routes.
- **The elapsed counter restarts after a reload**, because it measures from when the page
  noticed the turn, not from when the turn began.
- Enter-to-submit on the inline nav/toolbar forms is unconfirmed, but narrowed: the markup
  is right, the submit button is enabled with state synced, and nothing calls
  `preventDefault` on Enter in that input. It needs a real keypress to confirm.
