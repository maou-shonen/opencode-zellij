import { describe, expect, it } from 'bun:test'
import { assertCommandAllowed, configurePolicy } from './policy.js'

describe('permission policy', () => {
  function resetPolicy(): void {
    configurePolicy({ denyCommands: [], allowCommands: [], allowSudoPane: true })
  }

  it('denies sudo outside human-input-only panes', () => {
    resetPolicy()
    expect(() => assertCommandAllowed({ command: 'sudo apt update' })).toThrow(/sudo commands must use zellij_pty_request_sudo/)
  })

  it('allows sudo inside human-input-only panes', () => {
    resetPolicy()
    expect(() => assertCommandAllowed({ command: 'sudo apt update', humanInputOnly: true })).not.toThrow()
  })

  it('denies destructive device writes', () => {
    resetPolicy()
    expect(() => assertCommandAllowed({ command: 'dd if=image of=/dev/sda' })).toThrow(/denied/)
  })

  it('denies destructive root removal', () => {
    resetPolicy()
    expect(() => assertCommandAllowed({ command: 'rm -rf /' })).toThrow(/denied/)
  })

  it('supports configured deny rules', () => {
    configurePolicy({ denyCommands: ['git push *'] })
    expect(() => assertCommandAllowed({ command: 'git push origin main' })).toThrow(/configured deny rule/)
    resetPolicy()
  })

  it('supports configured allow lists', () => {
    configurePolicy({ allowCommands: ['npm *'] })
    expect(() => assertCommandAllowed({ command: 'npm run dev' })).not.toThrow()
    expect(() => assertCommandAllowed({ command: 'python server.py' })).toThrow(/allow list/)
    resetPolicy()
  })

  it('can disable sudo panes', () => {
    configurePolicy({ allowSudoPane: false })
    expect(() => assertCommandAllowed({ command: 'sudo apt update', humanInputOnly: true })).toThrow(/sudo pane is disabled/)
    resetPolicy()
  })
})
