import type { SessionManager } from '../pty/manager.js'
import type { SubscriberManager } from './subscribe.js'
import process from 'node:process'
import { sessionManager } from '../pty/manager.js'
import { zellijCli } from './cli.js'
import { subscriberManager } from './subscribe.js'

let registered = false
let cleanedUp = false

export function cleanupPanesOnShutdown(
  sessions: SessionManager = sessionManager,
  subscribers: SubscriberManager = subscriberManager,
): void {
  if (cleanedUp)
    return
  cleanedUp = true

  for (const session of sessions.list()) {
    try {
      zellijCli.closePaneSync(session.paneId)
    }
    catch {
      // Process shutdown cleanup is best effort.
    }

    subscribers.forget(session.id)
    try {
      sessions.remove(session.id)
    }
    catch {
      // Another cleanup path may have already removed it.
    }
  }
}

export function registerShutdownCleanup(): void {
  if (registered)
    return
  registered = true

  process.once('exit', () => cleanupPanesOnShutdown())
  process.once('SIGINT', () => exitAfterCleanup('SIGINT', 130))
  process.once('SIGTERM', () => exitAfterCleanup('SIGTERM', 143))
  process.once('SIGHUP', () => exitAfterCleanup('SIGHUP', 129))
}

function exitAfterCleanup(signal: NodeJS.Signals, code: number): void {
  cleanupPanesOnShutdown()
  process.removeAllListeners(signal)
  process.exit(code)
}
