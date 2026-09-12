import fs from 'node:fs/promises'
import path from 'node:path'

// A first draft of the architecture, read from what the repo already declares:
// compose services, dependency manifests, workspace definitions.
//
// The rule this file follows: emit a node only where there is EVIDENCE of a
// component - a declared dependency, a compose service, a workspace package.
// Never one node per directory. A diagram generated from the folder tree is
// just the folder tree, which is the thing PromptCanvas deliberately is not.

const readJson = async p => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return null }
}
const readText = async p => {
  try { return await fs.readFile(p, 'utf8') } catch { return null }
}
const isDir = async p => {
  try { return (await fs.stat(p)).isDirectory() } catch { return false }
}

// Keep only paths that actually exist, so the agent never gets a bad map.
async function realPaths (dir, candidates) {
  const out = []
  for (const c of candidates) if (await isDir(path.join(dir, c))) out.push(c)
  return out
}

/* ---- docker compose ---- */

// Enough YAML to read a services block. Avoids a dependency for one shape.
export function composeServices (text) {
  const out = []
  let inServices = false
  let indent = null
  let current = null
  let section = null      // 'environment' | 'depends_on', while inside that block
  let sectionPad = null
  let itemPad = null

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue

    // List form: `- kafka` under depends_on, `- KEY=value` under environment.
    const item = raw.match(/^(\s*)-\s+(.+)$/)
    if (item && current && section) {
      const body = item[2].replace(/['"]/g, '').trim()
      if (section === 'depends_on') current.dependsOn.push(body)
      else {
        const eq = body.indexOf('=')
        if (eq > 0) current.env[body.slice(0, eq).trim()] = body.slice(eq + 1).trim()
      }
      continue
    }

    const m = raw.match(/^(\s*)([^\s:#][^:]*):\s*(.*)$/)
    if (!m) continue
    const [, pad, rawKey, value] = m
    const key = rawKey.trim()
    const clean = value.replace(/['"]/g, '').trim()

    if (pad.length === 0) {
      inServices = key === 'services'
      indent = null
      current = null
      section = null
      continue
    }
    if (!inServices) continue
    if (indent === null) indent = pad.length

    if (pad.length === indent) {
      current = { name: key, image: null, build: false, context: null, command: '', env: {}, dependsOn: [] }
      out.push(current)
      section = null
      continue
    }
    if (!current) continue

    // Any key back at or above the block's own indent ends the block.
    if (section && pad.length <= sectionPad) section = null

    if (section === 'environment') { current.env[key] = clean; continue }
    if (section === 'depends_on') {
      // Map form nests `condition:` under each name; only the names are deps.
      if (itemPad === null) itemPad = pad.length
      if (pad.length === itemPad) current.dependsOn.push(key)
      continue
    }

    if (key === 'image') current.image = clean
    if (key === 'command') current.command = clean
    if (key === 'build') {
      current.build = true
      // `build: ./path` is the short form; the long form puts it in `context:`.
      if (clean) current.context = clean
    }
    if (key === 'context') current.context = clean
    if (key === 'environment' || key === 'depends_on') {
      section = key
      sectionPad = pad.length
      itemPad = null
    }
  }
  return out
}

// What makes a build context a component rather than build infrastructure: its own
// dependency manifest. `./docker/8.4` holds a Dockerfile and nothing else, so it is
// this app being built; `./host_application` has requirements.txt, so it is a
// codebase of its own. Evidence, not folder names.
const MANIFESTS = [
  'package.json', 'composer.json', 'requirements.txt', 'pyproject.toml',
  'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'setup.py'
]
const isOwnCodebase = async d => {
  for (const m of MANIFESTS) {
    try { await fs.access(path.join(d, m)); return true } catch {}
  }
  return false
}

// A service that declares `command: ... python -u main_reorder.py` has told us
// which file it runs. Only accepted when that file really exists in the context.
async function scriptFromCommand (dir, context, command) {
  for (const m of String(command).matchAll(/([\w./-]+\.(?:py|js|mjs|ts|rb|go|php|sh))/g)) {
    const rel = path.join(context.replace(/^\.\//, ''), path.basename(m[1]))
    try { await fs.access(path.join(dir, rel)); return rel } catch {}
  }
  return null
}

// Compose says what each same-image service is for; this maps that to a kind.
const ROLE_KINDS = { consumer: 'job', queue: 'job', scheduler: 'job', reverb: 'service', vite: 'ui', horizon: 'job' }

// A worker declares the artisan command it runs. Locating the file that declares
// that command lets the node own the code it actually executes - the command name
// is the evidence; this only finds where it lives.
async function findCommandFile (dir, command, root = 'app/Console') {
  const needle = String(command).trim().split(/\s+/)[0]
  if (!needle) return null
  // Must match the whole signature, not a prefix of a longer one: the declared
  // `kafka:consume-spbv1` is a prefix of `kafka:consume-spbv1-bd-events`, and a
  // substring test hands the wrong file to the wrong worker.
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const signature = new RegExp(`['\"\`]\\s*${esc}(?=[\\s'\"\`{])`)
  const stack = [path.join(dir, root)]
  let scanned = 0
  while (stack.length && scanned < 500) {
    const cur = stack.pop()
    let entries
    try { entries = await fs.readdir(cur, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) { stack.push(full); continue }
      if (!e.name.endsWith('.php')) continue
      scanned++
      const text = await readText(full)
      if (text && signature.test(text)) return path.relative(dir, full)
    }
  }
  return null
}

const INFRA = [
  // Admin UIs first: `kafka-ui` must not match the broker rule below.
  { test: /kafka-ui|kafdrop|redisinsight|pgadmin|phpmyadmin|adminer|mongo-express/i, kind: 'external', label: 'Admin UI' },
  { test: /mysql|mariadb/i, kind: 'datastore', label: 'MySQL' },
  { test: /mongo/i, kind: 'datastore', label: 'MongoDB' },
  { test: /emqx|mosquitto|vernemq|hivemq/i, kind: 'queue', label: 'MQTT broker' },
  { test: /postgres|pgsql/i, kind: 'datastore', label: 'Postgres' },
  { test: /valkey|redis/i, kind: 'datastore', label: 'Redis / Valkey' },
  { test: /mailpit|mailhog/i, kind: 'external', label: 'Mail (dev)' },
  { test: /rabbitmq|kafka|nats/i, kind: 'queue', label: 'Message broker' },
  { test: /meilisearch|elasticsearch|opensearch|typesense/i, kind: 'datastore', label: 'Search index' },
  { test: /minio|localstack/i, kind: 'external', label: 'Object storage' },
  { test: /soketi|reverb|centrifugo/i, kind: 'service', label: 'WebSocket server' },
  { test: /selenium|playwright/i, kind: 'external', label: 'Browser tests' }
]

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/* ---- the scan ---- */

export async function scanRepo (dir) {
  const nodes = []
  const edges = []
  const detected = []

  // First one wins. Two rules can reach the same id - a compose service named
  // `reverb` and laravel/reverb in composer.json both do - and a duplicate id is
  // worse than a missing node: applyPatch only ever finds the first, so the second
  // can never be edited or removed again.
  const add = node => {
    if (nodes.some(n => n.id === node.id)) return node.id
    nodes.push(node)
    return node.id
  }
  const link = (from, to, label) => {
    const id = `e-${from}-${to}`
    if (from === to) return false
    if (edges.some(e => e.id === id)) return false
    if (!nodes.some(n => n.id === from) || !nodes.some(n => n.id === to)) return false
    edges.push({ id, from, to, label })
    return true
  }

  const composer = await readJson(path.join(dir, 'composer.json'))
  const pkg = await readJson(path.join(dir, 'package.json'))
  const php = composer?.require ?? {}
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  const has = (map, name) => Object.keys(map).some(k => k === name || k.startsWith(name + '/'))

  /* infrastructure, from compose */
  for (const file of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const text = await readText(path.join(dir, file))
    if (!text) continue
    detected.push(`${file}: found`)
    const services = composeServices(text)

    // Which images does this repo build? The question is never "does it declare
    // build" but "what does it build FROM": a context with no manifest of its own
    // is this app's build infrastructure, and its image is this app.
    const ourImages = new Set()
    for (const svc of services) {
      if (!svc.build) continue
      const context = (svc.context ?? '.').replace(/\/+$/, '')
      const outside = context.startsWith('..') || path.isAbsolute(context)
      if (!outside && !(await isOwnCodebase(path.join(dir, context)))) {
        if (svc.image) ourImages.add(svc.image)
        detected.push(`  ${svc.name}: built from ${context}, this app`)
        continue
      }
      // A codebase of its own: it gets a node, owning the folder it builds from.
      const script = outside ? null : await scriptFromCommand(dir, context, svc.command)
      add({
        id: slug(svc.name),
        label: svc.name,
        kind: outside ? 'external' : 'service',
        paths: outside ? [] : [script ?? context.replace(/^\.\//, '')],
        notes: `built from ${context}${outside ? ', outside this repo' : ''}${script ? `, runs ${path.basename(script)}` : ''}`
      })
      detected.push(`  ${svc.name}: built from ${context}${outside ? ' (separate repo)' : ' (own codebase, owns that folder)'}`)
    }

    for (const svc of services) {
      if (svc.build) continue
      const id = slug(svc.name)
      const notes = svc.image ? `compose service (${svc.image})` : 'compose service'

      // Running an image we build makes this the app in another role - and compose
      // says which role, so read it instead of calling the service external.
      if (svc.image && ourImages.has(svc.image)) {
        const role = svc.env.CONTAINER_ROLE ?? ''
        const command = svc.env.CONSUME_COMMAND ?? svc.env.WORKER_COMMAND ?? ''
        const file = command ? await findCommandFile(dir, command) : null
        const queue = svc.env.QUEUE_NAME ? ` queue ${svc.env.QUEUE_NAME}` : ''
        add({
          id,
          label: svc.name,
          kind: ROLE_KINDS[role] ?? 'job',
          paths: file ? [file] : [],
          notes: `this app as ${role || 'worker'}${command ? `: ${command}` : ''}${queue}`
        })
        detected.push(
          `  ${svc.name}: this app as ${role || 'worker'}` +
          (command ? ` (${command}${file ? ` -> ${file}` : ', command file not found'})` : '')
        )
        continue
      }

      const hit = INFRA.find(i => i.test.test(svc.name) || (svc.image && i.test.test(svc.image)))
      if (hit) {
        add({ id, label: hit.label, kind: hit.kind, paths: [], notes })
        detected.push(`  ${svc.name}: ${hit.label}`)
      } else {
        add({ id, label: svc.name, kind: 'external', paths: [], notes })
        detected.push(`  ${svc.name}: unrecognised service, guessed external`)
      }
    }

    // depends_on is declared topology - free edges the scanner used to throw away.
    let wired = 0
    for (const svc of services) {
      for (const dep of svc.dependsOn) {
        if (link(slug(svc.name), slug(dep), 'depends on')) wired++
      }
    }
    if (wired) detected.push(`  depends_on: ${wired} edge(s)`)
    break
  }

  const store = nodes.find(n => /mysql|postgres/i.test(n.id) || /MySQL|Postgres/.test(n.label))
  const cache = nodes.find(n => /valkey|redis/i.test(n.id))
  const mail = nodes.find(n => /mail/i.test(n.id))

  /* PHP / Laravel */
  if (has(php, 'laravel/framework')) {
    detected.push('composer.json: Laravel')
    const httpPaths = await realPaths(dir, ['app/Http', 'routes'])
    if (httpPaths.length) {
      add({ id: 'http', label: 'HTTP layer', kind: 'service', paths: httpPaths, notes: 'Controllers, middleware, routes' })
    }
    const domainPaths = await realPaths(dir, ['app/Models', 'app/Enums', 'app/Events', 'app/Actions'])
    if (domainPaths.length) {
      add({ id: 'domain', label: 'Domain', kind: 'service', paths: domainPaths, notes: 'Models and domain events' })
    }
    const jobPaths = await realPaths(dir, ['app/Jobs', 'app/Console'])
    if (jobPaths.length) {
      add({ id: 'jobs', label: 'Jobs', kind: 'job', paths: jobPaths, notes: 'Queued and scheduled work' })
    }
    if (has(php, 'laravel/reverb')) {
      add({ id: 'reverb', label: 'Reverb (WebSockets)', kind: 'service', paths: [], notes: 'Broadcasts domain events to clients' })
      detected.push('  laravel/reverb: WebSocket server')
    }
    if (has(php, 'inertiajs/inertia-laravel')) detected.push('  inertiajs: SPA served through Laravel')
  }

  /* JS front end / workspaces */
  const wsGlobs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages
  if (wsGlobs?.length) {
    detected.push(`package.json: workspaces (${wsGlobs.join(', ')})`)
    for (const glob of wsGlobs) {
      const root = glob.replace(/\/\*+$/, '')
      if (!(await isDir(path.join(dir, root)))) continue
      for (const entry of await fs.readdir(path.join(dir, root), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const rel = `${root}/${entry.name}`
        const sub = await readJson(path.join(dir, rel, 'package.json'))
        if (!sub) continue
        add({ id: slug(entry.name), label: sub.name ?? entry.name, kind: 'service', paths: [rel], notes: 'workspace package' })
        detected.push(`  ${rel}: workspace package`)
      }
    }
  } else if (await isDir(path.join(dir, 'resources/js'))) {
    const kind = has(deps, 'react') ? 'React' : has(deps, 'vue') ? 'Vue' : 'JS'
    add({ id: 'spa', label: `${kind} front end`, kind: 'ui', paths: ['resources/js'], notes: has(deps, '@inertiajs/react') || has(deps, '@inertiajs/vue3') ? 'Inertia pages' : '' })
    detected.push(`  resources/js: ${kind} front end`)
  } else if (pkg && (has(deps, 'next') || has(deps, 'react') || has(deps, 'vue'))) {
    const src = await realPaths(dir, ['src', 'app', 'pages', 'components'])
    if (src.length) {
      add({ id: 'web', label: has(deps, 'next') ? 'Next.js app' : 'Front end', kind: 'ui', paths: src, notes: '' })
      detected.push(`  package.json: front end (${src.join(', ')})`)
    }
  }

  /* other ecosystems, kept deliberately shallow */
  if (await readText(path.join(dir, 'go.mod'))) detected.push('go.mod: Go module (no heuristics yet)')
  if (await readText(path.join(dir, 'Cargo.toml'))) detected.push('Cargo.toml: Rust crate (no heuristics yet)')
  if (await readText(path.join(dir, 'pyproject.toml'))) detected.push('pyproject.toml: Python project (no heuristics yet)')

  /* edges: only between things we actually emitted */
  link('spa', 'http', 'Inertia')
  link('web', 'http', 'HTTP')
  link('spa', 'reverb', 'WebSocket')
  link('http', 'domain', 'uses')
  link('domain', 'reverb', 'broadcasts')
  if (store) {
    link('domain', store.id, 'SQL')
    if (!nodes.some(n => n.id === 'domain')) link('http', store.id, 'SQL')
  }
  if (cache) {
    link('http', cache.id, 'cache')
    link('jobs', cache.id, 'queue')
  }
  if (mail) link('jobs', mail.id, 'sends mail')

  return { nodes, edges, detected }
}
