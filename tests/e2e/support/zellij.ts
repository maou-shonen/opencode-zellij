import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function zellijID(value: number | string | undefined): number | undefined {
  if (value === undefined)
    return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

export interface ZellijTabInfo {
  tab_id?: number | string | undefined
  name?: string | undefined
  title?: string | undefined
  active?: boolean | undefined
  is_plugin?: boolean | undefined
}

export interface ZellijPaneInfo {
  id?: number | string | undefined
  pane_id?: number | string | undefined
  tab_id?: number | string | undefined
  is_plugin?: boolean | undefined
}

export async function runZellij(args: string[], timeoutMs = 5_000): Promise<string> {
  const sessionName = process.env.ZELLIJ_SESSION_NAME?.trim()
  const zellijArgs = sessionName ? ['--session', sessionName, ...args] : args
  const result = await execFileAsync('zellij', zellijArgs, { encoding: 'utf8', timeout: timeoutMs })
  return result.stdout ?? ''
}

export async function currentPaneTabId(): Promise<number | undefined> {
  const paneId = process.env.ZELLIJ_PANE_ID
  if (!paneId)
    return undefined

  const parsedPaneId = Number(paneId)
  if (!Number.isInteger(parsedPaneId))
    return undefined

  const output = await runZellij(['action', 'list-panes', '--json'])
  let panes: ZellijPaneInfo[] = []
  try {
    const parsed = JSON.parse(output)
    panes = Array.isArray(parsed) ? parsed as ZellijPaneInfo[] : []
  }
  catch {
    return undefined
  }

  const pane = panes.find(p => !p.is_plugin && (zellijID(p.id) === parsedPaneId || zellijID(p.pane_id) === parsedPaneId))
  return zellijID(pane?.tab_id)
}

export async function listTabs(): Promise<ZellijTabInfo[]> {
  const output = await runZellij(['action', 'list-tabs', '--json'])
  try {
    const parsed = JSON.parse(output)
    return Array.isArray(parsed) ? parsed as ZellijTabInfo[] : []
  }
  catch {
    return []
  }
}

export async function currentTabTitle(): Promise<string | undefined> {
  const tabId = await currentPaneTabId()
  const tabs = await listTabs()
  if (tabId !== undefined) {
    const tab = tabs.find(t => zellijID(t.tab_id) === tabId)
    return tab?.name ?? tab?.title
  }

  if (!process.env.ZELLIJ_SESSION_NAME?.trim())
    return undefined

  const activeTab = tabs.find(tab => Boolean(tab.active) && !tab.is_plugin)
  return activeTab?.name ?? activeTab?.title
}

export async function renameTabById(tabId: number | undefined, title: string): Promise<void> {
  if (tabId === undefined)
    return

  await runZellij(['action', 'rename-tab', '--tab-id', String(tabId), title])
}
