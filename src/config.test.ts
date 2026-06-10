import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, loadConfig } from './config.js'

describe('plugin config', () => {
  let tempRoot = ''
  let originalXdgConfigHome: string | undefined

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'opencode-zellij-config-'))
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = join(tempRoot, 'xdg')
  })

  afterEach(async () => {
    if (originalXdgConfigHome === undefined)
      delete process.env.XDG_CONFIG_HOME
    else
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    await rm(tempRoot, { force: true, recursive: true })
  })

  async function writeConfig(directory: string, basename: string, content: string): Promise<string> {
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, basename)
    await writeFile(filePath, content)
    return filePath
  }

  it('uses defaults when no config exists', async () => {
    const result = await loadConfig({ directory: join(tempRoot, 'project') })
    expect(result.config).toEqual(defaultConfig)
    expect(result.config.pty.cleanupExitedPaneOnRead).toBe(true)
    expect(result.sources).toEqual({})
  })

  it('merges user and project config by precedence', async () => {
    const projectRoot = join(tempRoot, 'project')
    await writeConfig(join(tempRoot, 'xdg', 'opencode'), 'opencode-zellij.config.jsonc', `{
      "tabTitle": { "enabled": false, "emojiIdle": "U" },
      "pty": {
        "cleanupExitedPaneOnRead": false,
        "sudoPane": "deny"
      }
    }`)
    await writeConfig(join(projectRoot, '.opencode'), 'opencode-zellij.config.jsonc', `{
      "tabTitle": { "emojiIdle": "P", "emojiRunning": "R" },
      "pty": {
        "enabled": false,
        "cleanupExitedPaneOnRead": true
      }
    }`)

    const result = await loadConfig({ directory: projectRoot })

    expect(result.config.tabTitle.enabled).toBe(false)
    expect(result.config.tabTitle.emojiIdle).toBe('P')
    expect(result.config.tabTitle.emojiRunning).toBe('R')
    expect(result.config.pty.enabled).toBe(false)
    expect(result.config.pty.cleanupExitedPaneOnRead).toBe(true)
    expect(result.config.pty.sudoPane).toBe('deny')
  })

  it('supports sudo pane modes', async () => {
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.jsonc', '{ "pty": { "sudoPane": "hide" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.pty.sudoPane).toBe('hide')
  })

  it('ignores pre-release legacy basename files', async () => {
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.jsonc', '{ "tabTitle": { "emojiIdle": "legacy" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe(defaultConfig.tabTitle.emojiIdle)
    expect(result.sources.project).toBeUndefined()
  })

  it('parses jsonc comments and trailing commas', async () => {
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.jsonc', `{
      // comment
      "tabTitle": {
        "emojiIdle": "C",
      },
    }`)

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('C')
  })

  it('loads JSON config files', async () => {
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.json', '{ "tabTitle": { "emojiIdle": "JSON" }, "pty": { "sudoPane": "hide" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('JSON')
    expect(result.config.pty.sudoPane).toBe('hide')
  })

  it('prefers JSONC config files over JSON config files', async () => {
    const configDir = join(tempRoot, 'project', '.opencode')
    await writeConfig(configDir, 'opencode-zellij.config.json', '{ "tabTitle": { "emojiIdle": "JSON" } }')
    await writeConfig(configDir, 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "JSONC" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('JSONC')
  })

  it('ignores invalid config content and falls back to lower layers', async () => {
    await writeConfig(join(tempRoot, 'xdg', 'opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "U" } }')
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.jsonc', 'not json')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('U')
    expect(result.sources.project).toBeUndefined()
    expect(result.warnings.some(warning => warning.includes('invalid config shape'))).toBe(true)
  })

  it('ignores invalid shape and falls back to lower layers', async () => {
    await writeConfig(join(tempRoot, 'xdg', 'opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "U" } }')
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "enabled": "no" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('U')
    expect(result.sources.project).toBeUndefined()
    expect(result.warnings.some(warning => warning.includes('invalid config shape'))).toBe(true)
  })

  it('ignores rc and package.json config sources', async () => {
    const configDir = join(tempRoot, 'project', '.opencode')
    await writeConfig(configDir, '.opencode-zellijrc', '{ "tabTitle": { "emojiIdle": "RC" } }')
    await writeConfig(configDir, 'package.json', '{ "opencode-zellij": { "tabTitle": { "emojiIdle": "PKG" } } }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe(defaultConfig.tabTitle.emojiIdle)
  })

  it('rejects unknown top-level fields', async () => {
    await writeConfig(join(tempRoot, 'xdg', 'opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "U" } }')
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'base.config.jsonc', '{ "tabTitle": { "emojiIdle": "BASE" } }')
    await writeConfig(join(tempRoot, 'project', '.opencode'), 'opencode-zellij.config.jsonc', '{ "extends": "./base.config.jsonc" }')

    const result = await loadConfig({ directory: join(tempRoot, 'project') })

    expect(result.config.tabTitle.emojiIdle).toBe('U')
    expect(result.sources.project).toBeUndefined()
    expect(result.warnings.some(warning => warning.includes('invalid config shape'))).toBe(true)
  })

  it('uses worktree project config before directory fallback', async () => {
    await writeConfig(join(tempRoot, 'directory', '.opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "D" } }')
    await writeConfig(join(tempRoot, 'worktree', '.opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "W" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'directory'), worktree: join(tempRoot, 'worktree') })

    expect(result.config.tabTitle.emojiIdle).toBe('W')
  })

  it('uses directory project config when worktree has no config', async () => {
    await writeConfig(join(tempRoot, 'directory', '.opencode'), 'opencode-zellij.config.jsonc', '{ "tabTitle": { "emojiIdle": "D" } }')

    const result = await loadConfig({ directory: join(tempRoot, 'directory'), worktree: join(tempRoot, 'worktree') })

    expect(result.config.tabTitle.emojiIdle).toBe('D')
  })

})
