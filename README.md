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

`graph.json` lives inside the project you are working on, so it diffs in pull requests
alongside the code it describes.

## Run it

Needs Node 20.12+ (for `--env-file-if-exists`).

```bash
npm install
cp .env.example .env      # set ANTHROPIC_API_KEY and PROJECT_DIR
npm run dev
```

Open http://localhost:5180 and drag it to your second monitor.

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
2. **Then prompt the agent to refine it.** It calls `get_graph`, sees the draft, and
   corrects labels, folders and edges from the actual code - which is far cheaper and
   more accurate than discovering the whole repo cold.

`server/scan.mjs` holds the heuristics. The rule it follows: **emit a node only where
there is evidence** of a component - a declared dependency, a compose service, a
workspace package. Never one node per directory. A diagram generated from the folder
tree is just the folder tree, which is the thing this is not. Laravel, Node and
compose are covered; add your own stack there.

**+ component** adds a node by hand. It POSTs to the server exactly like the agent's
patch does - drawing a rectangle on the canvas still does nothing.

## How you use it

1. Click a box. It becomes the scope chip above the prompt box, and the inspector opens
   so you can set which folders that box owns.
2. Type what you want changed. The agent gets the graph plus your selected node's paths.
3. It edits code, then calls `patch_graph`. Boxes it touched turn orange.
4. Read the diff in VS Code. Hit **mark reviewed** when you are happy and the orange clears.

## The agent's three tools

| Tool | Does |
|---|---|
| `get_graph` | reads the whole map: nodes, kinds, owned folders, edges |
| `get_node` | one node plus its neighbours |
| `patch_graph` | adds/edits/removes nodes and edges, marks them as changed |

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
  verified against Agent SDK 0.3.269. If a version bump breaks it, that is the line to check.
- **Model choice** — not set anywhere yet, so it uses the SDK default. Add `model:` to the
  options in `server/index.mjs` when you care about cost per turn.

## Known rough edges in this skeleton

- Many workspaces, one turn at a time. Workspaces live in ~/.promptcanvas/workspaces.json
  (the only state outside the repos it drives); sessions come from the Agent SDK’s own
  store via listSessions/getSessionMessages, so they survive restarts. A single lock
  still allows only one turn running anywhere — switching workspaces mid-turn lets you
  look around but not start a second turn.
- Session lists are per repo and come from the SAME store Claude Code uses, so your
  own terminal sessions for that repo appear in the picker too. tagSession() is the
  hook if you ever want to separate them.
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
