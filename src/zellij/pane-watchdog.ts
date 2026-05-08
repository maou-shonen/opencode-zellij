import type { PtySession } from '../pty/session.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export interface WatchdogPane {
  sessionId: string
  paneId: string
  title: string
  openCodeSessionId: string | null
  createdAt: string
}

export interface WatchdogRegistry {
  version: 1
  instanceId: string
  ownerPid: number
  ownerStartTime: string | null
  zellijSessionName: string | null
  panes: WatchdogPane[]
}

const instanceId = randomUUID()
let watchdogStarted = false

function registryDirectory(): string {
  const base = process.env.XDG_RUNTIME_DIR || tmpdir()
  return path.join(base, `opencode-zellij-${process.getuid?.() ?? 'user'}`)
}

export function watchdogRegistryPath(): string {
  return path.join(registryDirectory(), `panes-${process.pid}-${instanceId}.json`)
}

export function parseLinuxProcessStartTime(stat: string): string | null {
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  return fieldsAfterCommand[19] ?? null
}

function linuxProcessStartTime(pid: number): string | null {
  try {
    return parseLinuxProcessStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  }
  catch {
    return null
  }
}

function emptyRegistry(): WatchdogRegistry {
  return {
    version: 1,
    instanceId,
    ownerPid: process.pid,
    ownerStartTime: linuxProcessStartTime(process.pid),
    zellijSessionName: process.env.ZELLIJ_SESSION_NAME?.trim() || null,
    panes: [],
  }
}

function readRegistry(): WatchdogRegistry {
  const file = watchdogRegistryPath()
  if (!existsSync(file))
    return emptyRegistry()

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as WatchdogRegistry
    if (parsed.version !== 1 || parsed.instanceId !== instanceId || parsed.ownerPid !== process.pid || !Array.isArray(parsed.panes))
      return emptyRegistry()
    return parsed
  }
  catch {
    return emptyRegistry()
  }
}

function writeRegistry(registry: WatchdogRegistry): void {
  const directory = registryDirectory()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = watchdogRegistryPath()
  const tempFile = `${file}.tmp-${process.pid}`
  writeFileSync(tempFile, JSON.stringify(registry, null, 2), { mode: 0o600 })
  renameSync(tempFile, file)
}

function ensureWatchdog(): void {
  if (watchdogStarted)
    return
  watchdogStarted = true

  const child = spawn('node', [watchdogRunnerPath(), watchdogRegistryPath()], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

function watchdogRunnerPath(): string {
  return fileURLToPath(new URL('./pane-watchdog-runner.mjs', import.meta.url))
}

export function cleanupStaleWatchdogRegistries(): void {
  const directory = registryDirectory()
  if (!existsSync(directory))
    return

  for (const fileName of readdirSync(directory)) {
    if (!fileName.startsWith('panes-') || !fileName.endsWith('.json'))
      continue

    const file = path.join(directory, fileName)
    try {
      const registry = JSON.parse(readFileSync(file, 'utf8')) as WatchdogRegistry
      if (registry.version !== 1 || ownerStillMatches(registry))
        continue
      closeRegistryPanes(registry)
      rmSync(file, { force: true })
    }
    catch {
      rmSync(file, { force: true })
    }
  }
}

function ownerStillMatches(registry: WatchdogRegistry): boolean {
  try {
    process.kill(registry.ownerPid, 0)
  }
  catch {
    return false
  }

  return !registry.ownerStartTime || linuxProcessStartTime(registry.ownerPid) === registry.ownerStartTime
}

function closeRegistryPanes(registry: WatchdogRegistry): void {
  for (const pane of registry.panes) {
    const args = []
    if (registry.zellijSessionName)
      args.push('--session', registry.zellijSessionName)
    args.push('action', 'close-pane', '--pane-id', pane.paneId)
    spawn('zellij', args, { detached: true, stdio: 'ignore', env: process.env }).unref()
  }
}

export function upsertWatchdogPane(registry: WatchdogRegistry, session: PtySession): WatchdogRegistry {
  return {
    ...registry,
    panes: [
      ...registry.panes.filter(pane => pane.sessionId !== session.id && pane.paneId !== session.paneId),
      {
        sessionId: session.id,
        paneId: session.paneId,
        title: session.title,
        openCodeSessionId: session.openCodeSessionId,
        createdAt: session.createdAt,
      },
    ],
  }
}

export function removeWatchdogPane(registry: WatchdogRegistry, sessionId: string): WatchdogRegistry {
  return {
    ...registry,
    panes: registry.panes.filter(pane => pane.sessionId !== sessionId),
  }
}

export function registerPaneForWatchdog(session: PtySession): void {
  writeRegistry(upsertWatchdogPane(readRegistry(), session))
  ensureWatchdog()
}

export function unregisterPaneFromWatchdog(sessionId: string): void {
  const registry = readRegistry()
  const updated = removeWatchdogPane(registry, sessionId)
  if (updated.panes.length === registry.panes.length)
    return
  if (updated.panes.length === 0) {
    removeWatchdogRegistry()
    return
  }
  writeRegistry(updated)
}

export function removeWatchdogRegistry(): void {
  try {
    rmSync(watchdogRegistryPath(), { force: true })
  }
  catch {
    // Watchdog registry cleanup is best effort.
  }
}
