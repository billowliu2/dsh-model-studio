#!/usr/bin/env node
/**
 * Install (or remove) this plugin in one DSH profile — offline, without pnpm.
 *
 * The canonical path is `dsh plugin --profile <name> add <spec>`, which forwards
 * to pnpm and then reconciles the profile's bundle list. This script performs the
 * same two steps directly, which is what makes it useful on a machine without
 * pnpm or without network access — and on Windows, where pnpm's `link:` spec
 * materializes a directory reparse point that some processes cannot traverse,
 * making the freshly linked package unreadable to the loader.
 *
 * It never edits a profile you did not name, and it never touches
 * `settings.yaml`: the provider profiles you configured stay yours.
 *
 * Usage:
 *   node scripts/install.mjs [options]
 *
 * Options:
 *   --profile <name>      profile to install into              (default: web)
 *   --dsh-home <dir>      DSH home             (default: $DSH_HOME, else ~/.dsh)
 *   --source <dir>        checkout to install from     (default: this repository)
 *   --mode <copy|link>    copy the package in (default) or link the checkout
 *   --uninstall           remove the plugin from the profile instead
 *   --dry-run             report what would change, change nothing
 *   -h, --help            print this text
 *
 * Examples:
 *   node scripts/install.mjs --dry-run
 *   node scripts/install.mjs --profile web
 *   node scripts/install.mjs --profile model-studio-dev --mode link
 *   node scripts/install.mjs --profile web --uninstall
 */
import { cp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-model-studio'
/** Files the profile needs; the rest of the checkout is development material. */
const PACKAGE_FILES = ['package.json', 'cordis.patch.yml', 'LICENSE']
/**
 * A structural marker the browser bundle must contain. Checking it turns a
 * partial or stale copy into a loud failure instead of a profile that silently
 * serves the previous build.
 */
const BUNDLE_MARKER = '__ModuleLoader__'

const options = parseArguments(process.argv.slice(2))
if (options.help) {
  process.stdout.write(usage())
  process.exit(0)
}

const source = resolve(options.source ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileDir = join(dshHome, 'profiles', options.profile)
const manifestPath = join(profileDir, 'package.json')
const target = join(profileDir, 'node_modules', PACKAGE_NAME)

const steps = []
let manifest

if (options.uninstall) {
  if (!(await exists(manifestPath))) fail(`profile "${options.profile}" does not exist at ${profileDir}`)
  manifest = await readManifest(manifestPath)
  steps.push(`remove ${target}`)
  if (manifest.dependencies?.[PACKAGE_NAME] !== undefined) steps.push(`drop the "${PACKAGE_NAME}" dependency`)
  if ((manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME)) steps.push(`drop the "${PACKAGE_NAME}" bundle layer`)
} else {
  if (!(await exists(join(source, 'package.json')))) fail(`${source} does not look like the plugin checkout`)
  if (!(await exists(join(source, 'lib', 'client.js')))) fail(`${source} has no lib/client.js to install`)
  if (!(await exists(manifestPath))) {
    steps.push(`initialize profile "${options.profile}" from the shipped web template`)
  }
  steps.push(options.mode === 'link'
    ? `link ${source} -> ${target}`
    : `copy ${source} -> ${target}`)
  steps.push(`declare the "${PACKAGE_NAME}" dependency and bundle layer in ${manifestPath}`)
}

process.stdout.write(`${options.dryRun ? 'dry run — ' : ''}profile "${options.profile}" at ${profileDir}\n`)
for (const step of steps) process.stdout.write(`  - ${step}\n`)

if (!options.dryRun) {
  if (options.uninstall) {
    await rm(target, { recursive: true, force: true })
    manifest = await readManifest(manifestPath)
    if (manifest.dependencies !== undefined) delete manifest.dependencies[PACKAGE_NAME]
    if (Array.isArray(manifest.dsh?.profile?.bundles)) {
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME)
    }
    await writeManifest(manifestPath, manifest)
    process.stdout.write(`removed ${PACKAGE_NAME} from profile "${options.profile}"\n`)
    process.stdout.write('Your providers, keys and model capabilities were not touched.\n')
  } else {
    if (!(await exists(manifestPath))) await initializeProfile(options.profile, profileDir)
    await materialize(source, target, options.mode)
    await verifyBundle(target)
    manifest = await readManifest(manifestPath)
    const spec = `${options.mode === 'link' ? 'link' : 'file'}:${source}`
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [PACKAGE_NAME]: spec }
    manifest.dsh = { ...(manifest.dsh ?? {}) }
    manifest.dsh.profile = { ...(manifest.dsh.profile ?? {}) }
    const bundles = manifest.dsh.profile.bundles ?? []
    if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
    manifest.dsh.profile.bundles = bundles
    await writeManifest(manifestPath, manifest)
    process.stdout.write(`installed ${PACKAGE_NAME} into profile "${options.profile}" (${options.mode})\n`)
    process.stdout.write(`  bundle layers: ${bundles.join(', ')}\n`)
    if (options.mode === 'link' && process.platform === 'win32') {
      process.stdout.write('  note: link mode installs a directory junction, which some Windows processes cannot read\n')
      process.stdout.write('        (the loader then reports EPERM) — copy mode is the safer default here\n')
    }
    if (manifest.dsh.profile.patchReload !== undefined) {
      process.stdout.write(`  patchReload: ${manifest.dsh.profile.patchReload}\n`)
    }
    verifyComposition(options.profile)
    process.stdout.write([
      '',
      'Next:',
      `  1. restart the app:  dsh --profile ${options.profile}${options.profile === 'web' ? '   (or: dsh web)' : ''}`,
      '  2. hard-refresh the browser (Ctrl+Shift+R) so the client bundle is re-fetched',
      '  3. open it from the sidebar button above Settings, or Settings -> Model Studio',
      '',
    ].join('\n'))
  }
}

