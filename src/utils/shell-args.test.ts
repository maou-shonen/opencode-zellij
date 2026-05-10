import { describe, expect, it } from 'bun:test'
import { buildCommandArgv } from './shell-args.js'

describe('shell argument helpers', () => {
  it('runs shell commands through bash -lc', () => {
    expect(buildCommandArgv({ command: 'echo hi' })).toEqual(['bash', '-lc', 'echo hi'])
  })

  it('runs direct argv commands without shell parsing', () => {
    expect(buildCommandArgv({ command: 'node', args: ['--version'] })).toEqual(['node', '--version'])
  })

  it('rejects blank commands', () => {
    expect(() => buildCommandArgv({ command: '  ' })).toThrow(/command is required/)
  })

})
