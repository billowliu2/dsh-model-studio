#!/usr/bin/env node
/**
 * Regenerate the provider-defaults snapshot the create form pre-fills from.
 *
 * The protocol and endpoint of a provider the installed catalog ships are not
 * exposed to a plugin through any interface — the discovery answer carries only
 * model metadata, and the provider directory carries only ids and settings
 * paths. So the values are read once, here, straight out of the installed
 * catalog, and inlined into the browser half between two markers.
 *
 * Two rules keep the snapshot from becoming a second source of truth, which is
 * the failure mode this kind of table usually has:
 *
 *   1. A pre-filled value that the user does not touch is never written to
 *      `settings.yaml` (see `createOps`). The route keeps inheriting from the
 *      catalog, so a stale snapshot cannot break a request.
 *   2. `api` is recorded only when every model of that provider declares the
 *      same protocol *and* the settings schema accepts it. Naming a protocol on
 *      a catalog route rebuilds the provider over that protocol instead of
 *      reusing the catalog one, so an unnecessary value is not free.
 *
 * Usage:
 *   node scripts/generate-catalog-defaults.mjs [--profile web] [--dsh-home <dir>]
 *                                              [--check] [--quiet]
 *
 * `--check` verifies that lib/client.js already carries the current snapshot and
 * exits non-zero otherwise, which is what a release check would run.
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const BEGIN = '// <catalog-provider-defaults>'
const END = '// </catalog-provider-defaults>'
/** The protocols the settings schema accepts, in the adapter's own order. */
const ALLOWED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

const options = parseArguments(process.argv.slice(2))
const repository = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const clientPath = join(repository, 'lib', 'client.js')
const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const profileDir = join(dshHome, 'profiles', options.profile)

if (!existsSync(join(profileDir, 'package.json'))) {
  fail(`profile "${options.profile}" not found at ${profileDir} — pass --profile <name> or --dsh-home <dir>`)
}

const packageDir = locatePackage(profileDir, '@earendil-works', 'pi-ai')
if (packageDir === undefined) fail(`@earendil-works/pi-ai not found above ${profileDir}`)

const version = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')).version
const catalog = await import(pathToFileURL(join(packageDir, 'dist', 'providers', 'all.js')).href)

const providers = catalog.builtinProviders()
const generatedAt = new Date(catalog.getBuiltinModelDataGeneratedAt()).toISOString()
const entries = {}
const skipped = { protocol: [], endpoint: [] }

for (const provider of providers) {
  const models = catalog.getBuiltinModels(provider.id)
  const protocols = [...new Set(models.map((model) => model.api).filter((api) => typeof api === 'string'))]
  const entry = { models: models.length }
  if (typeof provider.name === 'string' && provider.name.length > 0) entry.name = provider.name
  const single = protocols.length === 1 ? protocols[0] : undefined
  if (single !== undefined && ALLOWED_PROTOCOLS.includes(single)) entry.api = single
  else skipped.protocol.push(`${provider.id}(${protocols.length === 0 ? 'none' : protocols.join('|')})`)
  if (typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0) entry.baseUrl = provider.baseUrl
  else skipped.endpoint.push(provider.id)
  entries[provider.id] = entry
}

const sorted = Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right)))
const snapshot = {
  generatedAt,
  source: `@earendil-works/pi-ai@${version}`,
  providers: sorted,
}
const block = render(snapshot)

