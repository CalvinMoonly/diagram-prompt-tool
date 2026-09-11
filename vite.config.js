import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved by path, not require.resolve: the package's "exports" map has no
// ./package.json entry, so resolving through it throws and takes this config
// file down with it.
const FONT_DIR = fileURLToPath(
  new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url)
)
const HAVE_FONTS = fs.existsSync(FONT_DIR)
// Xiaolai is a 27 MB CJK family. Drop it in too if you label nodes in Chinese.
const SKIP = new Set(['Xiaolai'])

// Excalidraw resolves element fonts against window.EXCALIDRAW_ASSET_PATH, which
// defaults to a CDN (esm.sh). index.html points that at '/', and this plugin
// serves the files from node_modules in dev and copies them into the build, so
// the canvas renders offline and no request leaves the machine.
function excalidrawFonts () {
  let outDir
  return {
    name: 'excalidraw-fonts',
    configResolved (config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer (server) {
      if (!HAVE_FONTS) return
      server.middlewares.use('/fonts', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '')
        const file = path.join(FONT_DIR, rel)
        if (!file.startsWith(FONT_DIR) || !fs.existsSync(file)) return next()
        res.setHeader('Content-Type', 'font/woff2')
        res.setHeader('Cache-Control', 'max-age=31536000, immutable')
        fs.createReadStream(file).pipe(res)
      })
    },
    closeBundle () {
      if (!outDir || !HAVE_FONTS) return
      for (const family of fs.readdirSync(FONT_DIR)) {
        if (SKIP.has(family)) continue
        fs.cpSync(path.join(FONT_DIR, family), path.join(outDir, 'fonts', family), { recursive: true })
      }
    }
  }
}

export default defineConfig({
  root: 'web',
  plugins: [react(), excalidrawFonts()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:8787' }
  }
})
