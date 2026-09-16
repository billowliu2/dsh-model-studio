/**
 * Data-layer tests for the browser half (M1/M2 logic).
 *
 * These exercise the pure functions the panel relies on — provider derivation,
 * the path ops a save produces, validation, credential plumbing and the remote
 * envelope — through the real bundle, loaded exactly as the shell loads it. No
 * browser and no DSH boot required.
 *
 * Run: node test/api.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await readFile(resolve(root, 'lib/client.js'), 'utf8')

let registration
const sandbox = { window: { __ModuleLoader__: { load: (entry) => { registration = entry } } }, console, URL, JSON }
vm.createContext(sandbox)
vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' })

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useCallback: (fn) => fn,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useSyncExternalStore: (_s, getSnapshot) => getSnapshot(),
}
const internals = registration.factory((specifier) => (specifier === 'react' ? react : undefined)).__internals

const failures = []
let count = 0
function check(name, condition, detail = '') {
  count += 1
  if (condition) return
  failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
}

const {
  readProviders,
  basicOps,
  createOps,
  deriveKeyRef,
  isPrintableAsciiKey,
  isEndpoint,
  unwrapResult,
  errorText,
  saveApiKey,
  describeKey,
  serviceOf,
  PROTOCOLS,
} = internals

// ------------------------------------------------------------ readProviders
const piSnapshot = {
  status: 'ready',
  revision: 7,
  value: {
    providers: {
      'opencode-go': {
        displayName: 'opencodego',
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKeyEnv: 'GO_API_KEY',
        headers: { 'x-opencode-session': 'dsh' },
        models: [
          { id: 'deepseek-v4.1-flash', contextWindow: 512000, input: ['text', 'image'] },
          { id: 'qwen3.8-flash', reasoningEfforts: { off: null, high: 'high' } },
        ],
      },
      'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
    },
  },
  user: {
    providers: {
      'opencode-go': { displayName: 'opencodego', baseURL: 'https://opencode.ai/zen/go/v1' },
    },
  },
}
const metaSnapshot = {
  status: 'ready',
  value: { providers: { 'opencode-go': { note: '公司专用账号', homepage: 'https://opencode.ai' } } },
}
const directory = [
  { provider: 'opencode-go', declared: true },
  { provider: 'zai-coding-cn', declared: false },
  { provider: 'dormant-catalog-route', declared: false },
]

const views = readProviders(piSnapshot, metaSnapshot, directory)
check('one view per configured route only', views.length === 2, `got ${views.length}: ${views.map((v) => v.route).join(',')}`)
const go = views.find((v) => v.route === 'opencode-go')
const zai = views.find((v) => v.route === 'zai-coding-cn')
check('route order follows configuration', views[0].route === 'opencode-go')
check('displayName is surfaced', go.displayName === 'opencodego')
check('a hand-declared route is flagged', go.declared === true)
check('a catalog route is not flagged declared', zai.declared === false)
check('settings values are read for a catalog route', zai.displayName === 'zai-coding-cn' && zai.apiKeyEnv === 'ZAI_CODING_CN_API_KEY', JSON.stringify(zai))
check('a route the catalog does not ship shows its directory diagnostic', readProviders(
  { status: 'ready', value: { providers: { broken: {} } }, user: {} },
  undefined,
  [{ provider: 'broken', declared: true, error: 'catalog resolution failed' }],
)[0].error === 'catalog resolution failed')
check('user-layer overrides are listed', JSON.stringify(go.overridden) === JSON.stringify(['displayName', 'baseURL']), JSON.stringify(go.overridden))
check('an all-inherited route reports no overrides', zai.overridden.length === 0)
check('explicit models are materialized', go.models.length === 2)
check('a route without models inherits the catalog', zai.inheritsCatalog === true)
check('an inherited route lists no models', zai.models.length === 0)
check('model context window is read', go.models[0].contextWindow === 512000)
check('model input modalities are read', JSON.stringify(go.models[0].input) === JSON.stringify(['text', 'image']))
check('an undeclared reasoning block reports inherited', go.models[0].reasoning === 'inherited')
check('a declared reasoning block reports declared', go.models[1].reasoning === 'declared')
check('studio metadata is joined onto the view', go.note === '公司专用账号' && go.homepage === 'https://opencode.ai')
check('a route with no metadata gets empty strings', zai.note === '' && zai.homepage === '')
check('an unavailable namespace yields no providers', readProviders({ status: 'unavailable' }, metaSnapshot, directory).length === 0)
check('a missing snapshot yields no providers', readProviders(undefined, undefined, []).length === 0)

// ----------------------------------------------------------------- basicOps
const ops = basicOps('opencode-go', { displayName: 'OpenCode Go', api: 'openai-completions', baseURL: 'https://opencode.ai/zen/go/v1/' })
check('basics produce three path ops', ops.length === 3, JSON.stringify(ops))
check('paths address the providers dict', JSON.stringify(ops.map((op) => op.path)) === JSON.stringify([
  ['providers', 'opencode-go', 'displayName'],
  ['providers', 'opencode-go', 'api'],
  ['providers', 'opencode-go', 'baseURL'],
]))
check('every basic op is a set here', ops.every((op) => op.op === 'set'))
check('a trailing slash is trimmed off the endpoint', ops[2].value === 'https://opencode.ai/zen/go/v1')

const cleared = basicOps('route-x', { displayName: '', api: '', baseURL: '' })
check('a cleared field becomes an unset (inherit), never an empty string', cleared.every((op) => op.op === 'unset'), JSON.stringify(cleared))

let rejected = ''
try {
  basicOps('route-x', { displayName: 'x', api: 'openai', baseURL: '' })
} catch (error) {
  rejected = error.message
}
check('an invalid protocol literal is refused', rejected.includes('openai-completions'), rejected)

let badUrl = ''
try {
  basicOps('route-x', { displayName: 'x', api: '', baseURL: 'not-a-url' })
} catch (error) {
  badUrl = error.message
}
check('a non-URL endpoint is refused', badUrl.includes('http'), badUrl)

// ---------------------------------------------------------------- createOps
const created = createOps({ route: 'acme-gateway', displayName: 'Acme', api: 'openai-completions', baseURL: 'https://gw.acme.example/v1/', modelId: 'acme-think' })
check('creation writes the whole provider row in one op', created.length === 1 && created[0].op === 'set' && JSON.stringify(created[0].path) === JSON.stringify(['providers', 'acme-gateway']))
check('the created row carries protocol, endpoint and one model', created[0].value.api === 'openai-completions'
  && created[0].value.baseURL === 'https://gw.acme.example/v1'
  && created[0].value.models[0].id === 'acme-think')
for (const [route, why] of [['Acme', 'uppercase id'], ['acme gw', 'space in id'], ['-acme', 'leading hyphen']]) {
  let message = ''
  try {
    createOps({ route, displayName: '', api: 'openai-completions', baseURL: 'https://x.example', modelId: 'm' })
  } catch (error) {
    message = error.message
  }
  check(`creation refuses ${why}`, message !== '', `route=${route}`)
}
let noModel = ''
try {
  createOps({ route: 'acme', displayName: '', api: 'openai-completions', baseURL: 'https://x.example', modelId: '' })
} catch (error) {
  noModel = error.message
}
check('creation requires at least one model', noModel.includes('模型'), noModel)

// ------------------------------------------------------------- key helpers
check('the derived reference mirrors the stock page', deriveKeyRef('opencode-go') === 'OPENCODE_GO_API_KEY', deriveKeyRef('opencode-go'))
check('the derived reference handles punctuation', deriveKeyRef('zai.coding/cn') === 'ZAI_CODING_CN_API_KEY', deriveKeyRef('zai.coding/cn'))
check('printable ASCII keys are accepted', isPrintableAsciiKey('sk-abc123_-.~'))
check('a key with a space is refused', !isPrintableAsciiKey('sk abc'))
check('a key with a newline is refused', !isPrintableAsciiKey('sk\nabc'))
check('an empty key is refused', !isPrintableAsciiKey('   '))
check('http endpoints are accepted', isEndpoint('http://127.0.0.1:8000/v1'))
check('non-http schemes are refused', !isEndpoint('ftp://example.com'))
check('garbage is refused', !isEndpoint('example.com/v1'))

// ------------------------------------------------------------- remote glue
check('a bare value passes through unwrapResult', unwrapResult({ any: 'thing' }).any === 'thing')
check('{ok:true} yields its value', unwrapResult({ ok: true, value: 42 }) === 42)
let envelope = ''
try {
  unwrapResult({ ok: false, error: { code: 'SETTINGS_CONFLICT', message: 'moved' } })
} catch (error) {
  envelope = errorText(error)
}
check('{ok:false} throws with its code', envelope.includes('SETTINGS_CONFLICT') && envelope.includes('moved'), envelope)

const writes = []
const fakeScope = {
  mutate: async (ops, revision) => {
    writes.push({ ns: 'llm-pi-ai', ops, revision })
    return { ok: true, value: null }
  },
}
const fakeRemote = { credentials: { set: async (ref, key) => { writes.push({ ns: 'credentials', ref, key }); return { ok: true, value: null } } } }

await saveApiKey({ credentials: fakeRemote.credentials, scope: fakeScope, route: 'new-route', key: 'sk-secret', currentRef: '', revision: 3 })
check('a new key writes the credential first', writes[0].ns === 'credentials' && writes[0].ref === 'NEW_ROUTE_API_KEY' && writes[0].key === 'sk-secret')
check('then records the derived reference in the profile', writes[1].ns === 'llm-pi-ai'
  && JSON.stringify(writes[1].ops) === JSON.stringify([{ op: 'set', path: ['providers', 'new-route', 'apiKeyEnv'], value: 'NEW_ROUTE_API_KEY' }])
  && writes[1].revision === 3)

writes.length = 0
await saveApiKey({ credentials: fakeRemote.credentials, scope: fakeScope, route: 'opencode-go', key: 'sk-other', currentRef: 'GO_API_KEY', revision: 9 })
check('an existing reference is reused', writes.length === 1 && writes[0].ref === 'GO_API_KEY')
check('no redundant profile write when the reference already exists', writes.every((write) => write.ns !== 'llm-pi-ai'))

let keyRefused = ''
try {
  await saveApiKey({ credentials: fakeRemote.credentials, scope: fakeScope, route: 'r', key: 'bad key', currentRef: '', revision: 1 })
} catch (error) {
  keyRefused = error.message
}
check('an invalid key never reaches the credentials seam', keyRefused.includes('ASCII'), keyRefused)

let refusedWrite = ''
try {
  await saveApiKey({
    credentials: { set: async () => ({ ok: false, error: { code: 'READONLY', message: 'environment wins' } }) },
    scope: fakeScope,
    route: 'r',
    key: 'sk-x',
    currentRef: 'R_API_KEY',
    revision: 1,
  })
} catch (error) {
  refusedWrite = errorText(error)
}
check('a refused credential write surfaces its code', refusedWrite.includes('READONLY') && refusedWrite.includes('environment wins'), refusedWrite)

// ------------------------------------------------------------ dotted services
//
// `remote.llm` / `remote.credentials` are services the api gateway mounts beside
// `remote` (keyed `remote.<namespace>`); they are NOT fields of the `remote`
// service instance. Reading them off that instance is what made "获取模型列表"
// look dead — the panel had no LLM face at all and gave up silently.
const llmFace = { discoverModels: async () => ({ ok: true, value: [] }) }
check('a dotted service resolves through the context',
  serviceOf({ get: (name) => (name === 'remote.llm' ? llmFace : undefined) }, 'remote.llm') === llmFace)
check('a dotted service also resolves by property walk',
  serviceOf({ remote: { llm: llmFace } }, 'remote.llm') === llmFace)
check('the bare remote service object is not a namespace holder',
  serviceOf({ remote: {} }, 'remote.llm') === undefined)
check('an absent service resolves to undefined',
  serviceOf({ get: () => undefined }, 'remote.credentials') === undefined)
check('a missing context resolves to undefined', serviceOf(undefined, 'remote.llm') === undefined)

const noFace = await describeKey(undefined, 'GO_API_KEY')
check('describing without a credentials face reports "unknown", not "missing"',
  noFace.known === false && noFace.configured === false, JSON.stringify(noFace))
let faceRefused = ''
try {
  await saveApiKey({ credentials: undefined, scope: fakeScope, route: 'r', key: 'sk-x', currentRef: '', revision: 1 })
} catch (error) {
  faceRefused = error.copyKey ?? error.message
}
check('saving without a credentials face fails loudly', faceRefused === 'dataUnavailable', faceRefused)

check('the protocol list is exactly pi-ai\'s three', JSON.stringify(PROTOCOLS) === JSON.stringify(['openai-completions', 'openai-responses', 'anthropic-messages']), JSON.stringify(PROTOCOLS))

// ============================ M3: model capabilities ============================
const {
  THINKING_LEVELS,
  capabilityFrom,
  draftFromRaw,
  entryFromDraft,
  modelsOps,
  overrideOps,
  mergeDiscovered,
  discoveryOutcome,
  hasExplicitModels,
  overridesOf,
} = internals

check('thinking levels are pi-ai\'s seven, in order',
  JSON.stringify(THINKING_LEVELS) === JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  JSON.stringify(THINKING_LEVELS))

const visionDraft = capabilityFrom({ name: 'Flash', contextWindow: 512000, maxTokens: 32000, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' } })
check('a declared capability block reads back', visionDraft.contextWindow === '512000' && visionDraft.maxTokens === '32000', JSON.stringify(visionDraft))
check('declared image input reads as text+image', visionDraft.input === 'text+image', visionDraft.input)
check('declared efforts read as custom with their keys', visionDraft.reasoning === 'custom' && JSON.stringify(visionDraft.levels) === JSON.stringify(['off', 'high']), JSON.stringify(visionDraft.levels))
check('an empty entry reads as fully inherited', capabilityFrom(undefined).input === 'inherit' && capabilityFrom(undefined).reasoning === 'inherit')
check('text-only input reads as text', capabilityFrom({ input: ['text'] }).input === 'text')
check('reasoningEfforts:false reads as non-reasoning', capabilityFrom({ reasoningEfforts: false }).reasoning === 'off')

// The round trip must never lose a field this editor does not model.
const handwritten = {
  id: 'acme-think',
  name: 'Acme Think',
  contextWindow: 262144,
  maxTokens: 8192,
  input: ['text'],
  reasoningEfforts: { off: null, high: 'high' },
  compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' },
  thinkingBudgets: { high: 4096 },
}
const roundTripped = entryFromDraft(draftFromRaw(handwritten))
check('an untouched entry round-trips byte for byte', JSON.stringify(roundTripped) === JSON.stringify(handwritten), JSON.stringify(roundTripped))

const noVisionDraft = draftFromRaw({ id: 'm', input: ['text', 'image'], contextWindow: 1000 })
noVisionDraft.input = 'text'
const noVision = entryFromDraft(noVisionDraft)
check('choosing "text only" narrows the modalities', JSON.stringify(noVision.input) === JSON.stringify(['text']), JSON.stringify(noVision))

const inheritDraft = draftFromRaw({ id: 'm', input: ['text', 'image'], contextWindow: 1000, compat: { supportsStore: true } })
inheritDraft.input = 'inherit'
inheritDraft.contextWindow = ''
const inherited = entryFromDraft(inheritDraft)
check('choosing "inherit" deletes the field instead of writing it', inherited.input === undefined && inherited.contextWindow === undefined, JSON.stringify(inherited))
check('unmodelled fields survive an inherit-everything edit', inherited.compat?.supportsStore === true, JSON.stringify(inherited))
check('a fully inherited draft yields an empty entry (which unsets the override)', Object.keys(entryFromDraft(draftFromRaw(undefined))).length === 0)

const customDraft = capabilityFrom({ reasoningEfforts: { off: null, high: 'high' } })
const customEntry = entryFromDraft(customDraft)
check('custom levels map to wire spellings, with off sending nothing',
  customEntry.reasoningEfforts.off === null && customEntry.reasoningEfforts.high === 'high',
  JSON.stringify(customEntry.reasoningEfforts))
const nonReasoning = entryFromDraft(Object.assign(capabilityFrom({}), { reasoning: 'off' }))
check('non-reasoning is written as reasoningEfforts:false', nonReasoning.reasoningEfforts === false)

const explicitOps = modelsOps('route-x', [draftFromRaw({ id: 'a', contextWindow: 4096 }), draftFromRaw({ id: 'b' })])
check('an explicit list is written as one array', explicitOps.length === 1 && explicitOps[0].op === 'set'
  && JSON.stringify(explicitOps[0].path) === JSON.stringify(['providers', 'route-x', 'models'])
  && explicitOps[0].value.length === 2
  && explicitOps[0].value[1].id === 'b')
check('an emptied list unsets models (back to the catalog)', modelsOps('route-x', [])[0].op === 'unset')

const overrideSet = overrideOps('route-x', 'claude-sonnet-4-5', draftFromRaw({ input: ['text', 'image'] }))
check('a capability edit on a catalog model becomes a modelOverride',
  overrideSet[0].op === 'set'
  && JSON.stringify(overrideSet[0].path) === JSON.stringify(['providers', 'route-x', 'modelOverrides', 'claude-sonnet-4-5'])
  && JSON.stringify(overrideSet[0].value.input) === JSON.stringify(['text', 'image']))
check('clearing every field unsets the override', overrideOps('route-x', 'm', draftFromRaw(undefined))[0].op === 'unset')

const discovered = [
  { id: 'minimax-m3', contextWindow: 1000000 },
  { id: 'kimi-k3', name: 'Kimi K3', maxTokens: 32000 },
  { id: 'already-there' },
]
const mergedKeep = mergeDiscovered([draftFromRaw({ id: 'already-there', name: 'kept' })], ['minimax-m3', 'already-there'], discovered, false)
check('only picked, genuinely new ids are added', mergedKeep.length === 2, JSON.stringify(mergedKeep.map((d) => d.id)))
check('an existing id keeps its draft, not the fetched one', mergedKeep[0].name === 'kept', JSON.stringify(mergedKeep[0]))
check('fetched capacities land in the new draft', mergedKeep[1].contextWindow === '1000000' && mergedKeep[1].maxTokens === '', JSON.stringify(mergedKeep[1]))

const mergedThinking = mergeDiscovered([], ['kimi-k3'], discovered, true)
check('"declare thinking" seeds every level', mergedThinking[0].reasoning === 'custom' && mergedThinking[0].levels.length === 7, JSON.stringify(mergedThinking[0].levels))
check('and those levels reach the entry as wire spellings', entryFromDraft(mergedThinking[0]).reasoningEfforts.max === 'max')

check('discovery success unwraps to its models', discoveryOutcome({ ok: true, value: discovered }).kind === 'ok')
const refused = discoveryOutcome({ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'no listing endpoint' } })
check('discovery refusal carries the reason', refused.kind === 'refused' && refused.message.includes('no listing endpoint'), JSON.stringify(refused))

// ------------------------------------------------------------------ sync plan
const { syncPlan, syncDrafts, draftFromCandidate } = internals
const plan = syncPlan(['a', 'b', 'retired'], ['a', 'b', 'new-1', 'new-2'])
check('sync adds what the route serves and is missing', JSON.stringify(plan.missing) === JSON.stringify(['new-1', 'new-2']), JSON.stringify(plan.missing))
check('sync drops what the route no longer serves', JSON.stringify(plan.gone) === JSON.stringify(['retired']), JSON.stringify(plan.gone))
const inSync = syncPlan(['a'], ['a'])
check('an aligned list needs no work', inSync.missing.length === 0 && inSync.gone.length === 0)

const syncDiscovered = [{ id: 'a', name: 'A (from the endpoint)' }, { id: 'minimax-m3' }, { id: 'kimi-k3' }]
const synced = syncDrafts([draftFromRaw({ id: 'a', name: 'kept' }), draftFromRaw({ id: 'retired' })], syncDiscovered, false)
check('sync keeps a surviving draft and its edits', synced.filter((draft) => draft.id === 'a')[0]?.name === 'kept', JSON.stringify(synced))
check('sync removes the id the route no longer serves', !synced.some((draft) => draft.id === 'retired'), JSON.stringify(synced.map((draft) => draft.id)))
check('sync adds every newly served id', ['a', 'minimax-m3', 'kimi-k3'].every((id) => synced.some((draft) => draft.id === id)), JSON.stringify(synced.map((draft) => draft.id)))
check('sync never duplicates an existing id', new Set(synced.map((draft) => draft.id)).size === synced.length)
check('sync on an already aligned list changes nothing',
  JSON.stringify(syncDrafts([draftFromRaw({ id: 'a', name: 'kept' })], [{ id: 'a' }], false).map((draft) => draft.name)) === JSON.stringify(['kept']))

const candidateDraft = draftFromCandidate({ id: 'x', name: 'X', contextWindow: 4096 }, true)
check('a fetched candidate becomes an editable draft', candidateDraft.id === 'x' && candidateDraft.contextWindow === '4096', JSON.stringify(candidateDraft))
check('candidate thinking levels default to undeclared unless asked', draftFromCandidate({ id: 'y' }, false).reasoning === 'inherit'
  && candidateDraft.levels.length === 7)

check('hasExplicitModels sees a declared list', hasExplicitModels({ value: { providers: { r: { models: [{ id: 'm' }] } } } }, 'r') === true)
check('hasExplicitModels is false for a catalog route', hasExplicitModels({ value: { providers: { r: { baseURL: 'x' } } } }, 'r') === false)
check('overridesOf returns the override dict', overridesOf({ value: { providers: { r: { modelOverrides: { m: { input: ['text'] } } } } } }, 'r').m.input[0] === 'text')
check('overridesOf tolerates a missing dict', JSON.stringify(overridesOf({ value: { providers: {} } }, 'r')) === '{}')

// ============================== M4: headers ==================================
const { headersOps, isReservedHeader, HEADER_PRESETS, subtreeDiffOps, parseJsonObject } = internals

const headerOps = headersOps('route-x', [{ key: 'x-opencode-session', value: 'dsh-session' }, { key: '', value: '' }])
check('headers are written as one dict', headerOps.length === 1 && headerOps[0].op === 'set'
  && JSON.stringify(headerOps[0].path) === JSON.stringify(['providers', 'route-x', 'headers'])
  && headerOps[0].value['x-opencode-session'] === 'dsh-session')
check('blank rows are dropped', Object.keys(headerOps[0].value).length === 1)
check('an empty editor unsets headers', headersOps('route-x', [])[0].op === 'unset')

for (const [rows, why] of [
  [[{ key: 'bad name', value: 'x' }], 'a name with a space'],
  [[{ key: '', value: 'orphan' }], 'a value with no name'],
  [[{ key: '   ', value: 'orphan' }], 'a whitespace-only name'],
  [[{ key: 'x-foo', value: 'line\nbreak' }], 'a value with a newline'],
  [[{ key: 'x-foo', value: 'emoji 🚀' }], 'a non-ASCII value'],
]) {
  let message = ''
  try {
    headersOps('route-x', rows)
  } catch (error) {
    message = error.message
  }
  check(`headers refuse ${why}`, message !== '', JSON.stringify(rows))
}
check('surrounding whitespace in a name is trimmed, not refused',
  headersOps('route-x', [{ key: '  x-foo  ', value: '1' }])[0].value['x-foo'] === '1')
check('a value may be empty (a flag header)', headersOps('route-x', [{ key: 'x-empty', value: '' }])[0].value['x-empty'] === '')
check('isReservedHeader matches case-insensitively', isReservedHeader('User-Agent') && isReservedHeader('user-agent'))
check('isReservedHeader leaves custom names alone', !isReservedHeader('x-opencode-session'))
check('an OpenCode preset ships', HEADER_PRESETS.some((preset) => preset.id === 'opencode-session' && preset.headers['x-opencode-session'] !== undefined))
check('every preset carries at least one header', HEADER_PRESETS.every((preset) => Object.keys(preset.headers).length > 0))

// ========================== M4: JSON subtree diff ============================
const before = { displayName: 'go', baseURL: 'https://a', apiKeyEnv: 'GO_API_KEY', models: [{ id: 'm' }] }
const after = { displayName: 'go', baseURL: 'https://b', apiKeyEnv: 'GO_API_KEY', headers: { 'x-a': '1' } }
const diff = subtreeDiffOps('go', before, after)
check('a changed scalar is a set', diff.some((op) => op.op === 'set' && op.path.join('.') === 'providers.go.baseURL' && op.value === 'https://b'))
check('a new key is a set', diff.some((op) => op.op === 'set' && op.path.join('.') === 'providers.go.headers'))
check('a removed key is an unset', diff.some((op) => op.op === 'unset' && op.path.join('.') === 'providers.go.models'))
check('untouched keys produce no op — the credential reference survives', !diff.some((op) => op.path.join('.').endsWith('apiKeyEnv')), JSON.stringify(diff))
check('an unchanged subtree produces no ops', subtreeDiffOps('go', before, JSON.parse(JSON.stringify(before))).length === 0)
check('an emptied provider unsets every key', subtreeDiffOps('go', before, {}).length === Object.keys(before).length)

check('a JSON object parses', parseJsonObject('{"a":1}').a === 1)
for (const [text, why] of [['{oops', 'malformed JSON'], ['[]', 'an array top level'], ['"text"', 'a scalar top level'], ['null', 'null']]) {
  let message = ''
  try {
    parseJsonObject(text)
  } catch (error) {
    message = error.message
  }
  check(`the JSON editor refuses ${why}`, message !== '', text)
}

// ================== capability reference index (models.dev-style) ==================
//
// The index is built from the *installed catalog* instead of a bundled snapshot,
// which is why these checks care about the parts that a snapshot makes easy to get
// wrong: gap-filling between providers, "0 means not applicable" hygiene, a
// *ranked* match ladder rather than an arbitrary suffix scan, and never claiming
// more certainty than the match stage supports.
const {
  normalizeModelId,
  referenceAliases,
  mergeReferenceEntry,
  buildReferenceIndex,
  lookupReference,
  applyReference,
  withReference,
  fillDraftFromReference,
} = internals

const normalized = ['glm-5.2-highspeed', 'deepseek-v4-flash-0731', 'kimi-k3:free', 'qwen3-256k', 'claude-sonnet-4-5-20250929'].map(normalizeModelId)
check('normalization strips marketing and snapshot suffixes',
  JSON.stringify(normalized) === JSON.stringify(['glm-5.2', 'deepseek-v4-flash', 'kimi-k3', 'qwen3', 'claude-sonnet-4-5']), JSON.stringify(normalized))
check('normalization leaves the dotted spelling intact',
  normalizeModelId('glm-5.2') === 'glm-5.2' && normalizeModelId('qwen3.8-flash') === 'qwen3.8-flash')
check('normalization is idempotent', normalizeModelId(normalizeModelId('glm-5.2-highspeed')) === 'glm-5.2')

const aliases = referenceAliases('MiniMaxAI/MiniMax-M2.5-HighSpeed')
check('aliases carry the exact and bare spellings',
  aliases.includes('minimaxai/minimax-m2.5-highspeed') && aliases.includes('minimax-m2.5-highspeed'), JSON.stringify(aliases))
check('aliases also carry the normalized spelling', aliases.includes('minimax-m2.5'), JSON.stringify(aliases))
check('aliases also carry the p-encoded spelling',
  aliases.includes('minimaxai/minimax-m2p5') && aliases.includes('minimax-m2p5'), JSON.stringify(aliases))
check('aliases are deduplicated', new Set(aliases).size === aliases.length)
check('a blank id has no aliases', referenceAliases('   ').length === 0)

const merged = mergeReferenceEntry(
  { id: 'm', contextWindow: 128000, input: [], name: 'first' },
  { id: 'm', contextWindow: 999, input: ['text', 'image'], reasoningEfforts: { off: null, high: 'high' }, name: 'second' },
)
check('merging fills the gap another provider left', JSON.stringify(merged.input) === JSON.stringify(['text', 'image']) && merged.reasoningEfforts.high === 'high')
check('merging never overwrites a value that is already known', merged.name === 'first' && merged.contextWindow === 128000)
check('a zero context window counts as missing, never as zero', mergeReferenceEntry({ id: 'm' }, { id: 'm', contextWindow: 0 }).contextWindow === undefined)
check('an empty modality list counts as missing', mergeReferenceEntry({ id: 'm' }, { id: 'm', input: [] }).input === undefined)

const index = buildReferenceIndex([
  { route: 'moonshot', models: [{ id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 512000, input: ['text', 'image'] }] },
  { route: 'zai', models: [{ id: 'zai-org/GLM-5.2', contextWindow: 1048576, reasoningEfforts: { off: null, high: 'high' } }] },
  { route: 'broken-but-notempty', models: [{ id: 'orphan' }] },
  { route: 'empty', models: [] },
])
check('the index counts answered providers and distinct ids', index.providers === 3 && index.ids === 3, JSON.stringify({ providers: index.providers, ids: index.ids }))
check('the index tolerates a source with no models', Array.isArray(buildReferenceIndex([{ route: 'x', models: [] }]).byKey) === false)

const exact = lookupReference(index, 'minimax-m3')
check('an exact id resolves at the exact stage and is trusted', exact?.stage === 'exact' && exact?.trusted === true)
check('a reseller-prefixed catalog key resolves a bare wire id',
  lookupReference(index, 'glm-5.2')?.model?.contextWindow === 1048576, JSON.stringify(lookupReference(index, 'glm-5.2')?.stage))
const normalizedHit = lookupReference(index, 'glm-5.2-highspeed')
check('a marketing suffix resolves through the normalized stage', normalizedHit?.stage === 'normalized', normalizedHit?.stage)
check('a normalized match is not trusted for reasoning spellings', normalizedHit?.trusted === false)
check('an unknown id resolves to nothing rather than a near miss', lookupReference(index, 'nobody-knows-this-one') === undefined)
check('looking up in a missing index is safe', lookupReference(undefined, 'x') === undefined)

const bare = applyReference({ id: 'minimax-m3' }, lookupReference(index, 'minimax-m3'))
check('a bare discovery result gains context, modalities and name',
  bare.contextWindow === 512000 && JSON.stringify(bare.input) === JSON.stringify(['text', 'image']) && bare.name === 'MiniMax M3', JSON.stringify(bare))
check('the reference never invents a field the catalog lacks', bare.maxTokens === undefined && bare.reasoningEfforts === undefined)
check('match provenance travels with the model', bare.reference.from === 'minimax-m3' && bare.reference.stage === 'exact' && bare.reference.trusted === true)
const normalizedApplied = applyReference({ id: 'glm-5.2-highspeed' }, lookupReference(index, 'glm-5.2-highspeed'))
check('a normalized match copies context but not a reasoning level map',
  normalizedApplied.contextWindow === 1048576 && normalizedApplied.reasoningEfforts === undefined, JSON.stringify(normalizedApplied))
check('an unmatched model is returned untouched', JSON.stringify(applyReference({ id: 'x' }, undefined)) === JSON.stringify({ id: 'x' }))
const declared = applyReference({ id: 'minimax-m3', contextWindow: 999, input: ['text'] }, lookupReference(index, 'minimax-m3'))
check('values the endpoint published are never overwritten', declared.contextWindow === 999 && JSON.stringify(declared.input) === JSON.stringify(['text']))
const counted = withReference([{ id: 'minimax-m3' }, { id: 'unknown' }], index)
check('enrichment reports how many ids the catalog explained', counted.explained === 1 && counted.known === false)
check('enrichment without an index is a pass-through',
  JSON.stringify(withReference([{ id: 'x' }], null)) === JSON.stringify({ models: [{ id: 'x' }], explained: 0 }))

const filled = fillDraftFromReference(
  { id: 'minimax-m3', name: '', contextWindow: '', maxTokens: '', input: 'inherit', reasoning: 'inherit', levels: [] },
  lookupReference(index, 'minimax-m3'),
)
check('filling adds every capability the catalog knows',
  filled.filled === 3 && filled.draft.name === 'MiniMax M3' && filled.draft.contextWindow === '512000' && filled.draft.input === 'text+image', JSON.stringify(filled))
const kept = fillDraftFromReference(
  { id: 'minimax-m3', name: 'mine', contextWindow: '1000', maxTokens: '', input: 'text', reasoning: 'off', levels: [] },
  lookupReference(index, 'minimax-m3'),
)
check('filling never overwrites what is already set',
  kept.draft.name === 'mine' && kept.draft.contextWindow === '1000' && kept.draft.input === 'text' && kept.draft.reasoning === 'off' && kept.filled === 0, JSON.stringify(kept))
check('filling an unmatched model changes nothing', fillDraftFromReference({ id: 'x', name: '', contextWindow: '', maxTokens: '', input: 'inherit', reasoning: 'inherit', levels: [] }, undefined).filled === 0)

let blankRefused = ''
try {
  modelsOps('route-x', [{ id: '  ', name: '', contextWindow: '', maxTokens: '', input: 'inherit', reasoning: 'inherit', levels: [] }])
} catch (error) {
  blankRefused = error.copyKey ?? error.message
}
check('a blank model id is refused before it can reach settings.yaml', blankRefused === 'modelIdRequired', blankRefused)

// ================= global thinking: efforts + provider presets ==================
//
// pi-ai *throws* `UNSUPPORTED_REASONING_EFFORT` for a level a model does not
// offer, so the global effort select may only list what the host catalog reports
// for that exact route/model. These checks pin that, plus the preset rule that a
// catalog provider is created with nothing but a credential reference.
const { effortChoices, catalogEntry, presetOptions } = internals

const catalog = {
  default: { provider: 'go', model: 'deepseek-v4.1-flash' },
  groups: [
    { id: 'go', name: 'opencodego', models: [
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
      { id: 'plain-model', name: 'Plain' },
    ] },
    { id: 'zai-coding-cn', name: 'zai', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  ],
}

const choices = effortChoices(catalog, { provider: 'go', model: 'deepseek-v4.1-flash' })
check('the host catalog provides the selectable efforts',
  JSON.stringify(choices.efforts.map((effort) => effort.id)) === JSON.stringify(['off', 'low', 'high']), JSON.stringify(choices))
check('the adapter default travels with them', choices.defaultId === 'high' && choices.known === true)
check('a model without reasoning metadata offers no levels',
  effortChoices(catalog, { provider: 'go', model: 'plain-model' }).efforts.length === 0)
check('an unknown route or model offers no levels either',
  effortChoices(catalog, { provider: 'nope', model: 'nope' }).known === false
  && effortChoices(undefined, { provider: 'go', model: 'deepseek-v4.1-flash' }).efforts.length === 0)
check('a model entry is looked up per route, not globally', catalogEntry(catalog, { provider: 'zai-coding-cn', model: 'glm-5.3' })?.name === 'GLM-5.3')

const presetDirectory = [
  { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
  { provider: 'moonshotai', displayName: 'Moonshot AI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'moonshotai'], declared: false },
  { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
  { provider: 'zai-coding-cn', displayName: 'zai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'zai-coding-cn'], declared: true },
  { provider: 'go', displayName: 'opencodego', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'go'], declared: true },
]
const presets = presetOptions(presetDirectory, ['go'])
check('presets list catalog providers in this plugin\'s own namespace',
  JSON.stringify(presets.map((preset) => preset.id)) === JSON.stringify(['anthropic', 'moonshotai']), JSON.stringify(presets))
check('a built-in route from another namespace is never offered as a preset',
  presets.every((preset) => preset.id !== 'deepseek-official'))
check('an already configured route is left out instead of being replaceable',
  presets.every((preset) => preset.id !== 'go'))
check('a preset carries its display label for the select',
  presets.filter((preset) => preset.id === 'moonshotai')[0]?.label === 'Moonshot AI', JSON.stringify(presets))

const presetOps = createOps({ preset: 'moonshotai', route: 'moonshotai', displayName: 'Moonshot AI', api: '', baseURL: '', modelId: '' })
check('a preset create writes the credential reference and no endpoint override',
  presetOps.length === 1 && presetOps[0].op === 'set'
  && JSON.stringify(presetOps[0].path) === JSON.stringify(['providers', 'moonshotai'])
  && JSON.stringify(presetOps[0].value) === JSON.stringify({ apiKeyEnv: 'MOONSHOTAI_API_KEY', displayName: 'Moonshot AI' }),
  JSON.stringify(presetOps))
const overridden = createOps({ preset: 'moonshotai', route: 'moonshotai', displayName: '', api: 'anthropic-messages', baseURL: 'https://proxy.corp/v1/', modelId: '' })
check('a preset create can still override protocol and endpoint',
  overridden[0].value.api === 'anthropic-messages' && overridden[0].value.baseURL === 'https://proxy.corp/v1',
  JSON.stringify(overridden[0].value))
// The snapshot pre-fills protocol and endpoint from the installed catalog. Writing
// them back unchanged would pin a catalog route to an explicit protocol (which
// rebuilds it) and freeze an endpoint that the catalog is supposed to keep
// owning — so an untouched pre-fill must never reach the config.
const untouched = createOps({
  preset: 'anthropic', route: 'anthropic', displayName: 'Anthropic', api: 'anthropic-messages',
  baseURL: 'https://api.anthropic.com', presetApi: 'anthropic-messages', presetBaseUrl: 'https://api.anthropic.com', modelId: '',
})
check('a pre-filled value the user did not touch stays out of the config',
  untouched[0].value.api === undefined && untouched[0].value.baseURL === undefined,
  JSON.stringify(untouched[0].value))
const touchedEndpoint = createOps({
  preset: 'anthropic', route: 'anthropic', displayName: '', api: 'anthropic-messages',
  baseURL: 'https://gateway.corp/anthropic/', presetApi: 'anthropic-messages', presetBaseUrl: 'https://api.anthropic.com', modelId: '',
})
check('changing only the endpoint writes only the endpoint',
  touchedEndpoint[0].value.api === undefined && touchedEndpoint[0].value.baseURL === 'https://gateway.corp/anthropic',
  JSON.stringify(touchedEndpoint[0].value))
const clearedProtocol = createOps({
  preset: 'anthropic', route: 'anthropic', displayName: '', api: '',
  baseURL: '', presetApi: 'anthropic-messages', presetBaseUrl: 'https://api.anthropic.com', modelId: '',
})
check('clearing a pre-filled field also keeps it out of the config',
  clearedProtocol[0].value.api === undefined && clearedProtocol[0].value.baseURL === undefined,
  JSON.stringify(clearedProtocol[0].value))
check('a preset refuses a malformed endpoint override', (() => {
  try {
    createOps({ preset: 'x', route: 'x', displayName: '', api: '', baseURL: 'not a url', modelId: '', presetBaseUrl: 'https://api.anthropic.com' })
    return false
  } catch {
    return true
  }
})())
check('a preset refuses a protocol pi-ai does not support', (() => {
  try {
    createOps({ preset: 'x', route: 'x', displayName: '', api: 'openai-legacy', baseURL: '', modelId: '' })
    return false
  } catch {
    return true
  }
})())
check('a preset still validates its route id', (() => {
  try {
    createOps({ preset: 'x', route: 'Bad Route', displayName: '', api: '', baseURL: '', modelId: '' })
    return false
  } catch {
    return true
  }
})())
check('the custom path still requires protocol, endpoint and a model', (() => {
  try {
    createOps({ preset: '', route: 'mine', displayName: '', api: '', baseURL: 'https://x/v1', modelId: 'm' })
    return false
  } catch {
    return true
  }
})())

// --- the generated catalog snapshot -----------------------------------------
//
// The create form pre-fills protocol and endpoint from a snapshot read out of the
// installed pi-ai catalog. These checks pin the properties the pre-fill relies on
// rather than any particular provider, so regenerating the snapshot cannot make
// them wrong — only a broken generator can.
const shipped = internals.CATALOG_DEFAULTS
check('the snapshot records where it came from and when', shipped.source.includes('pi-ai') && /^\d{4}-\d{2}-\d{2}T/.test(shipped.generatedAt), `${shipped.source} ${shipped.generatedAt}`)
check('the snapshot covers the catalog providers', Object.keys(shipped.providers).length >= 30, String(Object.keys(shipped.providers).length))
check('every recorded protocol is one the settings schema accepts',
  Object.values(shipped.providers).every((entry) => entry.api === undefined || ['openai-completions', 'openai-responses', 'anthropic-messages'].includes(entry.api)))
check('every recorded endpoint is an absolute https URL',
  Object.values(shipped.providers).every((entry) => entry.baseUrl === undefined || /^https:\/\/[^\s]+$/.test(entry.baseUrl)))
check('every entry carries a model count and a provider is findable by id',
  Object.entries(shipped.providers).every(([, entry]) => Number.isInteger(entry.models) && entry.models >= 0)
  && internals.catalogDefaults('anthropic')?.api === 'anthropic-messages')
check('an unrecorded provider resolves to nothing instead of a guess',
  internals.catalogDefaults('definitely-not-a-provider') === undefined && internals.catalogDefaults('') === undefined)
check('a mixed-protocol provider records no protocol (a pin would rebuild it)',
  shipped.providers['opencode-go']?.api === undefined && shipped.providers['opencode-go']?.baseUrl === undefined,
  JSON.stringify(shipped.providers['opencode-go']))

console.log(`api: ${count - failures.length}/${count} checks passed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  process.exit(1)
}
console.log('api: ok')



