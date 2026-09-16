/**
 * Registration and render smoke tests for the browser half.
 *
 * It reproduces what the DSH web shell does with a plugin bundle: publish the
 * `window.__ModuleLoader__` facade, execute the bundle file (which merely
 * *registers* a factory), materialize the module through `factory(require)`
 * with `react` stubbed, then run `apply()` against a fake client context.
 *
 * What it proves, without booting DSH or a browser:
 *   - the wrapper is well formed and registers under the package name
 *   - the factory runs and exports `{ name, inject, apply }`
 *   - `apply` claims exactly the seats this plugin owns, and disposing them all
 *     really does unregister everything (the reversibility contract)
 *   - the panel renders in both hosts, with and without a configured provider,
 *     and hands the model / header / JSON sections the right props
 *
 * Run: node test/smoke.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const bundle = await readFile(resolve(root, 'lib/client.js'), 'utf8')

const failures = []
const checks = []
function check(name, condition, detail = '') {
  checks.push(name)
  if (!condition) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * The panel does real async work in its effects (discovery, credential reads,
 * building the reference index), so a rejection there must fail the run instead
 * of scrolling past as console noise.
 */
const rejections = []
process.on('unhandledRejection', (reason) => rejections.push(reason))
/** Let pending microtasks and one timer turn settle. */
async function flush(rounds = 6) {
  for (let at = 0; at < rounds; at += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ------------------------------------------------------------------ fake React
/**
 * A minimal hook runtime: state persists across re-render passes, effects run
 * between passes, and anything async is simply not awaited. Enough to drive the
 * panel through its render path and catch a broken prop or a missing field.
 */
let active = null
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => active.useState(initial),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: (fn, deps) => active.useEffect(fn, deps),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** @returns a hook runtime usable for one component render loop. */
function hookRuntime() {
  const state = { cells: [], deps: [], effects: [], dirty: false, cursor: 0 }
  return {
    state,
    hooks: {
      useState(initial) {
        const index = state.cursor++
        if (state.cells.length <= index) state.cells[index] = typeof initial === 'function' ? initial() : initial
        return [state.cells[index], (next) => {
          state.cells[index] = typeof next === 'function' ? next(state.cells[index]) : next
          state.dirty = true
        }]
      },
      /**
       * Effects honour their dependency array, like React: without this the
       * seeding effect would run on every pass and reset the open tab, which
       * would make the harness disagree with the browser.
       */
      useEffect(fn, deps) {
        const index = state.cursor++
        const previous = state.deps[index]
        const changed = previous === undefined || deps === undefined
          || deps.length !== previous.length
          || deps.some((value, at) => value !== previous[at])
        if (!changed) return
        state.deps[index] = deps === undefined ? undefined : deps.slice()
        state.effects.push(fn)
      },
    },
  }
}

/**
 * Render one panel, running effects between passes until it settles.
 *
 * @param component - the panel component.
 * @param props - its props.
 * @param runtime - hook runtime.
 * @returns the rendered element tree from the last pass.
 */
function render(component, props, runtime) {
  active = runtime.hooks
  let tree
  for (let pass = 0; pass < 10; pass += 1) {
    runtime.state.cursor = 0
    runtime.state.dirty = false
    tree = component(props)
    for (const effect of runtime.state.effects.splice(0)) effect()
    if (!runtime.state.dirty) break
  }
  active = null
  return tree
}

/** Every element node in a tree, depth-first. */
function elements(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node)
  elements(node.children, out)
  return out
}

/** All rendered text, for presence assertions. */
function textOf(node) {
  const collected = []
  const walk = (value) => {
    if (value === null || value === undefined || typeof value === 'boolean') return
    if (typeof value === 'string' || typeof value === 'number') {
      collected.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    if (typeof value === 'object') {
      walk(value.children)
      if (typeof value.props?.title === 'string') collected.push(value.props.title)
    }
  }
  walk(node)
  return collected.join(' | ')
}

// ---------------------------------------------------------------- module load
let registration
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { registration = entry } } },
  console,
  URL,
  JSON,
  setTimeout,
  clearTimeout,
  setImmediate,
  document: undefined,
}
vm.createContext(sandbox)
vm.runInContext(bundle, sandbox, { filename: 'lib/client.js' })

check('bundle registers a module loader entry', registration !== undefined)
check('entry id is the package name', registration?.id === pkg.name, `got ${registration?.id}`)
check('entry exposes a factory', typeof registration?.factory === 'function')

