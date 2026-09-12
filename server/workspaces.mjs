import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAIN, isDiagramName } from './graph.mjs'

// The workspace list spans repos, so it cannot live inside one. It is the only
// state PromptCanvas keeps outside the projects it drives.
const HOME = process.env.PROMPTCANVAS_HOME || path.join(os.homedir(), '.promptcanvas')
export const CONFIG_PATH = path.join(HOME, 'workspaces.json')

const EMPTY = { version: 1, activeId: null, model: '', workspaces: [] }

// Windows paths are case-insensitive; compare on a normalised form so the same
// repo cannot be added twice under different spellings.
const key = dir => {
  const resolved = path.resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const slugify = s =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace'

function uniqueId (base, taken) {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
}

export function isUsableDir (dir) {
  try {
    return fsSync.statSync(path.resolve(dir)).isDirectory()
  } catch {
    return false
  }
}

function normalise (config) {
  const seen = new Set()
  const ids = new Set()
  const workspaces = []

  for (const w of config.workspaces ?? []) {
    if (!w?.dir) continue
    const dir = path.resolve(w.dir)
    if (seen.has(key(dir))) continue
    seen.add(key(dir))
    const id = uniqueId(w.id || slugify(path.basename(dir)), ids)
    ids.add(id)
    workspaces.push({
      id,
      name: w.name || path.basename(dir),
      dir,
      activeSessionId: w.activeSessionId ?? null,
      // Which diagram this workspace is showing, plus what each session was last
      // on. That mapping is what makes switching sessions switch the canvas.
      diagram: isDiagramName(w.diagram) ? w.diagram : MAIN,
      sessionDiagrams: Object.fromEntries(
        Object.entries(w.sessionDiagrams ?? {}).filter(([, v]) => isDiagramName(v))
      ),
      // A session the user has started but not yet spoken to. It owns a real id
      // and a real diagram; the SDK only writes its transcript on the first turn,
      // so until then the picker lists it from here.
      pendingSession: w.pendingSession?.id ? w.pendingSession : null
    })
  }

  const activeId = workspaces.some(w => w.id === config.activeId)
    ? config.activeId
    : (workspaces[0]?.id ?? null)

  // Model choice is one setting for the tool, not per repo.
  const model = typeof config.model === 'string' ? config.model : ''
  return { version: 1, activeId, model, workspaces }
}

const BACKUP_PATH = CONFIG_PATH + '.bak'

const readJson = async file => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    // A corrupt file is a problem to report, never one to paper over by
    // overwriting: that is somebody's workspace list.
    throw new Error(`${file} is not valid JSON (${err.message}). Fix or delete it.`)
  }
}

export async function readConfig () {
  const current = await readJson(CONFIG_PATH)
  if (current) return normalise(current)

  // The file is genuinely absent. Prefer the last good copy over reseeding,
  // so a stray delete does not cost you the list.
  const backup = await readJson(BACKUP_PATH)
  if (backup?.workspaces?.length) {
    return writeConfig(backup, { allowEmpty: true })
  }

  // Real first run: adopt PROJECT_DIR so an existing .env setup keeps working.
  const seed = process.env.PROJECT_DIR
  const config = normalise(
    seed && isUsableDir(seed) ? { ...EMPTY, workspaces: [{ dir: seed }] } : EMPTY
  )
  return writeConfig(config, { allowEmpty: true })
}

export async function writeConfig (config, { allowEmpty = false } = {}) {
  const next = normalise(config)

  // Emptying the list is only ever intentional from removeWorkspace. Anywhere
  // else it means something upstream lost the config, and writing it through
  // would destroy the real one.
  if (!next.workspaces.length && !allowEmpty) {
    const existing = await readJson(CONFIG_PATH).catch(() => null)
    if (existing?.workspaces?.length) {
      throw new Error('refusing to clear the workspace list')
    }
  }

  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  const previous = await readJson(CONFIG_PATH).catch(() => null)
  if (previous?.workspaces?.length) {
    await fs.writeFile(BACKUP_PATH, JSON.stringify(previous, null, 2) + '\n', 'utf8')
  }

  // Write then rename, so an interrupted write cannot leave a truncated file.
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, CONFIG_PATH)
  return next
}

