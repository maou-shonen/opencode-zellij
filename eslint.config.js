import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: [
    'dist',
    'node_modules',
    '**/*.test.ts',
  ],
  markdown: false,
  typescript: true,
})
