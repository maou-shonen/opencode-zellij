import { describe, expect, it } from 'bun:test'
import { parseActiveTabName, parseCurrentPaneTabId, parsePaneExists, parseTabName } from './parse.js'

describe('parseCurrentPaneTabId', () => {
  it('parses the current pane tab id from list-panes JSON', () => {
    const output = JSON.stringify([
      { id: 8, tab_id: 0, is_plugin: false },
      { id: 1, tab_id: 2, is_plugin: false },
      { id: 42, tab_id: 9, is_plugin: false },
    ])

    expect(parseCurrentPaneTabId(output, '42')).toBe(9)
    expect(parseCurrentPaneTabId(output, '8')).toBe(0)
  })

  it('parses nested and string pane/tab ids from list-panes JSON', () => {
    const output = JSON.stringify({ panes: [{ pane_id: '5', tabId: '3', is_plugin: false }] })

    expect(parseCurrentPaneTabId(output, '5')).toBe(3)
  })

  it('does not resolve plugin panes or malformed list-panes JSON', () => {
    expect(parseCurrentPaneTabId(JSON.stringify([
      { id: 42, tab_id: 9, is_plugin: true },
      { id: 42, tab_id: 10, is_plugin: false },
    ]), '42')).toBe(10)
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 42, tab_id: 9, is_plugin: true }]), '42')).toBeUndefined()
    expect(parseCurrentPaneTabId('not json', '42')).toBeUndefined()
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 7, tab_id: 1 }]), undefined)).toBeUndefined()
    expect(parseCurrentPaneTabId(JSON.stringify([{ id: 7, tab_id: 1 }]), 'terminal_7')).toBeUndefined()
  })
})

describe('parsePaneExists', () => {
  it('detects whether a pane exists in list-panes JSON', () => {
    const output = JSON.stringify([
      { id: 8, tab_id: 0, is_plugin: false },
      { id: 42, tab_id: 9, is_plugin: false },
    ])

    expect(parsePaneExists(output, '42')).toBe(true)
    expect(parsePaneExists(output, '7')).toBe(false)
  })

  it('ignores plugin panes and malformed JSON', () => {
    expect(parsePaneExists(JSON.stringify([{ id: 42, tab_id: 9, is_plugin: true }]), '42')).toBe(false)
    expect(parsePaneExists(JSON.stringify([{ id: 42, tab_id: 9, is_plugin: false }]), 'terminal_42')).toBe(true)
    expect(parsePaneExists(JSON.stringify([{ id: 42, tab_id: 9, is_plugin: false }]), 'terminal_x')).toBeUndefined()
    expect(parsePaneExists('not json', '42')).toBeUndefined()
    expect(parsePaneExists(JSON.stringify([{ id: 7, tab_id: 1 }]), undefined)).toBeUndefined()
    expect(parsePaneExists(JSON.stringify([{ id: 7, tab_id: 1 }]), 'terminal_7')).toBe(true)
  })
})

describe('parseTabName', () => {
  it('parses tab name from list-tabs JSON', () => {
    const output = JSON.stringify([
      { tab_id: 0, name: 'first-tab' },
      { tab_id: 2, name: 'second-tab' },
      { tab_id: 9, name: 'my-tab' },
    ])

    expect(parseTabName(output, 0)).toBe('first-tab')
    expect(parseTabName(output, 2)).toBe('second-tab')
    expect(parseTabName(output, 9)).toBe('my-tab')
  })

  it('parses tab name with name/title variations', () => {
    expect(parseTabName(JSON.stringify([
      { tab_id: 1, name: 'named-tab' },
    ]), 1)).toBe('named-tab')

    expect(parseTabName(JSON.stringify([
      { tabId: 2, title: 'titled-tab' },
    ]), 2)).toBe('titled-tab')

    expect(parseTabName(JSON.stringify([
      { tab_id: '3', name: 'string-id-tab' },
    ]), 3)).toBe('string-id-tab')
  })

  it('parses nested tab name from list-tabs JSON', () => {
    const output = JSON.stringify({ tabs: [{ tab_id: 5, name: 'nested-tab' }] })
    expect(parseTabName(output, 5)).toBe('nested-tab')
  })

  it('returns undefined for non-matching tab id or malformed JSON', () => {
    expect(parseTabName(JSON.stringify([
      { tab_id: 1, name: 'other-tab' },
    ]), 99)).toBeUndefined()
    expect(parseTabName('not json', 1)).toBeUndefined()
    expect(parseTabName(JSON.stringify([{ name: 'no-id' }]), 1)).toBeUndefined()
    expect(parseTabName(undefined as unknown as string, 1)).toBeUndefined()
  })

  it('does not fallback to active tab name when tab id is unknown', () => {
    expect(parseTabName(JSON.stringify([
      { tab_id: 1, name: 'inactive-tab', active: false },
      { tab_id: 2, name: 'active-tab', active: true },
    ]), undefined)).toBeUndefined()
  })
})

describe('parseActiveTabName', () => {
  it('parses the active non-plugin tab name from list-tabs JSON', () => {
    expect(parseActiveTabName(JSON.stringify([
      { tab_id: 1, name: 'inactive-tab', active: false },
      { tab_id: 2, title: 'active-tab', active: true },
    ]))).toBe('active-tab')
  })

  it('parses nested active tab names and ignores plugin tabs', () => {
    expect(parseActiveTabName(JSON.stringify({
      tabs: [
        { tab_id: 1, name: 'plugin-tab', active: true, is_plugin: true },
        { tabId: '2', name: 'real-active-tab', active: true, is_plugin: false },
      ],
    }))).toBe('real-active-tab')
  })

  it('returns undefined for missing active tabs or malformed JSON', () => {
    expect(parseActiveTabName(JSON.stringify([
      { tab_id: 1, name: 'inactive-tab', active: false },
    ]))).toBeUndefined()
    expect(parseActiveTabName('not json')).toBeUndefined()
    expect(parseActiveTabName(undefined as unknown as string)).toBeUndefined()
  })
})
