# PromptCanvas

Chat on the left, architecture diagram on the right. Code stays in VS Code on your other screen.

The diagram is not decoration: it is how the agent knows where things live. Every box
owns a set of folders, and the agent reads that mapping before it touches anything.
When it changes the shape of the system it has to update the diagram in the same turn.

## Where things live

| File | Owner | Holds |
|---|---|---|
| `.promptcanvas/graph.json` | the agent | nodes, edges, which folders each node owns |
| node `x`/`y` inside it | you | where the boxes sit |
| `.promptcanvas/graphs/<name>.json` | the agent | extra named diagrams, if you make any |

`graph.json` lives inside the project you are working on, so it diffs in pull requests
alongside the code it describes.

### Diagrams

Each session owns one diagram, and you never choose it. `main` is `graph.json` and stays
the baseline; **+ session** creates the session and branches `main` into
`.promptcanvas/graphs/<name>.json` in the same click, so a new session is a normal entry
in the picker straight away — no typing required first. (Type into a workspace with no
session at all and one is still created for you, named after that first prompt.) From
then on that conversation and that diagram travel together — switching session switches
the canvas, so one conversation can sit on the real architecture while another sketches a
refactor. The bar shows which diagram you are on; it is a label, not a picker.

Two consequences worth knowing. Improvements made in one session stay in that session's
diagram rather than flowing back into `main`. And there is no delete button — remove a
diagram by deleting its file.

## Run it

Needs Node 20.12+ (for `--env-file-if-exists`).

