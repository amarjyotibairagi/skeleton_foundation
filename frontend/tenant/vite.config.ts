import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * A tab opened before a deploy still references the previous build's hashed chunks
 * (lazy views). Vite empties the output directory on build,
 * which turned those lazy imports into 404s. Keep the previous builds' assets for a
 * week alongside the new ones; hashed names never collide, and older ones are pruned.
 */
function keepRecentAssets(maxAgeDays = 7): Plugin {
  let assetsDir = ''
  let kept: Array<{ name: string; data: Buffer; atime: Date; mtime: Date }> = []
  return {
    name: 'keep-recent-assets',
    apply: 'build',
    configResolved(config) {
      assetsDir = path.resolve(config.root, config.build.outDir, config.build.assetsDir)
    },
    buildStart() {
      kept = []
      if (!existsSync(assetsDir)) return
      const cutoff = Date.now() - maxAgeDays * 86_400_000
      for (const name of readdirSync(assetsDir)) {
        const file = path.join(assetsDir, name)
        const info = statSync(file)
        if (info.isFile() && info.mtimeMs >= cutoff) kept.push({ name, data: readFileSync(file), atime: info.atime, mtime: info.mtime })
      }
    },
    closeBundle() {
      mkdirSync(assetsDir, { recursive: true })
      for (const asset of kept) {
        const file = path.join(assetsDir, asset.name)
        if (existsSync(file)) continue
        writeFileSync(file, asset.data)
        // The original age, so pruning counts from when the file was first deployed.
        utimesSync(file, asset.atime, asset.mtime)
      }
      kept = []
    },
  }
}

export default defineConfig({
  plugins: [react(), keepRecentAssets()],
  server: { host: '127.0.0.1', port: 6354, strictPort: true },
  preview: { host: '127.0.0.1', port: 6354, strictPort: true },
})
