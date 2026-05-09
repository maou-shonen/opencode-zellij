import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { debug } from './utils/debug.js'

export const PACKAGE_NAME = 'opencode-zellij'

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/-/package/opencode-zellij/dist-tags'
const FETCH_TIMEOUT_MS = 5_000
const INSTALL_TIMEOUT_MS = 60_000

const defaultExecFile = promisify(execFile)

function packageDir(installRoot: string): string {
  return join(installRoot, 'node_modules', PACKAGE_NAME)
}

interface InstalledPackageMetadata {
  name: string | undefined
  version: string | undefined
}

async function installedPackageMetadata(installRoot: string): Promise<InstalledPackageMetadata | undefined> {
  try {
    const content = await readFile(join(packageDir(installRoot), 'package.json'), 'utf8')
    const pkg: unknown = JSON.parse(content)
    if (isRecord(pkg)) {
      return {
        name: typeof pkg.name === 'string' ? pkg.name : undefined,
        version: typeof pkg.version === 'string' ? pkg.version : undefined,
      }
    }
  }
  catch {
    // Missing or unreadable package metadata is handled by the caller.
  }
  return undefined
}

function isExpectedPackage(metadata: InstalledPackageMetadata | undefined, version: string): boolean {
  return metadata?.name === PACKAGE_NAME && metadata.version === version
}

async function removeInstalledPackage(installRoot: string): Promise<void> {
  await rm(packageDir(installRoot), { force: true, recursive: true })
}

export interface InstallContext {
  installRoot: string
  cacheSpec: string
  currentVersion: string
}

export async function findInstallContext(importMetaUrl: string): Promise<InstallContext | undefined> {
  let startPath: string
  try {
    startPath = fileURLToPath(importMetaUrl)
  }
  catch (cause) {
    debug('invalid import.meta.url', cause instanceof Error ? cause.message : String(cause))
    return undefined
  }

  let dir = dirname(startPath)

  while (true) {
    const isPluginDir = dir.endsWith(`/node_modules/${PACKAGE_NAME}`) || dir.endsWith(`\\node_modules\\${PACKAGE_NAME}`)
    if (isPluginDir) {
      const packageJsonPath = join(dir, 'package.json')
      try {
        const content = await readFile(packageJsonPath, 'utf8')
        const pkg: unknown = JSON.parse(content)
        if (
          isRecord(pkg)
          && pkg.name === PACKAGE_NAME
          && typeof pkg.version === 'string'
          && pkg.version.length > 0
        ) {
          const installRoot = dirname(dirname(dir))
          const rootPackageJson = join(installRoot, 'package.json')
          if (existsSync(rootPackageJson)) {
            return { installRoot, cacheSpec: basename(installRoot), currentVersion: pkg.version }
          }
        }
      }
      catch {
        // ignore unreadable or invalid package.json
      }
    }

    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isAutoUpdatableSpec(spec: string | undefined): boolean {
  if (spec === PACKAGE_NAME)
    return true
  if (spec === `${PACKAGE_NAME}@latest`)
    return true
  return false
}

export async function fetchLatestVersion(fetchImpl: typeof fetch = globalThis.fetch): Promise<string | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const response = await fetchImpl(NPM_REGISTRY_URL, { signal: controller.signal })
    clearTimeout(timeout)
    if (!response.ok) {
      debug(`npm registry returned ${response.status}`)
      return undefined
    }
    const data: unknown = await response.json()
    if (isRecord(data) && typeof data.latest === 'string') {
      return data.latest
    }
    debug('npm registry response missing latest tag')
    return undefined
  }
  catch (cause) {
    clearTimeout(timeout)
    debug('failed to fetch latest version', cause instanceof Error ? cause.message : String(cause))
    return undefined
  }
}

export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd: string, timeout?: number },
) => Promise<{ stdout: string, stderr: string }>

export async function runNpmInstall(
  installRoot: string,
  version: string,
  execImpl: ExecFileLike = defaultExecFile as ExecFileLike,
): Promise<boolean> {
  debug(`updating ${PACKAGE_NAME} to ${version} in ${installRoot}`)

  try {
    const shouldVerifyInstalledPackage = await installedPackageMetadata(installRoot) !== undefined
    const install = () => execImpl(
      'npm',
      ['install', `${PACKAGE_NAME}@${version}`, '--save-exact', '--ignore-scripts'],
      { cwd: installRoot, timeout: INSTALL_TIMEOUT_MS },
    )

    await install()

    if (!shouldVerifyInstalledPackage) {
      debug(`updated ${PACKAGE_NAME} to ${version}`)
      return true
    }

    const installedPackage = await installedPackageMetadata(installRoot)
    if (isExpectedPackage(installedPackage, version)) {
      debug(`updated ${PACKAGE_NAME} to ${version}`)
      return true
    }

    debug(`npm install left stale or invalid ${PACKAGE_NAME} (${installedPackage?.name ?? '<missing>'}@${installedPackage?.version ?? '<missing>'}); reinstalling ${version}`)
    await removeInstalledPackage(installRoot)
    await install()

    const reinstalledPackage = await installedPackageMetadata(installRoot)
    if (isExpectedPackage(reinstalledPackage, version)) {
      debug(`updated ${PACKAGE_NAME} to ${version}`)
      return true
    }

    debug(`npm install verification failed: expected ${PACKAGE_NAME}@${version}, found ${reinstalledPackage?.name ?? '<missing>'}@${reinstalledPackage?.version ?? '<missing>'}`)
    return false
  }
  catch (cause) {
    debug('npm install failed', cause instanceof Error ? cause.message : String(cause))
    return false
  }
}

export interface CheckOptions {
  importMetaUrl: string
  fetchImpl?: typeof fetch
  execImpl?: ExecFileLike
}

export type UpdateResult
  = | { type: 'skipped', reason: string }
    | { type: 'up-to-date', currentVersion: string }
    | { type: 'updated', fromVersion: string, toVersion: string }
    | { type: 'failed', currentVersion: string, latestVersion: string, reason: string }

export async function checkAndUpdate(options: CheckOptions): Promise<UpdateResult> {
  const context = await findInstallContext(options.importMetaUrl)
  if (!context) {
    debug('skipping auto-update: not installed from npm')
    return { type: 'skipped', reason: 'not installed from npm' }
  }

  if (!isAutoUpdatableSpec(context.cacheSpec)) {
    debug(`skipping auto-update: cache spec is pinned or unknown (${context.cacheSpec})`)
    return { type: 'skipped', reason: `cache spec is pinned or unknown (${context.cacheSpec})` }
  }

  const latest = await fetchLatestVersion(options.fetchImpl)
  if (!latest) {
    debug('skipping auto-update: could not determine latest version')
    return { type: 'skipped', reason: 'could not determine latest version' }
  }

  if (latest === context.currentVersion) {
    debug(`auto-update: already on latest ${latest}`)
    return { type: 'up-to-date', currentVersion: context.currentVersion }
  }

  const success = await runNpmInstall(context.installRoot, latest, options.execImpl)
  if (success) {
    debug(`updated ${PACKAGE_NAME} from ${context.currentVersion} to ${latest}`)
    return { type: 'updated', fromVersion: context.currentVersion, toVersion: latest }
  }

  return { type: 'failed', currentVersion: context.currentVersion, latestVersion: latest, reason: 'npm install failed' }
}
