import { defineConfig } from 'vite'

// the screens; main and preload are bundled by esbuild (see package.json)
export default defineConfig({
  root: 'src/renderer',
  base: './',
  esbuild: { jsx: 'automatic' },
  build: { outDir: '../../dist/renderer', emptyOutDir: true, target: 'chrome130', assetsInlineLimit: 0 },
})
