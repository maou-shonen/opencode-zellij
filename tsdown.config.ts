import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/plugin.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  deps: {
    neverBundle: ['@opencode-ai/plugin'],
  },
})