```bash
npm install
cp .env.example .env      # set ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:5180 and drag it to your second monitor. Add the repo you want
to work on with **+ repo** or **Browse…** — workspaces live in
`~/.promptcanvas/workspaces.json`, not in `.env`. (`PROJECT_DIR` is still read once, on
a first run with no workspaces, so an older `.env` setup keeps working.)

### Auth

The Agent SDK needs an **API key** from https://platform.claude.com/, set as
`ANTHROPIC_API_KEY` in `.env`. Two things to know:

- Your Claude subscription does not cover this. Anthropic does not permit claude.ai
  login or subscription rate limits for third-party products built on the Agent SDK,
  so the tool bills per token against the API.
- The SDK does not read `.env` by itself. The `dev:server` script passes
  `--env-file-if-exists=.env` to Node, which is what puts the key in the environment.

Bedrock, Vertex and Foundry are also supported via `CLAUDE_CODE_USE_BEDROCK=1` and
friends, if you would rather bill through a cloud account you already have.

## Starting from an existing project

A new repo opens on a placeholder diagram. Two ways to make it describe the real thing:

1. **Scan repo** in the canvas toolbar reads what the repo already declares - compose
   services, composer/package dependencies, workspace packages - and drafts components
   and edges from that. No API key, no tokens, instant. Preview first, then **Replace**
   or **Merge**. Positions of boxes you already placed are kept.
2. **Then let the agent refine it.** Tick *"Then let the agent check it against the
   code"* in the scan panel and it runs automatically after Replace or Merge, with the
   scan's evidence trail included in the prompt so the agent knows what was guessed and
   why. It calls `get_graph`, sees the draft, and corrects labels, folders and edges from
   the actual code - far cheaper and more accurate than discovering the whole repo cold.
   Untick it to apply the draft alone and spend no tokens.

`server/scan.mjs` holds the heuristics. From compose it reads the image, the build
context, `environment`, `command` and `depends_on` - so a service that declares
`CONSUME_COMMAND: kafka:consume-spbv1` becomes a node owning the file that declares that
command, and `depends_on` becomes edges. A build context with its own manifest (say
`./host_application` with a `requirements.txt`) is a component that owns that folder;
one without is this app's build setup. The rule it follows: **emit a node only where
there is evidence** of a component - a declared dependency, a compose service, a
workspace package. Never one node per directory. A diagram generated from the folder
tree is just the folder tree, which is the thing this is not. Laravel, Node and
compose are covered; add your own stack there.

### Editing the diagram yourself

The canvas is a real editor. You can:

- **draw a box** — becomes a component, where you drew it
- **draw an arrow between two boxes** — becomes a connection
- **double-click either** — renames it
- **drag an arrow's end onto another box** — moves the connection
- **drag or resize a box** — layout is yours and always has been
- **reshape an arrow** — select it and drag a bend, pull a new one out of a segment,
  click a bend and press Delete to remove it, or drag its end to another side of the same
  box. It squares itself up and stays: bends stay where you put them when boxes move, and
  the ends keep their side. **Reset route** in the arrow's panel puts it back on the
  automatic route
- **recolour a box** — Excalidraw's stroke/background pickers now stick. Colour normally
  comes from the component's *kind* (green datastore, purple queue, teal job), so an
  override breaks that box out of the legend; the inspector offers a one-click **reset to
  the kind colour**. The agent can never set a colour — its lever is `kind`
- **+ component** / the inspector — the same things via forms, plus **delete**
- **Clear canvas** — empties this session's diagram after a warning. Ctrl+Z (⌘Z), or the
  **undo clear** button that takes its place, puts everything back until you add anything
  else. Not available on `main`, the committed map

Every one of those goes through the server, exactly like the agent's `patch_graph` — the
canvas never writes `graph.json` directly. The one thing it will not do is delete:
pressing Backspace puts the element straight back, because a slip there costs components
and their connections. Delete from the inspector, which asks first. Both POST to the server exactly like the agent's patch does -
drawing a rectangle on the canvas still does nothing, and deleting one there changes
nothing either.

## How you use it

1. Click a box **or an arrow**. It becomes the scope chip above the prompt box, and
   **everything more than one hop away dims** so you can actually read a busy diagram.
   Clicking a box also opens the inspector, where you set which folders it owns. Click
   empty canvas to clear it.

   Scoping to an arrow is for questions about the wire rather than the box — "make this
   retry", "this should be async", "drop this dependency". The agent is given both ends
   and the code each of them owns.
2. Type what you want changed. The agent gets the graph plus your selected node's paths.
3. It edits code, then calls `patch_graph`. Boxes it touched turn orange, and the canvas
   updates **as the turn runs** rather than at the end of it. While a turn is running the
   canvas is read-only — still visible and pannable, and you can still click boxes to move
   the focus around or clear it. That is just looking: the turn keeps the component it was
   sent with, shown as a chip on your message. Editing — dragging, the Inspector's Save —
   is blocked until the turn ends.
4. Read the diff in VS Code. Hit **mark reviewed** when you are happy and the orange clears.

Under the prompt box you get a spinner with elapsed time while a turn runs (some take
minutes), a **Stop** button to interrupt it, the tokens and cost for the last turn and for
the session, and the model picker.

Reloading during a turn is safe. The turn keeps running on the server; the page notices
and shows the spinner again, then refreshes with whatever you missed once it finishes.

## Keeping the shared map current

Each session works in its own diagram, and those are gitignored — personal working state.
`.promptcanvas/graph.json` is the one that gets committed. Two buttons in the canvas bar
bridge the two: **view main** shows the canonical map read-only without leaving your
session, and **promote to main** copies what you have over it (with a confirm, since that
is the file a pull request reviews).

## Laying it out

Arrows are routed at right angles and steer around boxes; a diagonal tells you nothing
about where a line is going, so there aren't any.

**Arrange with AI** is what moves the boxes. The agent decides which column and row each
box goes in - who sits next to whom, one region per subsystem - and the server turns that
into positions, making every gap wide enough for the labels on the arrows that cross it.
Boxes in a row or column line up exactly, so neighbours get straight arrows. It clears
any hand-drawn arrow routes, since they were drawn for the old layout, and it runs on its
own rather than inside your conversation, so it does not show in the transcript after a
reload. It is the only thing that may move your boxes, and only when you press it.

There was an offline `Tidy layout` button that arranged boxes along the flow of the
arrows. It was removed: measured on real graphs it helped about as often as it hurt
(56% → 54% of arrows crossing a box on one, 68% → **77%** on another), so it was not
worth the space or the confusion.

Drag the divider between the chat and the canvas to trade width between them. The
position is remembered per browser.

## The agent's tools

| Tool | Does |
|---|---|
| `get_graph` | reads the whole map: nodes, kinds, owned folders, edges |
| `get_node` | one node plus its neighbours |
| `patch_graph` | adds/edits/removes nodes and edges, marks them as changed |
| `set_layout` | a grid cell per box, which the server turns into positions spaced for the arrow labels — **only** on an *Arrange with AI* turn. Clears hand-drawn arrow routes |

They live in `server/tools.mjs` as an in-process MCP server. Add a tool there and the
agent can use it on the next message — no restart of anything but the server.

## Things you will want to change first

- **`SYSTEM_RULES` in `server/index.mjs`** — the standing instructions. This is where you
  teach it your conventions.
- **`permissionMode: 'acceptEdits'`** — it edits without asking. Drop to `'default'` and
  wire up a permission prompt if you would rather approve each one.
- **Node kinds** in `server/tools.mjs` and `web/src/graphToScene.js` — currently generic.
  Yours are probably more like `edge-node`, `ota-channel`, `booking-provider`.
- **`systemPrompt`** — the `{ type: 'preset', preset: 'claude_code', append }` shape is
  verified against Agent SDK 0.3.286. If a version bump breaks it, that is the line to check.
- **Model choice** — pick it from the dropdown under the prompt box (Opus / Sonnet /
  Haiku, or the SDK default). It is stored in `~/.promptcanvas/workspaces.json` and the
  resolved model id is shown beside it after each turn. `MODELS` in `server/index.mjs`
  is the list. The aliases resolve inside the Claude Code the SDK bundles, so a newer
  model arrives with an SDK upgrade: 0.3.286 maps "opus" to Opus 5.5.

## Known rough edges in this skeleton

- Many workspaces, one turn at a time. Workspaces live in ~/.promptcanvas/workspaces.json
  (the only state outside the repos it drives); sessions come from the Agent SDK’s own
  store via listSessions/getSessionMessages, so they survive restarts. A single lock
  still allows only one turn running anywhere — switching workspaces mid-turn lets you
  look around but not start a second turn.
- Session lists are per repo and come from the SAME store Claude Code uses, but the
  picker shows only PromptCanvas's own: every turn tags its session `promptcanvas`, and
  both the list and `resume` skip anything untagged, so your terminal sessions for that
  repo stay out of the tool and are never resumed into a turn.
- Excalidraw would fetch its element fonts from esm.sh by default. `web/index.html` sets
  `window.EXCALIDRAW_ASSET_PATH = '/'` and the `excalidraw-fonts` plugin in
  `vite.config.js` serves them from `node_modules` in dev and copies them into the
  build, so nothing leaves the machine. The CDN stays in the font `src` list as a
  last-resort fallback Excalidraw hardcodes; it serves no bytes. Xiaolai (27 MB of
  CJK) is skipped — add it to the plugin if you label nodes in Chinese.
- Bound arrows are given explicit `x`/`y` and `points` in `graphToScene.js`, computed from
  the two boxes they join. The skeleton API does NOT position them from `start`/`end` —
  it reads the arrow's own `x`/`y` to place the endpoints, so omitting them yields NaN.
- Layout saves on a 900 ms debounce after you stop dragging.
- Arrow routing is computed for the whole graph at once, so lines can be kept apart —
  parallel runs sit at least 5px apart, because two lines closer than that read as one.
  Lines crossing each other is fine and unavoidable; overlapping is not. A couple of
  horizontal pairs from *different* boxes can still land 3–4px apart.
- Past roughly 30 nodes no arrangement reads well on its own — that is what focus mode is
  for.
- `Arrange with AI` used to take over three minutes, almost all of it the agent reasoning
  about pixel positions. It now only picks cells; a real run has not been timed yet.
