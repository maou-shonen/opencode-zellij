import antfu from '@antfu/eslint-config'
import markdownLinks from 'eslint-plugin-markdown-links'

export default antfu(
  {
    ignores: [
      'dist',
      'node_modules',
      '**/*.test.ts',
    ],
    markdown: true,
    typescript: true,
  },
  {
    files: ['**/*.md'],
    plugins: {
      'markdown-links': markdownLinks,
    },
    rules: {
      'markdown-links/no-missing-path': 'error',
    },
  },
)
