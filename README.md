# dsh-model-studio · Model Studio

> Advanced model settings for **DeepSeek Harness**: providers, per-model capabilities and per-provider request headers in one right-side drawer, opened from the sidebar next to Settings.

**English** · [简体中文](README.zh-CN.md)

The stock Models settings page deliberately leaves two things to `settings.yaml`: there is no editor for per-provider request `headers`, and reasoning capability is not among the editable per-model fields. This plugin does not replace that page — it fills those two gaps and puts the whole provider surface into a drawer you can open from anywhere.

Zero dependencies, no build step: plain JavaScript on both halves.

---

## 1. Features

| Area | What it does |
|---|---|
| Launcher | A *Model Studio* button in the sidebar foot, directly above the Settings gear (icon + label in the wide sidebar, icon only in the 56px rail). Highlights while the panel is open. |
| Floating drawer | Opens as a **floating right-side drawer** over the conversation: translucent scrim, rounded corners, shadow; closes on Esc, scrim click or ✕. Needs no session, so it works on the home screen too. One click docks it into the official right sidebar instead. |
| Docked panel | Also registers as a right-sidebar tab, so it can share the split view, float, and remember its width. |
| Settings page | The same panel registers as a **Model Studio** page under Settings — a stable fallback entry point. |
| Provider list | Reads the configured providers, merges the adapter's own provider directory (catalog vs. user-declared), and surfaces adapter diagnostics. |
| Global thinking | A collapsible strip at the top of the panel: **default reasoning effort** for new sessions, offering **only the levels the model actually supports**; plus the built-in DeepSeek route's thinking gate and default effort. Collapsed, it still shows the current policy. |
| Provider presets | Creating a provider starts with a **preset picker** — every provider the installed catalog ships, with its model count. Choosing one **pre-fills the protocol and the endpoint from the catalog**, and the API key is the only thing you have to supply. Both fields stay editable: a value you leave alone is *not written to your config*, so the catalog keeps owning it and a later DSH upgrade is picked up automatically; change one (a proxy or gateway in front of a known provider) and it becomes an explicit override. Mixed-protocol providers are left unset on purpose, because naming one protocol would pin every model to it. |
| Detail tabs | **Basics** (including the API key) / **Model capabilities** / **Request headers** / **Config JSON**: segmented control with icons and count badges, a sticky route identity line, and a status line that stays put while only the active pane scrolls. |
| Basics | Edit `displayName`, `api` and `baseURL`. Clearing a field *removes the override* (falling back to the catalog value) instead of writing an empty string. |
| Model capabilities | Per-model context window, output cap, image input (inherit / text only / text + image) and thinking levels (inherit / not a reasoning model / a chosen set). The level editor only ever offers the levels the installed catalog reports for that exact model, and a row whose stored map names a level the model does not take says so and offers a one-click **reset to catalog** — a declared map overrides the catalog and makes the model picker offer those levels too, so an over-declared map is a real defect rather than cosmetic. Wire values also come from the catalog (a level's name is not always what the provider expects). Fields the editor does not model — `compat`, `thinkingBudgets`, anything pi-ai adds later — survive unchanged. |
| Model discovery | *Fetch model list*: catalog routes answer locally with **zero network** (loaded automatically when you select the route); custom routes with an endpoint are read once automatically, and the button re-reads. The result line reports **count · elapsed · source**. Already-configured models are marked and cannot be re-picked; unconfigured ones are pre-selected. Search, select all, clear, invert, *enable thinking for fetched models*, and a single *sync (add N / remove N)* button. A route with neither endpoint nor catalog entry gets an actionable hint instead of a raw error, and an endpoint that stays silent for 12 s reports it and keeps waiting. |
| Capability reference library | A custom endpoint returns bare ids, so the plugin uses the **installed catalog as a reference**: one fan-out over all catalog providers builds an index (measured ~8 ms, no network, ~890 models), and a ranked match (exact → bare → normalized) fills in **context window, output cap and display name**. Candidate rows show a *reference* tag with the match origin and level in the tooltip; *fill from reference* backfills hand-written or older rows and never overwrites a value that is already there. |
| Request headers | Per-provider key/value editor with presets (OpenCode `x-opencode-session`, OpenRouter attribution headers, User-Agent), name and value validation, and a warning for reserved names (`user-agent` is overwritten by the runtime). |
| Config JSON | The user layer subtree is editable: saving diffs top-level keys and writes path-level operations, so untouched fields (credential references, hand-written `compat`, comments you added elsewhere) are not replaced wholesale. The merged effective value is shown next to it. |
| API key | Write-only input into the credentials store; `settings.yaml` keeps only the reference name (derived as `<ROUTE>_API_KEY` when a provider has none). Shows where the reference comes from and whether it is writable. |
| New / delete provider | Creates `providers.<route>` in one write (or, for a preset, just the credential reference); validates the id in the field. Deleting unsets the user layer and says plainly when a provider comes from the composed base layer and would only fall back. |

### Write semantics

Three rules the plugin follows, because getting them wrong is how a model settings editor breaks a working setup:

1. **Clearing removes an override.** Empty `displayName` / `api` / `baseURL`, and empty per-model `input` / `contextWindow` / `reasoningEfforts`, are submitted as *unset* — the catalog value applies again. Nothing is written as an empty string or `null`.
2. **Catalog routes are edited through overrides.** Capability edits for a model the catalog provides are written to that model's override entry only, so the other catalog models keep being served untouched. Materializing a catalog route into an explicit model list removes the now-conflicting override map in the *same* write.
3. **Unmodelled fields round-trip.** The editor owns only the fields it knows; `compat`, `thinkingBudgets` and future fields survive with their key order intact, which keeps the `settings.yaml` diff minimal.

## 2. Install

**Requirements:** DSH `0.1.5-rc.2` or newer, Node per the plugin's `engines` (`^22.19.0 || >=24.0.0`). The plugin is a bundle plugin: it declares its bundle patch, so nothing has to be wired by hand.

### A. Through the launcher (recommended)

```bash
# from a git URL
dsh plugin --profile web add github:billowliu2/dsh-model-studio

# or from a local checkout (the path is anchored to the directory you run this in)
dsh plugin --profile web add /path/to/dsh-model-studio

# Windows PowerShell
dsh plugin --profile web add D:\Coding\Dsh-Plu
```

`dsh plugin` forwards to pnpm inside the profile and then reconciles the profile's bundle list against what is installed, so the plugin joins the layer stack by itself. Then **restart the app and hard-refresh the browser** (Ctrl+Shift+R): bundle layers are composed at boot, and the client bundle is served with a content hash.

```bash
dsh web
```

### B. Offline, without pnpm

`scripts/install.mjs` does the same two steps directly — materialize the package into the profile and declare the dependency plus bundle layer. Use it when pnpm is unavailable, when there is no network, or when a linked install fails to load on Windows.

```bash
node scripts/install.mjs --dry-run                     # report, change nothing
node scripts/install.mjs --profile web                 # copy mode (default)
node scripts/install.mjs --profile web --mode link     # link the checkout instead (development)
```

| Option | Meaning |
|---|---|
| `--profile <name>` | profile to install into (default `web`) |
| `--dsh-home <dir>` | DSH home (default `$DSH_HOME`, else `~/.dsh`) |
| `--source <dir>` | checkout to install from (default: this repository) |
| `--mode <copy\|link>` | copy the package in (default) or link the checkout |
| `--uninstall` | remove the plugin from that profile instead |
| `--dry-run` | print what would change and change nothing |

It reads and writes only `<profile>/package.json` and `<profile>/node_modules/dsh-model-studio`, never `settings.yaml`, and it reports the composed bundle row by reading the profile back. On Windows, prefer the default `copy` mode: a linked package is a directory reparse point that some processes cannot traverse, and the loader then reports `EPERM` for a package it just resolved.

### Verify

```bash
dsh --profile web --dump-config | grep -A1 'id: model-studio'      # POSIX
dsh --profile web --dump-config | Select-String 'dsh-model-studio' # PowerShell
```

One row naming `dsh-model-studio` means the bundle layer composed. In the app, the launcher appears in the sidebar foot directly above Settings; **Settings → Model Studio** always works as well.

### Uninstall

```bash
dsh plugin --profile web remove dsh-model-studio
node scripts/install.mjs --profile web --uninstall   # offline path
```

Removing the plugin does **not** touch your providers, keys or model capabilities: those live in the official settings sections and the credentials store, and they keep working with or without the plugin. If you also want the plugin's own presentation metadata gone, delete the `model-studio:` section from `settings.yaml`.

## 3. Where your data lives

The plugin keeps no configuration file of its own. Anything an existing pi-ai field can express is written back to the official settings, so requests pick it up, the stock Models page sees it, and other plugins do too.

| Field in the UI | Settings location |
|---|---|
| Provider name | `llm-pi-ai.providers.<route>.displayName` |
| API format | `llm-pi-ai.providers.<route>.api` (`openai-completions` / `openai-responses` / `anthropic-messages`; empty = the catalog's protocol) |
| Endpoint | `llm-pi-ai.providers.<route>.baseURL` |
| Managed provider (no credential) | `apiKeyEnv` is left unset on purpose, handing authentication back to the provider |
| API key | `llm-pi-ai.providers.<route>.apiKeyEnv` holds the reference name; the secret goes to the credentials store |
| Display name / requested model id | `llm-pi-ai.providers.<route>.models[].name` / `.id` |
| Context window / output cap | `models[].contextWindow` / `.maxTokens`, with per-route fallbacks |
| Thinking | `models[].reasoningEfforts` (level → wire spelling; `false` marks a non-reasoning model) |
| Image input | `models[].input` (`["text","image"]`) |
| Request headers | `llm-pi-ai.providers.<route>.headers` |
| Default reasoning effort (global strip) | `agent-default-model.reasoningEffort` |
| Built-in DeepSeek thinking gate and effort | `llm-deepseek.thinking` / `llm-deepseek.reasoningEffort` |
| Note / homepage / icon / tags | `model-studio.providers.<route>` — presentation metadata owned by this plugin |

All writes go through the official settings seam: schema-validated, revision-fenced against concurrent edits, atomic, and applied live. The plugin never edits YAML behind the validator's back; when the adapter rejects a change, the panel shows the error in its status line.

### Why the global effort list is short
A reasoning level is an adapter-owned id, and asking a model for a level it does not offer is a **hard error** (`UNSUPPORTED_REASONING_EFFORT`) on every request. The global strip therefore lists only the levels the host's own model catalog reports for the selected route and model, and offers just "not set" when that list is unavailable. If a stored level no longer fits the current default model, the select shows it as *not declared by this model* so you can see and clear it. The strip also says so when the DeepSeek gate cannot affect your default model, which is easy to trip over when the default model runs on a different route.

## 4. Compatibility

| Needs | For | If missing |
|---|---|---|
| sidebar UI | launcher button | falls back to the Settings page |
| right sidebar UI | drawer / docked panel | falls back to the Settings page |
| settings UI | settings binding + page slot | the panel reports that its data plane is unavailable |
| `@deepseek-ai/dsh-llm-pi-ai` | provider field semantics, model discovery | only the JSON view is usable |
| `@deepseek-ai/schemastery` | the host half registering its namespace | the host half stays inactive |

Verified on **dsh 0.1.5-rc.2** (Windows, Node 24). DSH is in developer preview: names and geometry can move between releases.

## 5. Verification status

Green and offline, run from the repository root:

| Suite | Checks | Covers |
|---|---|---|
| `node test/smoke.mjs` | 174 | registration and disposal, slot wiring, locale completeness (both languages), panel rendering in both hosts, tab switching, drawer open/close/dock, class ↔ stylesheet contract, end-to-end reference enrichment, preset pre-fill and create, thinking-level coverage and repair |
| `node test/api.mjs` | 191 | provider derivation, path-operation semantics, capability draft round-trips, discovery merging, header validation, JSON diffing, credential write order, effort/preset resolution, the generated catalog snapshot |
| `node test/host-schema.mjs <profile-dir>` | 15 | the host schema rebuilt and validated from the profile's own module graph, including the minimal document a provider preset writes |

```bash
npm test                                                  # smoke + api
node test/host-schema.mjs "$env:USERPROFILE\.dsh\profiles\web"
```

`test/host-schema.mjs` needs a profile directory only to resolve the peer dependency the way a real install does — it writes nothing.

**Verified:** the host half registers its namespace at boot; the browser half is injected into the boot graph and served through the content-hashed plugin route; the bundle layer composes into the profile tree; installing, uninstalling and reinstalling through `scripts/install.mjs` all converge.

**Not verified here:** pixel geometry in a real browser, and a scripted mouse click-through (edit → save → `settings.yaml`). Rendering, prop plumbing and write semantics are covered by the suites above, but no browser driver was available on the development machine.

## 6. Development

Install into an isolated profile and boot it on a spare port so a running app is untouched:

```bash
node scripts/install.mjs --profile model-studio-dev --mode copy
dsh --profile model-studio-dev --patch dev/plugin-dev-port.yml --no-open
```

`dev/plugin-dev-port.yml` pins the web server to a spare loopback port. After a code change, re-run the install (copy mode refreshes the profile) and restart. `node scripts/install.mjs --profile model-studio-dev --uninstall` removes it again.

### Keeping the provider pre-fill current

The protocol and endpoint the create form pre-fills come from a snapshot of the installed catalog, read straight out of `@earendil-works/pi-ai` and inlined into the browser half. Regenerate it after upgrading DSH:

```bash
npm run catalog:defaults     # reads the catalog of the "web" profile by default
npm run catalog:check        # non-zero when lib/client.js is stale, changes nothing
node scripts/generate-catalog-defaults.mjs --profile web
```

A stale snapshot cannot break a request: a pre-filled value is only written when you change it, so the routes that were never touched keep inheriting from the live catalog. The snapshot's source and date are shown in the form itself.

## License

MIT
