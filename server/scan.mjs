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

  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)([^\s:#][^:]*):\s*(.*)$/)
    if (!m) continue
    const [, pad, key, value] = m

    if (pad.length === 0) {
      inServices = key.trim() === 'services'
      indent = null
      current = null
      continue
    }
    if (!inServices) continue
    if (indent === null) indent = pad.length

    if (pad.length === indent) {
      current = { name: key.trim(), image: null, build: false }
      out.push(current)
    } else if (current) {
      if (key.trim() === 'image') current.image = value.replace(/['"]/g, '').trim()
      if (key.trim() === 'build') current.build = true
    }
  }
  return out
}

const INFRA = [
  { test: /mysql|mariadb/i, kind: 'datastore', label: 'MySQL' },
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

  const add = node => { nodes.push(node); return node.id }
  const link = (from, to, label) => {
    if (nodes.some(n => n.id === from) && nodes.some(n => n.id === to)) {
      edges.push({ id: `e-${from}-${to}`, from, to, label })
    }
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
    for (const svc of composeServices(text)) {
      // A service built from this repo IS this repo; the code nodes represent it.
      if (svc.build) { detected.push(`  ${svc.name}: built here, treated as this app`); continue }
      const hit = INFRA.find(i => i.test.test(svc.name) || (svc.image && i.test.test(svc.image)))
      const id = slug(svc.name)
      if (hit) {
        add({ id, label: hit.label, kind: hit.kind, paths: [], notes: svc.image ? `compose service (${svc.image})` : 'compose service' })
        detected.push(`  ${svc.name}: ${hit.label}`)
      } else {
        add({ id, label: svc.name, kind: 'external', paths: [], notes: svc.image ? `compose service (${svc.image})` : 'compose service' })
        detected.push(`  ${svc.name}: unrecognised service, guessed external`)
      }
    }
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