export async function addWorkspace (dir) {
  if (!dir?.trim()) throw new Error('give a folder path')
  const resolved = path.resolve(dir.trim())
  if (!isUsableDir(resolved)) throw new Error(`not a folder: ${resolved}`)

  const config = await readConfig()
  const existing = config.workspaces.find(w => key(w.dir) === key(resolved))
  if (existing) return writeConfig({ ...config, activeId: existing.id })

  config.workspaces.push({ dir: resolved, name: path.basename(resolved) })
  const saved = await writeConfig(config)
  const added = saved.workspaces.find(w => key(w.dir) === key(resolved))
  return writeConfig({ ...saved, activeId: added.id })
}

// Removes it from the bar only. Nothing on disk is touched, graph.json included.
export async function removeWorkspace (id) {
  const config = await readConfig()
  return writeConfig({
    ...config,
    workspaces: config.workspaces.filter(w => w.id !== id),
    activeId: config.activeId === id ? null : config.activeId
  }, { allowEmpty: true })
}

export async function setActiveWorkspace (id) {
  const config = await readConfig()
  if (!config.workspaces.some(w => w.id === id)) throw new Error(`no workspace "${id}"`)
  return writeConfig({ ...config, activeId: id })
}

// Remembered per workspace, so switching back lands you in the same conversation
// - and on the diagram that conversation was working on.
export async function setActiveSession (workspaceId, sessionId) {
  const config = await readConfig()
  return writeConfig({
    ...config,
    workspaces: config.workspaces.map(w => {
      if (w.id !== workspaceId) return w
      // No session means no diagram of its own yet: show the baseline until the
      // first turn creates one.
      if (!sessionId) return { ...w, activeSessionId: null, diagram: MAIN }
      // A session that has been here before brings its diagram back; a new one
      // adopts whatever is on screen, so starting a session never moves you.
      const diagram = w.sessionDiagrams[sessionId] ?? w.diagram
      return {
        ...w,
        activeSessionId: sessionId,
        diagram,
        sessionDiagrams: { ...w.sessionDiagrams, [sessionId]: diagram }
      }
    })
  })
}

// Switching diagram by hand rebinds the live session to it, so coming back to
// that conversation later brings this diagram with it.
export async function setActiveDiagram (workspaceId, name) {
  const config = await readConfig()
  return writeConfig({
    ...config,
    workspaces: config.workspaces.map(w => {
      if (w.id !== workspaceId) return w
      const sessionDiagrams = w.activeSessionId
        ? { ...w.sessionDiagrams, [w.activeSessionId]: name }
        : w.sessionDiagrams
      return { ...w, diagram: name, sessionDiagrams }
    })
  })
}

export async function setPendingSession (workspaceId, pending) {
  const config = await readConfig()
  return writeConfig({
    ...config,
    workspaces: config.workspaces.map(w =>
      w.id === workspaceId ? { ...w, pendingSession: pending } : w
    )
  })
}

// Deleting a session drops its binding too, so the map cannot grow forever.
export async function forgetSession (workspaceId, sessionId) {
  const config = await readConfig()
  return writeConfig({
    ...config,
    workspaces: config.workspaces.map(w => {
      if (w.id !== workspaceId) return w
      const { [sessionId]: _gone, ...rest } = w.sessionDiagrams
      return { ...w, sessionDiagrams: rest }
    })
  })
}

export async function setModel (model) {
  const config = await readConfig()
  return writeConfig({ ...config, model: String(model ?? '') })
}

export async function activeWorkspace () {
  const config = await readConfig()
  return config.workspaces.find(w => w.id === config.activeId) ?? null
}
