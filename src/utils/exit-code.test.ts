import { describe, expect, it } from 'bun:test'
import { createExitCodeToken, parseExitCodeMarker } from './exit-code.js'
import { buildCommandArgv } from './shell-args.js'

describe('exit code capture', () => {
  it('parses exit-code markers', () => {
    expect(parseExitCodeMarker('[zellij-pty:abc123] exit-code=7')).toEqual({ token: 'abc123', exitCode: 7 })
    expect(parseExitCodeMarker('\u001B[32m[zellij-pty:abc123] exit-code=7\u001B[0m')).toEqual({ token: 'abc123', exitCode: 7 })
    expect(parseExitCodeMarker('not a marker')).toBeNull()
  })

  it('creates hex tokens', () => {
    expect(createExitCodeToken()).toMatch(/^[a-f0-9]{32}$/)
  })

  it('wraps shell commands so exit can be captured', () => {
    const argv = buildCommandArgv({ command: 'exit 7' }, { exitCodeToken: 'abc123' })
    expect(argv.slice(0, 3)).toEqual(['bash', '-lc', expect.stringContaining('exit-code=%s')])
    expect(argv).toContain('abc123')
    expect(argv).toContain('exit 7')
  })

  it('wraps direct argv commands so exit can be captured', () => {
    const argv = buildCommandArgv({ command: 'node', args: ['--version'] }, { exitCodeToken: 'abc123' })
    expect(argv.slice(0, 3)).toEqual(['bash', '-lc', expect.stringContaining('"$@"')])
    expect(argv.slice(-2)).toEqual(['node', '--version'])
  })
})
