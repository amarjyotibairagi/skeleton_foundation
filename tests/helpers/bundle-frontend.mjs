import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Bundles frontend TypeScript (the same sources Vite builds) into one ES module, in memory,
// so tests can run browser-side logic without a dev server. `import.meta.env` is empty, as in a
// build without VITE_* variables.
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** `entry` is a path from the repository root, or `{ contents }`: module source resolved from there. */
export async function bundleFrontend(entry, { platform = 'node' } = {}) {
  const result = await build({
    ...(typeof entry === 'string'
      ? { entryPoints: [path.resolve(root, entry)] }
      : { stdin: { contents: entry.contents, resolveDir: root, loader: 'ts' } }),
    bundle: true,
    format: 'esm',
    platform,
    target: 'es2022',
    write: false,
    logLevel: 'silent',
    define: { 'import.meta.env': '{}' },
  })
  return result.outputFiles[0].text
}

/** Bundles and imports a frontend module in this Node process. */
export async function importFrontend(entry) {
  const code = await bundleFrontend(entry)
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