/** Parse the small option surface; unknown flags are refused rather than ignored. */
function parseArguments(argv) {
  const parsed = { profile: 'web', mode: 'copy', uninstall: false, dryRun: false, help: false }
  const takesValue = { '--profile': 'profile', '--dsh-home': 'dshHome', '--source': 'source', '--mode': 'mode' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') {
      parsed.help = true
      continue
    }
    if (argument === '--uninstall') {
      parsed.uninstall = true
      continue
    }
    if (argument === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    const key = takesValue[argument]
    if (key === undefined) fail(`unknown option "${argument}"\n\n${usage()}`)
    const value = argv[index + 1]
    if (value === undefined) fail(`${argument} needs a value`)
    parsed[key] = value
    index += 1
  }
  if (parsed.mode !== 'copy' && parsed.mode !== 'link') fail('--mode must be "copy" or "link"')
  // The profile name becomes a directory name and is interpolated into the
  // launcher command line, so it is restricted rather than escaped.
  if (!/^[A-Za-z0-9._-]+$/.test(parsed.profile)) fail(`--profile "${parsed.profile}" is not a valid profile name`)
  return parsed
}

/** The help text, kept as one literal so `--help` and errors cannot drift apart. */
function usage() {
  return `
Install ${PACKAGE_NAME} into a DSH profile without pnpm or a network.

Usage:
  node scripts/install.mjs [options]

Options:
  --profile <name>      profile to install into              (default: web)
  --dsh-home <dir>      DSH home             (default: $DSH_HOME, else ~/.dsh)
  --source <dir>        checkout to install from     (default: this repository)
  --mode <copy|link>    copy the package in (default) or link the checkout
  --uninstall           remove the plugin from the profile instead
  --dry-run             report what would change, change nothing
  -h, --help            print this text

Examples:
  node scripts/install.mjs --dry-run
  node scripts/install.mjs --profile web
  node scripts/install.mjs --profile model-studio-dev --mode link
  node scripts/install.mjs --profile web --uninstall
`
}

/** Materialize the package: copy the files it ships, or link the whole checkout. */
async function materialize(from, to, mode) {
  await rm(to, { recursive: true, force: true })
  await mkdir(dirname(to), { recursive: true })
  if (mode === 'link') {
    // `junction` needs no elevation on Windows; elsewhere a directory symlink is
    // what pnpm's own `link:` spec would have produced.
    await symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    return
  }
  await mkdir(to, { recursive: true })
  const entries = await Promise.all(PACKAGE_FILES.map(async (name) => [name, await exists(join(from, name))]))
  for (const [name, present] of entries) {
    if (present) await cp(join(from, name), join(to, name))
  }
  // Only the two shipped halves are needed at runtime; copying just them keeps a
  // profile install to a few hundred kilobytes.
  await cp(join(from, 'lib'), join(to, 'lib'), { recursive: true })
}

/** Prove the installed package is a usable bundle rather than a partial copy. */
async function verifyBundle(directory) {
  const clientPath = join(directory, 'lib', 'client.js')
  const client = await readFile(clientPath, 'utf8')
  if (!client.includes(BUNDLE_MARKER)) {
    fail(`${clientPath} does not look like the browser bundle (no "${BUNDLE_MARKER}") — the copy is stale or partial`)
  }
  const host = await readFile(join(directory, 'lib', 'index.js'), 'utf8')
  if (host.trim().length === 0) fail(`${join(directory, 'lib', 'index.js')} is empty`)
}

/** Initialize a profile the same way the launcher would, then re-check. */
async function initializeProfile(profile, directory) {
  process.stdout.write(`initializing profile "${profile}" from the shipped web template...\n`)
  const result = spawnSync(`dsh --profile ${profile} --from-default-profile web --dump-config`, {
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: true,
  })
  if (result.error?.code === 'ENOENT') fail('dsh is not on PATH — boot the profile once, then re-run this script')
  if (result.error !== undefined) throw result.error
  if (!(await exists(join(directory, 'package.json')))) fail(`profile "${profile}" was not created at ${directory}`)
}

/** Read the composed profile tree back, proving the bundle layer landed. */
function verifyComposition(profile) {
  const result = spawnSync(`dsh --profile ${profile} --dump-config`, { encoding: 'utf8', shell: true })
  if (result.error?.code === 'ENOENT' || typeof result.stdout !== 'string') return
  const row = result.stdout.split('\n').find((line) => line.trim().startsWith(`name: ${PACKAGE_NAME}`))
  process.stdout.write(row === undefined
    ? `  note: "${PACKAGE_NAME}" is not in the composed tree — check ${manifestPath}\n`
    : `  composed: ${row.trim()}\n`)
}

async function readManifest(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`)
  }
}

async function writeManifest(path, manifest) {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function fail(message) {
  process.stderr.write(`${PACKAGE_NAME}: ${message}\n`)
  process.exit(1)
}
