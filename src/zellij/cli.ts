import type { CommandInput } from '../utils/shell-args.js'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import { parsePaneId } from '../utils/ids.js'
import { buildCommandArgv } from '../utils/shell-args.js'

const execFileAsync = promisify(execFile)

export type NewPaneOptions = CommandInput & {
  cwd?: string | undefined
  title?: string | undefined
  floating?: boolean | undefined
  exitCodeToken?: string | undefined
}

export interface ZellijRunOptions {
  timeoutMs?: number | undefined
}

interface ZellijResult {
  stdout: string
  stderr: string
}

export function zellijCommandArgs(actionArgs: string[]): string[] {
  const sessionName = process.env.ZELLIJ_SESSION_NAME?.trim()
  if (sessionName)
    return ['--session', sessionName, ...actionArgs]
  return actionArgs
}

export function zellijActionArgs(action: string, args: string[] = []): string[] {
  return ['action', action, ...args]
}

export function buildNewPaneActionArgs(options: NewPaneOptions): string[] {
  const args = ['action', 'new-pane']
  if (process.env.ZELLIJ)
    args.push('--near-current-pane')

  if (options.title)
    args.push('--name', options.title)
  if (options.cwd)
    args.push('--cwd', options.cwd)
  if (options.floating)
    args.push('--floating')

  args.push('--', ...buildCommandArgv(options, { exitCodeToken: options.exitCodeToken }))
  return args
}

export function buildRenameTabActionArgs(title: string): string[] {
  return ['action', 'rename-tab', title]
}

export function ensureZellijTarget(): void {
  if (process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME)
    return
  throw new Error('Zellij context not found. Run OpenCode inside Zellij or set ZELLIJ_SESSION_NAME to an existing session.')
}

async function runZellij(actionArgs: string[], options: ZellijRunOptions = {}): Promise<ZellijResult> {
  ensureZellijTarget()
  try {
    const result = await execFileAsync('zellij', zellijCommandArgs(actionArgs), {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 10_000,
      maxBuffer: 20 * 1024 * 1024,
    })

    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
  catch (cause) {
    const error = cause as { message?: string, stdout?: string, stderr?: string }
    const stderr = error.stderr?.trim()
    const stdout = error.stdout?.trim()
    const detail = stderr || stdout || error.message || 'unknown error'
    throw new Error(`zellij ${actionArgs.join(' ')} failed: ${detail}`)
  }
}

export class ZellijCli {
  async newPane(options: NewPaneOptions): Promise<string> {
    const result = await runZellij(buildNewPaneActionArgs(options))
    return parsePaneId(result.stdout)
  }

  async writeChars(paneId: string, data: string): Promise<void> {
    await runZellij(zellijActionArgs('write-chars', ['--pane-id', paneId, data]))
  }

  async sendCtrlC(paneId: string): Promise<void> {
    await runZellij(zellijActionArgs('send-keys', ['--pane-id', paneId, 'Ctrl c']))
  }

  async closePane(paneId: string): Promise<void> {
    await runZellij(zellijActionArgs('close-pane', ['--pane-id', paneId]))
  }

  async focusPane(paneId: string): Promise<void> {
    await runZellij(zellijActionArgs('focus-pane-id', [paneId]))
  }

  async dumpScreen(paneId: string): Promise<string> {
    const result = await runZellij(zellijActionArgs('dump-screen', ['--pane-id', paneId, '--full']), { timeoutMs: 10_000 })
    return result.stdout
  }

  async renameTab(title: string): Promise<void> {
    await runZellij(buildRenameTabActionArgs(title))
  }
}

export const zellijCli = new ZellijCli()
