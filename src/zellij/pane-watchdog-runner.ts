import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import process from 'node:process'

interface WatchdogPane {
  paneId: string
}

interface WatchdogRegistry {
  ownerPid: number
  ownerStartTime?: string | null | undefined
  zellijSessionName?: string | null | undefined
  panes?: WatchdogPane[] | undefined
}

const registryPath = process.argv[2]
const pollIntervalMs = 1_000

if (!registryPath)
  process.exit(1)

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function linuxProcessStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
    return fieldsAfterCommand[19] || null
  }
  catch {
    return null
  }
}

function readRegistry(): WatchdogRegistry | null {
  try {
    if (!existsSync(registryPath!))
      return null
    return JSON.parse(readFileSync(registryPath!, 'utf8')) as WatchdogRegistry
  }
  catch {
    return null
  }
}

function ownerAlive(registry: WatchdogRegistry): boolean {
  try {
    process.kill(registry.ownerPid, 0)
  }
  catch {
    return false
  }

  return !registry.ownerStartTime || linuxProcessStartTime(registry.ownerPid) === registry.ownerStartTime
}

function closePane(registry: WatchdogRegistry, paneId: string): void {
  const args: string[] = []
  if (registry.zellijSessionName)
    args.push('--session', registry.zellijSessionName)
  args.push('action', 'close-pane', '--pane-id', paneId)
  spawnSync('zellij', args, { stdio: 'ignore', timeout: 2_000 })
}

async function main(): Promise<void> {
  for (;;) {
    const registry = readRegistry()
    if (!registry)
      return

    if (!ownerAlive(registry)) {
      const finalRegistry = readRegistry() || registry
      for (const pane of finalRegistry.panes || []) {
        closePane(finalRegistry, pane.paneId)
      }
      rmSync(registryPath!, { force: true })
      return
    }

    await sleep(pollIntervalMs)
  }
}

main().catch(() => {
  process.exit(1)
})
