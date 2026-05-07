import type { CommandInput } from '../utils/shell-args.js'
import { commandLineForPolicy } from '../utils/shell-args.js'

export interface PolicyConfig {
  denyCommands?: string[] | undefined
  allowCommands?: string[] | undefined
  allowSudoPane?: boolean | undefined
}

const denyPatterns: RegExp[] = [
  /(^|\s)rm\s+-[^\n&;r|]*r[^\n&;|]*f\s+\//,
  /(^|\s)mkfs(?:\s|$)/,
  /(^|\s)dd\s+(?:[^\s&;|][^\n;|&]*)?\bof=\/dev\//,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
]

const sudoPattern = /(?:^|[\s;&|])sudo(?:[\s;&|]|$)/

let configuredDenyCommands: string[] = []
let configuredAllowCommands: string[] = []
let allowSudoPane = true

export type PolicyCheckInput = CommandInput & {
  humanInputOnly?: boolean | undefined
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function wildcardMatches(pattern: string, commandLine: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`)
  return regex.test(commandLine)
}

export function configurePolicy(config: unknown): void {
  if (!config || typeof config !== 'object')
    return
  const object = config as Record<string, unknown>
  if (isStringArray(object.denyCommands))
    configuredDenyCommands = object.denyCommands
  if (isStringArray(object.allowCommands))
    configuredAllowCommands = object.allowCommands
  if (typeof object.allowSudoPane === 'boolean')
    allowSudoPane = object.allowSudoPane
}

export function assertCommandAllowed(input: PolicyCheckInput): void {
  const commandLine = commandLineForPolicy(input)
  for (const pattern of denyPatterns) {
    if (pattern.test(commandLine)) {
      throw new Error(`Command denied by zellij-pty policy: ${commandLine}`)
    }
  }

  for (const pattern of configuredDenyCommands) {
    if (wildcardMatches(pattern, commandLine)) {
      throw new Error(`Command denied by zellij-pty configured deny rule: ${commandLine}`)
    }
  }

  if (configuredAllowCommands.length > 0 && !configuredAllowCommands.some(pattern => wildcardMatches(pattern, commandLine))) {
    throw new Error(`Command denied by zellij-pty allow list: ${commandLine}`)
  }

  if (!input.humanInputOnly && sudoPattern.test(commandLine)) {
    throw new Error('sudo commands must use request_sudo so credentials stay human-input-only and never pass through agent tool input.')
  }

  if (input.humanInputOnly && sudoPattern.test(commandLine) && !allowSudoPane) {
    throw new Error('sudo pane is disabled by zellij-pty policy.')
  }
}