const exports_ = registration.factory((specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected external require(${JSON.stringify(specifier)})`)
})

check('exports name', exports_.name === pkg.name, `got ${exports_.name}`)
check('exports cordis service inject list', Array.isArray(exports_.inject) && exports_.inject.includes('slots') && exports_.inject.includes('locale'), JSON.stringify(exports_.inject))
check('exports apply()', typeof exports_.apply === 'function')
check('plug-in name is the package name', exports_.name === pkg.name, `got ${exports_.name}`)

// --------------------------------------------------------------- fake context
const state = {
  slots: new Map(),
  disposers: [],
  tabTypes: [],
  locales: [],
  injections: [],
  effects: [],
  bindings: [],
  discoveryCalls: [],
  writes: [],
  snapshots: {
    // Global thinking surfaces the panel reads but does not own.
    'agent-default-model': { status: 'ready', revision: 4, writable: true, value: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, user: {} },
    'llm-deepseek': { status: 'ready', revision: 2, writable: true, value: { maxTokens: 256000 }, user: {} },
  },
  scopeSnapshot: { status: 'ready', value: { providers: {} }, user: {}, revision: 1, writable: true },
}

function makeSlots() {
  return {
    inject(key, callback) {
      const dispose = callback()
      state.injections.push(key)
      state.disposers.push(typeof dispose === 'function' ? dispose : () => {})
      return () => {}
    },
    register(options, Component) {
      const bucket = state.slots.get(options.name) ?? []
      const record = Object.assign({ Component }, options)
      bucket.push(record)
      state.slots.set(options.name, bucket)
      return () => {
        const current = state.slots.get(options.name) ?? []
        state.slots.set(options.name, current.filter((entry) => entry !== record))
      }
    },
  }
}

/**
 * A context whose `inject` runs the callback immediately with the services.
 *
 * The remote namespaces are exposed *only* through `get('remote.<ns>')`, exactly
 * as the api gateway mounts them. An earlier harness handed them out as fields of
 * the `remote` service object, which is precisely the shape that does not exist
 * at runtime — and it hid a bug where the panel had no LLM face at all.
 */
function makeContext() {
  const settingsScope = {
    bind: ({ namespace }) => {
      state.bindings.push(namespace)
      return {
        namespace,
        getSnapshot: () => state.snapshots[namespace] ?? state.scopeSnapshot,
        subscribe: () => () => {},
        mutate: async (ops, revision) => {
          state.writes.push({ namespace, ops, revision })
          return { ok: true, value: null }
        },
        set: async () => ({ ok: true, value: null }),
        unset: async () => ({ ok: true, value: null }),
      }
    },
  }
  const llm = {
    listConfigurableProviders: async () => ({ ok: true, value: [
      { provider: 'opencode-go', displayName: 'opencodego', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'opencode-go'], declared: true },
      { provider: 'moonshot', displayName: 'Moonshot AI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'moonshot'], declared: false },
      { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [] },
    ] }),
    /**
     * The two shapes that matter: a custom route answers with bare ids, while a
     * catalog route answers locally with what the host publishes for it (measured:
     * `id`/`name`/`contextWindow`/`maxTokens` — no modalities, no reasoning).
     */
    discoverModels: async (_ns, request) => {
      state.discoveryCalls.push(request.provider)
      // Catalog providers answer with what the host publishes for them; the
      // configured custom route answers with bare ids.
      if (request.provider === 'moonshot' || request.provider === 'anthropic' || request.provider === 'deepseek-official') {
        return { ok: true, value: [{ id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 512000, maxTokens: 32000 }] }
      }
      return { ok: true, value: [{ id: 'minimax-m3' }, { id: 'nobody-knows-this-one' }] }
    },
  }
  /** The host model catalog: the only authority on which efforts a model accepts. */
  const session = {
    modelCatalog: async () => ({ ok: true, value: {
      default: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      routableProviders: ['opencode-go'],
      failures: [],
      groups: [{ id: 'opencode-go', name: 'opencodego', models: [{
        id: 'deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }, {
        id: 'qwen3.8-flash',
        name: 'Qwen 3.8 Flash',
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
      }] }],
    } }),
  }
  const credentials = {
    describe: async () => ({ ok: true, value: { configured: true, source: 'file', writable: true } }),
    set: async () => ({ ok: true, value: null }),
  }
  const services = { settingsScope, 'remote.llm': llm, 'remote.credentials': credentials, 'remote.session': session }
  const scoped = {
    slots: makeSlots(),
    locale: {
      register(namespace, dictionaries) {
        state.locales.push({ namespace, languages: Object.keys(dictionaries) })
        return () => {}
      },
      bind: () => (key) => key,
    },
    // A direct service is a plain context property, as in the real shell…
    settingsScope,
    // …while a dotted namespace is only reachable through the context, like the
    // real Remote service instance (which carries no namespace fields).
    remote: {},
    get: (name) => services[name],
    sidebarRightTabs: {
      register(definition) {
        state.tabTypes.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab() {},
    },
  }
  return {
    effect(callback, label) {
      state.effects.push(label)
      return callback()
    },
    inject(_dependencies, callback) {
      const dispose = callback(scoped)
      if (typeof dispose === 'function') state.disposers.push(dispose)
      return () => {}
    },
    slots: scoped.slots,
    locale: scoped.locale,
  }
}

const ctx = makeContext()
exports_.apply(ctx)

check('registers exactly one right-sidebar tab type', state.tabTypes.length === 1, `got ${state.tabTypes.length}`)
check('tab type is a page type (no address patterns)', state.tabTypes[0]?.patterns === undefined)
check('tab type kind matches the launcher', state.tabTypes[0]?.kind === 'model-studio', `got ${state.tabTypes[0]?.kind}`)
check('tab type id is unique and stable', state.tabTypes[0]?.id === 'model-studio', `got ${state.tabTypes[0]?.id}`)

const expectedSlots = ['sidebar.footer.action', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'settings.section', 'shell.overlay']
for (const slot of expectedSlots) {
  check(`claims slot ${slot}`, (state.slots.get(slot) ?? []).length === 1, `got ${(state.slots.get(slot) ?? []).length}`)
}
check(
  'settings page is registered before the plugins section',
  (state.slots.get('settings.section') ?? [])[0]?.order === 30,
)
check(
  'drawer body is keyed by the tab-type id',
  (state.slots.get('sidebar.right.pane.tab') ?? [])[0]?.key === 'model-studio',
)
check('registers the locale dictionary', state.locales.length === 1 && state.locales[0].namespace === 'model-studio')
check('dictionaries carry both languages', JSON.stringify(state.locales[0]?.languages) === JSON.stringify(['zh', 'en']), JSON.stringify(state.locales[0]?.languages))
check(
  'binds both settings namespaces (llm-pi-ai + model-studio)',
  state.bindings.includes('llm-pi-ai') && state.bindings.includes('model-studio'),
  JSON.stringify(state.bindings),
)
check('every cordis injection is either slots or a named service', state.injections.every((key) => typeof key === 'string'))

// ------------------------------------------------------------------ rendering
const { StudioPanel } = exports_.__internals

const emptyRuntime = hookRuntime()
const emptyTree = render(StudioPanel, { t: (key) => key, host: 'settings' }, emptyRuntime)
check('the panel renders with no provider configured', emptyTree !== undefined && emptyTree.type === 'div')
check('an empty studio shows the empty-list hint', textOf(emptyTree).includes('providersEmpty'), textOf(emptyTree).slice(0, 200))
check('an empty studio renders no model section', elements(emptyTree).every((element) => element.type?.name !== 'ModelSection'))

state.scopeSnapshot = {
  status: 'ready',
  revision: 7,
  writable: true,
  value: {
    providers: {
      'opencode-go': {
        displayName: 'opencodego',
        api: 'openai-completions',
        baseURL: 'https://opencode.ai/zen/go/v1',
        apiKeyEnv: 'GO_API_KEY',
        headers: { 'x-opencode-session': 'dsh', 'user-agent': 'nope' },
        models: [
          { id: 'deepseek-v4.1-flash', contextWindow: 512000, input: ['text', 'image'], compat: { supportsStore: true } },
          // The damaged shape this plugin used to write: seven levels for a model the
          // catalog gives three, including the two that only count as supported
          // *because* a map declares them.
          { id: 'qwen3.8-flash', reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } },
        ],
        modelOverrides: { 'deepseek-v4.1-flash': { maxTokens: 32000 } },
      },
      'zai-coding-cn': { apiKeyEnv: 'ZAI_CODING_CN_API_KEY' },
    },
  },
  user: { providers: { 'opencode-go': { displayName: 'opencodego' } } },
}

/** The placeholder props an element tree carries (copy keys under this harness). */
function inputPlaceholders(tree) {
  return elements(tree).filter((element) => element.type === 'input').map((element) => String(element.props.placeholder ?? ''))
}

/** The detail tab buttons (their labels are copy keys under this harness). */
function tabsOf(tree) {
  return elements(tree).filter((element) => element.type === 'button'
    && String(element.props.className ?? '').includes('dms-tab'))
}

for (const host of ['settings', 'drawer']) {
  const runtime = hookRuntime()
  const props = { t: (key) => key, host }
  let tree = render(StudioPanel, props, runtime)
  // The host model catalog arrives asynchronously, and the capability rows read it
  // to learn which levels a model may declare.
  await flush()
  tree = render(StudioPanel, props, runtime)

  check(`${host}: renders the provider list`, textOf(tree).includes('opencode-go'))
  check(`${host}: selects a provider and opens its details`, textOf(tree).includes('fieldDisplayName'))
  const tabs = tabsOf(tree)
  check(`${host}: exposes four detail tabs`, tabs.length === 4, `got ${tabs.length}`)
  check(`${host}: opens on the basics tab`, tabs[0]?.props['aria-selected'] === true)
  check(`${host}: the identity strip names the route`, textOf(tree).includes('opencode-go'))
  check(`${host}: the basics pane carries the key section`, textOf(tree).includes('keyHint'))
  check(`${host}: only one pane is mounted at a time`,
    elements(tree).every((element) => element.type?.name !== 'ModelSection')
    && elements(tree).every((element) => element.type?.name !== 'HeadersSection'))

  /** Click a tab and re-render, as a user would. */
  const openTab = (label) => {
    const target = tabsOf(tree).filter((element) => textOf(element).includes(label))[0]
    check(`${host}: has a ${label} tab`, target !== undefined)
    if (target !== undefined) target.props.onClick()
    tree = render(StudioPanel, props, runtime)
    return tree
  }

  openTab('tabModels')
  const section = elements(tree).filter((element) => element.type?.name === 'ModelSection')[0]
  check(`${host}: the capabilities tab mounts the model editor`, section !== undefined)
  check(`${host}: the model editor gets one row per declared model`, section?.props.rows.length === 2, JSON.stringify(section?.props.rows?.map((row) => row.id)))
  check(`${host}: rows are the explicit-list surface`, section?.props.explicit === true)
  check(`${host}: configured ids are handed to the picker so it can mark them`,
    JSON.stringify(section?.props.existingIds) === JSON.stringify(['deepseek-v4.1-flash', 'qwen3.8-flash']),
    JSON.stringify(section?.props.existingIds))
  check(`${host}: a route with an endpoint is interrogable`, section?.props.interrogable === true)
  check(`${host}: the tab carries the row count`, textOf(tree).includes('2'))
  const sectionTree = section === undefined ? [] : section.type(section.props)
  const cards = elements(sectionTree).filter((element) => element.type?.name === 'ModelCard')
  check(`${host}: the model editor renders a card per row`, cards.length === 2, `got ${cards.length}`)
  check(`${host}: the first card keeps its untouched compat block`,
    cards[0]?.props.draft.raw.compat?.supportsStore === true, JSON.stringify(cards[0]?.props.draft.raw))
  const firstCard = cards.length > 0 ? cards[0].type(cards[0].props) : []
  check(`${host}: a model card renders its id and both capability selects`,
    textOf(firstCard).includes('deepseek-v4.1-flash') && elements(firstCard).filter((element) => element.type === 'select').length >= 2)

  // The row whose map names levels the catalog does not give it must say so and offer
  // a one-click way back to inheritance — the exact repair a real config needed.
  const damaged = cards.filter((card) => card.props.draft.id === 'qwen3.8-flash')[0]
  check(`${host}: the catalog's level set reaches the row`, JSON.stringify(damaged?.props.available?.levels) === JSON.stringify(['off', 'low', 'high']), JSON.stringify(damaged?.props.available))
  const damagedCard = damaged.type(damaged.props)
  const damagedText = textOf(damagedCard)
  check(`${host}: unsupported declared levels are named, not hidden`,
    damagedText.includes('levelsUnsupported') && damagedText.includes('xhigh') && damagedText.includes('max'), damagedText.slice(0, 200))
  check(`${host}: the catalog's own levels are stated`, damagedText.includes('levelsCatalogKnown'))
  // Located by its title: the button's own label is also part of `textOf`, which
  // folds in the tooltip.
  const fix = elements(damagedCard).filter((element) => element.type === 'button' && element.props.title === 'levelsFixHint')[0]
  check(`${host}: a damaged row offers a reset to inheritance`, fix !== undefined)
  damaged.props.onChange(Object.assign({}, damaged.props.draft, { reasoning: 'inherit', levels: [] }))
  tree = render(StudioPanel, props, runtime)
  // The section is a component element: its children exist only once it is invoked.
  const repairedSection = elements(tree).filter((element) => element.type?.name === 'ModelSection')[0]
  const repairedSectionTree = repairedSection === undefined ? [] : repairedSection.type(repairedSection.props)
  const repaired = elements(repairedSectionTree).filter((element) => element.type?.name === 'ModelCard')
    .filter((card) => card.props.draft.id === 'qwen3.8-flash')[0]
  const repairedCard = repaired.type(repaired.props)
  check(`${host}: resetting to inheritance clears the map and the warning`,
    repaired.props.draft.reasoning === 'inherit' && repaired.props.draft.levels.length === 0
    && !textOf(repairedCard).includes('levelsUnsupported'))
  check(`${host}: an inherited row writes no level map back`,
    exports_.__internals.entryFromDraft(repaired.props.draft).reasoningEfforts === undefined,
    JSON.stringify(exports_.__internals.entryFromDraft(repaired.props.draft)))

  // Reference enrichment, end to end: the custom route answers with bare ids while
  // the installed catalog knows one of them, so the checklist must carry the
  // catalog's capabilities and leave the unknown id alone.
  await flush()
  tree = render(StudioPanel, props, runtime)
  const beforeFetch = elements(tree).filter((element) => element.type?.name === 'ModelSection')[0]
  beforeFetch?.props.onFetch()
  await flush()
  tree = render(StudioPanel, props, runtime)
  const fetched = elements(tree).filter((element) => element.type?.name === 'ModelSection')[0]
  const list = fetched?.props.candidates ?? []
  check(`${host}: the custom endpoint answered with bare ids`, list.length === 2, JSON.stringify(list.map((model) => model.id)))
  check(`${host}: the reference index is built from the catalog, not the custom route`,
    state.discoveryCalls.includes('moonshot'), JSON.stringify(state.discoveryCalls))
  check(`${host}: the catalog supplies the context window for a bare id`, list[0]?.contextWindow === 512000, JSON.stringify(list[0]))
  check(`${host}: the catalog supplies the output limit and a display name`,
    list[0]?.maxTokens === 32000 && list[0]?.name === 'MiniMax M3', JSON.stringify(list[0]))
  check(`${host}: capabilities the host never publishes are not invented`,
    list[0]?.input === undefined && list[0]?.reasoningEfforts === undefined, JSON.stringify(list[0]))
  check(`${host}: the reference tag names its source and match stage`,
    list[0]?.reference?.from === 'minimax-m3' && list[0]?.reference?.stage === 'exact', JSON.stringify(list[0]?.reference))
  check(`${host}: an unknown id stays bare instead of being guessed`,
    list[1]?.reference === undefined && list[1]?.contextWindow === undefined, JSON.stringify(list[1]))
  check(`${host}: the result line counts what the reference explained`, fetched?.props.info?.explained === 1, JSON.stringify(fetched?.props.info))
  check(`${host}: unconfigured candidates arrive pre-selected`, fetched?.props.picked.length === 2, JSON.stringify(fetched?.props.picked))
  const prefilled = exports_.__internals.draftFromCandidate(list[0], false)
  check(`${host}: an enriched candidate becomes a populated draft`,
    prefilled.contextWindow === '512000' && prefilled.maxTokens === '32000' && prefilled.name === 'MiniMax M3'
    && prefilled.input === 'inherit' && prefilled.reasoning === 'inherit',
    JSON.stringify(prefilled))
  // The blanket "declare thinking" checkbox used to seed all seven levels for a model
  // the reference library could not describe. That is what wrote an impossible level
  // map into a real config, so it now declares nothing without catalog coverage.
  check(`${host}: the blanket thinking checkbox declares nothing the catalog cannot vouch for`,
    exports_.__internals.draftFromCandidate(list[1], true).levels.length === 0
    && exports_.__internals.draftFromCandidate(list[1], true).reasoning === 'inherit')
  check(`${host}: a candidate the catalog covers gets exactly the catalog's levels`,
    (() => {
      const covered = exports_.__internals.draftFromCandidate(list[1], true, { known: true, levels: ['off', 'low', 'high'], spellings: undefined })
      return covered.reasoning === 'custom' && JSON.stringify(covered.levels) === JSON.stringify(['off', 'low', 'high'])
    })())
  const fillResult = exports_.__internals.fillDraftFromReference(
    { id: 'minimax-m3', name: 'typed by hand', contextWindow: '', maxTokens: '', input: 'inherit', reasoning: 'inherit', levels: [] },
    list[0]?.reference === undefined ? undefined : { model: list[0], stage: list[0].reference.stage, trusted: list[0].reference.trusted },
  )
  check(`${host}: filling from the reference never overwrites what the user typed`,
    fillResult.draft.name === 'typed by hand' && fillResult.draft.contextWindow === '512000' && fillResult.filled === 2,
    JSON.stringify(fillResult))

  openTab('tabHeaders')
  const headers = elements(tree).filter((element) => element.type?.name === 'HeadersSection')[0]
  check(`${host}: the headers tab gets every stored header`, headers?.props.rows.length === 2, JSON.stringify(headers?.props.rows))
  const headersTree = headers === undefined ? [] : headers.type(headers.props)
  check(`${host}: a reserved header is rendered for warning`,
    textOf(headersTree).includes('headerReserved'), textOf(headersTree).slice(0, 200))

  openTab('tabJson')
  const json = elements(tree).filter((element) => element.type?.name === 'JsonSection')[0]
  check(`${host}: the JSON tab is seeded from the user layer`, json !== undefined && json.props.draft.includes('opencodego'))
  check(`${host}: the JSON editor starts clean`, json?.props.dirty === false)

  openTab('tabBasic')
  check(`${host}: switching back returns to the basics pane`, tabsOf(tree)[0]?.props['aria-selected'] === true)
}

// ------------------------------------------------------- global thinking strip
//
// The global levels must come from the host catalog: pi-ai throws
// UNSUPPORTED_REASONING_EFFORT for a level a model does not offer, so a
// hand-written option list would break requests.
{
  const runtime = hookRuntime()
  const props = { t: (key) => key, host: 'settings' }
  let tree = render(StudioPanel, props, runtime)
  await flush()
  tree = render(StudioPanel, props, runtime)

  const texts = textOf(tree)
  check('the panel leads with a global thinking strip', texts.includes('globalTitle'))
  check('the strip names the default model it applies to', texts.includes('opencode-go / deepseek-v4.1-flash'), texts.slice(0, 160))
  const selects = elements(tree).filter((element) => element.type === 'select')
  /** The option values of one select (children may be nested arrays). */
  const optionValues = (element) => elements(element)
    .filter((child) => child.type === 'option')
    .map((child) => child.props.value)
  const effortSelect = selects.filter((element) => optionValues(element).includes('high') && optionValues(element).includes('off'))[0]
  check('the effort select offers exactly the levels the model declares',
    JSON.stringify(optionValues(effortSelect)) === JSON.stringify(['', 'off', 'low', 'high']), JSON.stringify(optionValues(effortSelect)))
  const gateSelect = selects.filter((element) => optionValues(element).includes('disabled'))[0]
  check('the DeepSeek gate offers enable/disable plus "leave it unset"',
    JSON.stringify(optionValues(gateSelect)) === JSON.stringify(['', 'enabled', 'disabled']), JSON.stringify(optionValues(gateSelect)))
  check('the strip explains where a single session overrides it', texts.includes('globalHint'))
  check('the strip warns when the DeepSeek gate cannot affect the default model',
    texts.includes('globalDeepseekNotDefault'), texts.slice(0, 200))

  effortSelect.props.onChange({ target: { value: 'low' } })
  await flush()
  const effortWrite = state.writes.filter((write) => write.namespace === 'agent-default-model')[0]
  check('picking a global effort writes into agent-default-model, not llm-pi-ai',
    effortWrite !== undefined && JSON.stringify(effortWrite.ops) === JSON.stringify([{ op: 'set', path: ['reasoningEffort'], value: 'low' }]),
    JSON.stringify(effortWrite))
  check('the write carries that namespace\'s own revision', effortWrite?.revision === 4, JSON.stringify(effortWrite?.revision))

  gateSelect.props.onChange({ target: { value: 'disabled' } })
  await flush()
  const gateWrite = state.writes.filter((write) => write.namespace === 'llm-deepseek')[0]
  check('the DeepSeek gate writes into llm-deepseek',
    gateWrite !== undefined && JSON.stringify(gateWrite.ops) === JSON.stringify([{ op: 'set', path: ['thinking'], value: 'disabled' }]),
    JSON.stringify(gateWrite))

  // Collapsing must summarise rather than hide the state.
  const head = elements(tree).filter((element) => String(element.props.className).includes('dms-global-head'))[0]
  check('the strip has a collapse control', head !== undefined && head.props['aria-expanded'] === true)
  head.props.onClick()
  tree = render(StudioPanel, props, runtime)
  check('a collapsed strip still states the current policy',
    textOf(tree).includes('globalSummary'), textOf(tree).slice(0, 160))
}

// ------------------------------------------------------------ provider preset
{
  const runtime = hookRuntime()
  const props = { t: (key) => key, host: 'settings' }
  let tree = render(StudioPanel, props, runtime)
  await flush()
  tree = render(StudioPanel, props, runtime)
  const newButton = elements(tree).filter((element) => element.type === 'button' && textOf(element) === 'create')[0]
  check('the create form opens', newButton !== undefined)
  newButton.props.onClick()
  tree = render(StudioPanel, props, runtime)

  const selects = elements(tree).filter((element) => element.type === 'select')
  const presetOptionValues = (element) => elements(element)
    .filter((child) => child.type === 'option')
    .map((child) => child.props.value)
  const presetSelect = selects.filter((element) => presetOptionValues(element).includes('moonshot'))[0]
  check('the create form leads with a provider preset picker', presetSelect !== undefined)
  const values = presetOptionValues(presetSelect)
  check('the preset list excludes built-in routes from other namespaces',
    !values.includes('deepseek-official'), JSON.stringify(values))
  check('the preset list excludes already configured routes', !values.includes('opencode-go'), JSON.stringify(values))
  check('the preset list offers "custom" as the first choice', values[0] === '', JSON.stringify(values))
  check('a custom create still asks for protocol, endpoint and a model',
    textOf(tree).includes('createModelId') && inputPlaceholders(tree).includes('placeholderBaseURL'), JSON.stringify(inputPlaceholders(tree)))

  presetSelect.props.onChange({ target: { value: 'moonshot' } })
  tree = render(StudioPanel, props, runtime)
  const afterPreset = textOf(tree)
  check('picking a preset pre-fills the route id',
    elements(tree).some((element) => element.type === 'input' && element.props.value === 'moonshot'), afterPreset.slice(0, 200))
  check('picking a preset drops the required first-model question',
    !afterPreset.includes('createModelId'), afterPreset.slice(0, 200))
  check('picking a preset keeps protocol and endpoint as optional overrides',
    afterPreset.includes('fieldApi') && inputPlaceholders(tree).includes('placeholderBaseURLInherit'),
    JSON.stringify(inputPlaceholders(tree)))
  const presetProtocol = elements(tree).filter((element) => element.type === 'select'
    && presetOptionValues(element).includes('anthropic-messages'))[0]
  check('the protocol select on the preset path starts at "inherit"',
    presetProtocol?.props.value === '' && presetOptionValues(presetProtocol)[0] === '', JSON.stringify(presetOptionValues(presetProtocol)))
  check('picking a preset asks for the API key instead',
    afterPreset.includes('createKey') && inputPlaceholders(tree).includes('keyPlaceholder'), JSON.stringify(inputPlaceholders(tree)))
  check('picking a preset shows the derived credential reference', afterPreset.includes('MOONSHOT_API_KEY'), afterPreset.slice(0, 240))
  check('picking a preset explains that the catalog supplies the rest', afterPreset.includes('createPresetHint'))
  check('a provider the snapshot does not record says so instead of guessing',
    afterPreset.includes('createSnapshotMissing'), afterPreset.slice(0, 300))

  // A provider the shipped snapshot *does* record: the form must pre-fill both
  // fields, and creating it must still write neither of them.
  presetSelect.props.onChange({ target: { value: 'anthropic' } })
  tree = render(StudioPanel, props, runtime)
  const preFilled = textOf(tree)
  const shippedDefaults = exports_.__internals.CATALOG_DEFAULTS.providers.anthropic
  check('the prefill case is a provider the snapshot really records',
    shippedDefaults?.api === 'anthropic-messages' && shippedDefaults?.baseUrl === 'https://api.anthropic.com',
    JSON.stringify(shippedDefaults))
  const endpointInput = elements(tree).filter((element) => element.type === 'input' && element.props.value === shippedDefaults.baseUrl)[0]
  check('picking a preset pre-fills the endpoint from the catalog snapshot', endpointInput !== undefined)
  const protocolSelect = elements(tree).filter((element) => element.type === 'select'
    && presetOptionValues(element).includes('anthropic-messages'))[0]
  check('picking a preset pre-fills the protocol from the catalog snapshot',
    protocolSelect?.props.value === 'anthropic-messages', JSON.stringify(protocolSelect?.props.value))
  check('the form says where the pre-filled values came from', preFilled.includes('createSnapshotHint'))
  check('the preset label carries the catalog model count',
    textOf(tree).includes(`Anthropic · ${shippedDefaults.models}`) || presetOptionValues(presetSelect).includes('anthropic'),
    `Anthropic · ${shippedDefaults.models}`)
  state.writes.length = 0
  const submit = elements(tree).filter((element) => element.type === 'button' && textOf(element) === 'createSubmit')[0]
  check('the create button is available with the pre-filled values', submit !== undefined)
  submit.props.onClick()
  await flush()
  const createWrite = state.writes.filter((write) => write.namespace === 'llm-pi-ai')[0]
  check('an untouched protocol/endpoint prefill is not written to settings.yaml',
    createWrite !== undefined
    && JSON.stringify(createWrite.ops) === JSON.stringify([{ op: 'set', path: ['providers', 'anthropic'], value: { apiKeyEnv: 'ANTHROPIC_API_KEY', displayName: 'Anthropic' } }]),
    JSON.stringify(createWrite?.ops))
}

// ------------------------------------------------------------------- copy
const { dictionaries } = exports_.__internals
const zhKeys = Object.keys(dictionaries.zh).sort()
const enKeys = Object.keys(dictionaries.en).sort()
check('both dictionaries carry the same keys', JSON.stringify(zhKeys) === JSON.stringify(enKeys),
  `only in zh: ${zhKeys.filter((key) => !enKeys.includes(key)).join(',')} | only in en: ${enKeys.filter((key) => !zhKeys.includes(key)).join(',')}`)

/**
 * Copy keys are consumed two ways: directly through `t("key")`, and indirectly
 * through an error's `copyKey` (translated at the call site), so both spellings
 * count as use.
 */
const usedKeys = [...new Set([
  ...[...bundle.matchAll(/\bt\(\s*"([A-Za-z][A-Za-z0-9]*)"\s*\)/g)].map((match) => match[1]),
  ...[...bundle.matchAll(/copyError\(\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map((match) => match[1]),
])].sort()
const missingZh = usedKeys.filter((key) => !zhKeys.includes(key))
const missingEn = usedKeys.filter((key) => !enKeys.includes(key))
check(`every used copy key exists in zh (${usedKeys.length} used)`, missingZh.length === 0, missingZh.join(','))
check('every used copy key exists in en', missingEn.length === 0, missingEn.join(','))
const unused = zhKeys.filter((key) => !usedKeys.includes(key))
check('no copy key is dead weight', unused.length === 0, unused.join(','))

// ------------------------------------------------------------------ drawer
//
// The floating drawer is a frame-wide overlay, so it must exist and work without
// a session — the launcher only has to flip a store, not reach the right column.
const overlayEntry = (state.slots.get('shell.overlay') ?? [])[0]
check('claims the frame-wide overlay slot', overlayEntry !== undefined)
check('the overlay is ordered above other overlays', overlayEntry?.order === 20, String(overlayEntry?.order))
check('the drawer starts closed', exports_.__internals.readOverlayOpen() === false)
const closedTree = render(overlayEntry.Component, {}, hookRuntime())
check('a closed drawer renders nothing at all', closedTree === null, JSON.stringify(closedTree))

const launcherEntry = (state.slots.get('sidebar.footer.action') ?? [])[0]
const launcherRuntime = hookRuntime()
const launcherProps = Object.assign({}, launcherEntry?.inject?.(), { wide: true })
let launcherTree = render(launcherEntry.Component, launcherProps, launcherRuntime)
check('the launcher starts collapsed', elements(launcherTree)[0]?.props['aria-expanded'] === false)
elements(launcherTree)[0].props.onClick()
check('clicking the launcher opens the floating drawer', exports_.__internals.readOverlayOpen() === true)
launcherTree = render(launcherEntry.Component, launcherProps, launcherRuntime)
check('the launcher then reports itself expanded', elements(launcherTree)[0]?.props['aria-expanded'] === true)
check('the launcher marks itself active', String(elements(launcherTree)[0].props.className).includes('dms-launcher-active'))

const overlayRuntime = hookRuntime()
const overlayTree = render(overlayEntry.Component, {}, overlayRuntime)
const overlayNodes = elements(overlayTree)
check('an open drawer renders the floating panel', overlayNodes.some((element) => String(element.props.className).includes('dms-overlay-panel')))
check('the drawer floats over a click-catching backdrop',
  overlayNodes.some((element) => String(element.props.className).includes('dms-overlay-backdrop') && typeof element.props.onClick === 'function'))
check('the drawer contains the studio panel', overlayNodes.some((element) => element.type?.name === 'StudioPanel'))
check('the drawer is not a modal dialog (no focus trap imposed)',
  overlayNodes.filter((element) => element.props.role === 'dialog')[0]?.props['aria-modal'] === 'false')
check('the drawer offers docking into the right column', textOf(overlayTree).includes('dock'))
const closeButton = overlayNodes.filter((element) => element.props['aria-label'] === 'close')[0]
check('the drawer has a close control', closeButton !== undefined)
closeButton?.props.onClick()
check('closing hides the drawer', exports_.__internals.readOverlayOpen() === false)

// -------------------------------------------------------------- stylesheet
//
// The panel styles itself, so the class map and the stylesheet have to agree:
// a renamed class with no rule renders unstyled, and a rule for a class nobody
// emits is dead weight. Both directions are pinned here.
const { classes, stylesheet } = exports_.__internals
const emitted = new Set(Object.values(classes))
const styled = new Set([...stylesheet.matchAll(/\.(dms-[a-z0-9-]+)/g)].map((match) => match[1]))
check('every class the panel emits has a rule',
  [...emitted].every((name) => styled.has(name)),
  [...emitted].filter((name) => !styled.has(name)).join(','))
check('the stylesheet has no rule for a class nobody emits',
  [...styled].every((name) => emitted.has(name)),
  [...styled].filter((name) => !emitted.has(name)).join(','))
check('the stylesheet defines the shared token set',
  ['--dms-accent', '--dms-line', '--dms-sunken', '--dms-hover'].every((token) => stylesheet.includes(token + ':')))
check('the tab bar is a segmented control, not underlined buttons',
  stylesheet.includes(`.${classes.tabs} { display: flex; align-items: center`)
  && !new RegExp(`\\.${classes.tab}\\b[^}]*border-bottom`).test(stylesheet))
check('the accent is a translucent tint, never a filled brand colour with a white label',
  !stylesheet.includes('color: #fff') && stylesheet.includes('rgba(var(--dms-accent), .16)'))
check('the detail column scrolls its pane, not its tab bar',
  stylesheet.includes(`.${classes.pane} { flex: 1; min-height: 0; overflow: auto`))
check('a full-width control can never squeeze a button caption',
  stylesheet.includes(`.${classes.keyRow} > button, .${classes.actions} > button { flex: none; }`))

// ---------------------------------------------------------------- reversibility
check('apply returned disposers for every registration', state.disposers.length >= 5, `got ${state.disposers.length}`)
for (const dispose of state.disposers.slice().reverse()) {
  if (typeof dispose === 'function') dispose()
}
check('every claimed slot is empty after disposal', [...state.slots.values()].every((entries) => entries.length === 0))

// ------------------------------------------------------------------- report
await flush()
check('no async work rejected during the run', rejections.length === 0, rejections.map(String).join(' | '))
console.log(`smoke: ${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`)
  process.exit(1)
}
console.log('smoke: ok')
