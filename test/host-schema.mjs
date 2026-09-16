/**
 * Host-half schema check.
 *
 * The plugin carries no dependencies: `@deepseek-ai/schemastery` is a peer
 * resolved from the DSH install that mounts the plugin. So this test resolves
 * schemastery the same way (through the profile's own module graph) and rebuilds
 * the exact schema `lib/index.js` registers, proving the shapes a fresh install
 * sees resolve without throwing — an exception there would abort the mount.
 *
 * Usage:
 *   node test/host-schema.mjs <profile-dir>
 *   node test/host-schema.mjs "$env:USERPROFILE\.dsh\profiles\web"
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const profileDir = resolve(process.argv[2] ?? process.cwd())
if (!existsSync(join(profileDir, 'package.json'))) {
  console.error(`host-schema: ${profileDir} is not a profile directory (no package.json)`)
  process.exit(2)
}

/** Resolve the peer exactly as the plugin's own `lib/index.js` would. */
const require = createRequire(join(profileDir, 'package.json'))
let z
try {
  z = require('@deepseek-ai/schemastery')
  z = z.default ?? z
} catch (error) {
  console.error(`host-schema: cannot resolve @deepseek-ai/schemastery from ${profileDir}: ${error.message}`)
  process.exit(2)
}

// --- the schema, exactly as lib/index.js declares it -------------------------
const ProviderMeta = z.object({
  note: z.string().default(''),
  homepage: z.string().default(''),
  icon: z.string().default(''),
  tags: z.array(z.string()).default([]),
})

const StudioSchema = z.object({
  providers: z.dict(ProviderMeta),
  ui: z.object({
    lastProvider: z.string().default(''),
    launcher: z.string().default('footer'),
  }),
})

const failures = []
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.error(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log(`host-schema: schemastery resolved from ${profileDir}`)

// An empty document is what a fresh install resolves: every section absent.
const empty = StudioSchema({})
check('empty document resolves', empty !== null && typeof empty === 'object')
check('providers defaults to an empty dict', JSON.stringify(empty.providers) === '{}', JSON.stringify(empty.providers))
check('ui.lastProvider defaults to empty', empty.ui?.lastProvider === '', JSON.stringify(empty.ui))
check('ui.launcher defaults to footer', empty.ui?.launcher === 'footer', JSON.stringify(empty.ui))

// A populated document is what the browser half writes.
const full = StudioSchema({
  providers: { 'opencode-go': { note: '公司专用账号', homepage: 'https://opencode.ai', tags: ['team'] } },
  ui: { lastProvider: 'opencode-go' },
})
check('provider metadata resolves', full.providers['opencode-go']?.note === '公司专用账号', JSON.stringify(full.providers))
check('icon defaults inside a provider entry', full.providers['opencode-go']?.icon === '')
check('an absent ui key takes its default', full.ui?.launcher === 'footer')

// Junk must be refused rather than silently stored.
let refused = false
try {
  StudioSchema({ providers: { broken: { note: 42 } } })
} catch {
  refused = true
}
check('a non-string note is refused', refused)

// --- the official llm-pi-ai section, resolved from the same profile ----------
//
// A provider preset writes the *minimum* that makes a catalog route work: the
// route id plus a credential reference, with no protocol, no endpoint and no
// model list (an absent `models` serves the installed catalog). That claim is
// only worth making if the real schema accepts it, so it is validated here
// against the shipped `Config` rather than asserted in a comment.
let PiAiConfig
try {
  const mod = require('@deepseek-ai/dsh-llm-pi-ai')
  PiAiConfig = mod.Config ?? mod.default?.Config
} catch (error) {
  check('llm-pi-ai resolves from the profile', false, error.message)
}

if (PiAiConfig !== undefined) {
  check('llm-pi-ai exports its settings schema', typeof PiAiConfig === 'function' || typeof PiAiConfig === 'object')
  const minimal = PiAiConfig({ providers: { moonshotai: { apiKeyEnv: 'MOONSHOTAI_API_KEY' } } })
  check('a preset needs only a credential reference',
    minimal?.providers?.moonshotai?.apiKeyEnv === 'MOONSHOTAI_API_KEY', JSON.stringify(minimal?.providers?.moonshotai))
  check('an absent endpoint and protocol resolve to nothing overridden',
    minimal?.providers?.moonshotai?.baseURL === undefined && minimal?.providers?.moonshotai?.api === undefined,
    JSON.stringify(minimal?.providers?.moonshotai))
  check('an absent model list resolves to an empty list, not a requirement',
    Array.isArray(minimal?.providers?.moonshotai?.models) && minimal.providers.moonshotai.models.length === 0,
    JSON.stringify(minimal?.providers?.moonshotai?.models))
  check('the adapter fills endpoint-neutral defaults for an undeclared route',
    minimal?.providers?.moonshotai?.defaultContextWindow === 262144
    && JSON.stringify(minimal?.providers?.moonshotai?.defaultInput) === JSON.stringify(['text']),
    JSON.stringify(minimal?.providers?.moonshotai))
  const withModel = PiAiConfig({ providers: { mine: { api: 'openai-completions', baseURL: 'https://x/v1', models: [{ id: 'm' }] } } })
  check('a hand-declared route still validates', withModel?.providers?.mine?.models?.[0]?.id === 'm')
  // A level map that offers nothing but `off` passes schemastery and is refused
  // by the *adapter* at mount ("offers no level beyond off"). That split is
  // exactly why the studio validates the level set before writing.
  const offOnly = PiAiConfig({ providers: { m: { models: [{ id: 'x', reasoningEfforts: { off: null } }] } } })
  check('a levels map with nothing but off passes the schema, so the studio must check it',
    offOnly?.providers?.m?.models?.[0]?.reasoningEfforts?.off === null,
    JSON.stringify(offOnly?.providers?.m?.models?.[0]?.reasoningEfforts))
}

console.log(failures.length === 0 ? 'host-schema: ok' : `host-schema: ${failures.length} failure(s)`)
process.exit(failures.length === 0 ? 0 : 1)