const client = await readFile(clientPath, 'utf8')
// Match the whole marked region — tolerating a duplicated end marker or a missing
// blank line left by an earlier run — and re-emit it with one blank line before
// whatever follows, so the replacement is idempotent byte for byte.
const pattern = new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}(?:\\n${escapeRegExp(END)})*(?:\\n[ \\t]*)*`)
if (!pattern.test(client)) fail(`${clientPath} carries no ${BEGIN} … ${END} block to replace`)
const next = client.replace(pattern, `${block.trimEnd()}\n\n\t\t`)

if (options.check) {
  const same = next === client
  if (!options.quiet) {
    process.stdout.write(same
      ? `catalog-defaults: up to date (${Object.keys(sorted).length} providers, snapshot ${generatedAt})\n`
      : 'catalog-defaults: stale — run node scripts/generate-catalog-defaults.mjs\n')
  }
  process.exit(same ? 0 : 1)
}

if (next !== client) await writeFile(clientPath, next, 'utf8')

if (!options.quiet) {
  const withApi = Object.values(sorted).filter((entry) => entry.api !== undefined).length
  const withBase = Object.values(sorted).filter((entry) => entry.baseUrl !== undefined).length
  process.stdout.write(`catalog-defaults: ${Object.keys(sorted).length} providers from ${snapshot.source}\n`)
  process.stdout.write(`  snapshot date: ${generatedAt}\n`)
  process.stdout.write(`  with protocol: ${withApi}; with endpoint: ${withBase}\n`)
  process.stdout.write(`  no protocol recorded: ${skipped.protocol.length === 0 ? 'none' : skipped.protocol.join(', ')}\n`)
  process.stdout.write(`  no endpoint recorded: ${skipped.endpoint.length === 0 ? 'none' : skipped.endpoint.join(', ')}\n`)
  process.stdout.write(`  ${next === client ? 'unchanged' : 'updated'} ${clientPath}\n`)
}

/** Render the snapshot as one readable object literal, keys sorted and stable. */
function render(snapshot) {
  const lines = [
    BEGIN,
    '// Generated by scripts/generate-catalog-defaults.mjs — do not edit by hand.',
    '//',
    `// Protocol and endpoint of every provider the installed catalog ships, read from`,
    `// ${snapshot.source} (catalog data generated ${snapshot.generatedAt}).`,
    '// The create form pre-fills from this so a preset usually needs only an API key;',
    '// a pre-filled value the user leaves alone is never written to settings.yaml, so',
    '// a stale snapshot can only ever cost a misleading placeholder.',
    'const CATALOG_DEFAULTS = Object.freeze({',
    `\tgeneratedAt: ${JSON.stringify(snapshot.generatedAt)},`,
    `\tsource: ${JSON.stringify(snapshot.source)},`,
    '\tproviders: Object.freeze({',
  ]
  for (const [id, entry] of Object.entries(snapshot.providers)) {
    const fields = []
    if (entry.name !== undefined) fields.push(`name: ${JSON.stringify(entry.name)}`)
    if (entry.api !== undefined) fields.push(`api: ${JSON.stringify(entry.api)}`)
    if (entry.baseUrl !== undefined) fields.push(`baseUrl: ${JSON.stringify(entry.baseUrl)}`)
    fields.push(`models: ${entry.models}`)
    lines.push(`\t\t${JSON.stringify(id)}: Object.freeze({ ${fields.join(', ')} }),`)
  }
  lines.push('\t}),', '})', END)
  return `${lines.join('\n')}\n`
}

/** Find an installed package by walking up from the profile directory. */
function locatePackage(from, scope, name) {
  let directory = from
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'node_modules', scope, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = resolve(directory, '..')
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function parseArguments(argv) {
  const parsed = { profile: 'web', check: false, quiet: false }
  const takesValue = { '--profile': 'profile', '--dsh-home': 'dshHome' }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-h' || argument === '--help') {
      process.stdout.write(usage())
      process.exit(0)
    }
    if (argument === '--check') {
      parsed.check = true
      continue
    }
    if (argument === '--quiet') {
      parsed.quiet = true
      continue
    }
    const key = takesValue[argument]
    if (key === undefined) fail(`unknown option "${argument}"\n\n${usage()}`)
    const value = argv[index + 1]
    if (value === undefined) fail(`${argument} needs a value`)
    parsed[key] = value
    index += 1
  }
  return parsed
}

function usage() {
  return `Regenerate the catalog provider-defaults snapshot inlined into lib/client.js.

Usage:
  node scripts/generate-catalog-defaults.mjs [options]

Options:
  --profile <name>   profile whose installed catalog to read   (default: web)
  --dsh-home <dir>   DSH home               (default: $DSH_HOME, else ~/.dsh)
  --check            verify the snapshot is current, change nothing
  --quiet            print nothing on success
  -h, --help         print this text
`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message) {
  process.stderr.write(`generate-catalog-defaults: ${message}\n`)
  process.exit(1)
}
