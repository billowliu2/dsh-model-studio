/**
 * HOST half of dsh-model-studio.
 *
 * It owns exactly one thing: the plugin's own settings namespace, where the
 * metadata no llm-pi-ai field can express lives (a provider's note, its
 * homepage, its icon, its tags). Everything pi-ai *can* express is written by
 * the browser half into the `llm-pi-ai` namespace instead, so the request path
 * picks it up directly and the stock Models page sees it too.
 *
 * Why a namespace rather than a side file: registering through `ctx.settings`
 * buys schema validation, revision fencing (`SETTINGS_CONFLICT`), live reload
 * and the shared client mirror for free, and it keeps user configuration in the
 * one file DSH already treats as the source of truth.
 *
 * This package ships plain JavaScript with no build step and no runtime
 * dependencies; `@deepseek-ai/schemastery` is a peer dependency resolved from
 * the profile that mounts the plugin.
 *
 * @module dsh-model-studio
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name (diagnostics only; the bundle row id is `model-studio`). */
export const name = 'dsh-model-studio'

/** The settings namespace this plugin owns. */
const NAMESPACE = 'model-studio'

/**
 * Services this plugin needs. `settings` is mandatory: without the settings
 * seam there is nowhere to register the namespace, so the plugin stays
 * unmounted rather than half-alive.
 */
export const inject = ['settings']

/** Runtime schema for the plugin's deployment-time configuration. */
export const Config = z.object({
  /** Set false to mount the bundle without registering anything. */
  enabled: z.boolean().default(true),
})

/** Metadata for one provider route, keyed by that route in `providers`. */
const ProviderMeta = z.object({
  /** Free-form operator note ("公司专用账号"). */
  note: z.string().default(''),
  /** Documentation link shown in the provider header. */
  homepage: z.string().default(''),
  /** Icon reference (a short preset key or a data URL). */
  icon: z.string().default(''),
  /** Case-insensitive labels; the display spelling is preserved as first entered. */
  tags: z.array(z.string()).default([]),
})

/**
 * What this plugin stores. Deliberately free of secrets: the settings file is
 * plain text whose redactor never inspects this section, so an API key must go
 * through `ctx.credentials` and be referenced from `apiKeyEnv` instead.
 */
const StudioSchema = z.object({
  /** Per-provider presentation metadata, keyed by route id. */
  providers: z.dict(ProviderMeta),
  /** Browser-view preferences that must survive a reload. */
  ui: z.object({
    /** Route the studio last showed. */
    lastProvider: z.string().default(''),
    /** Launcher placement: the sidebar foot row, or a floating button. */
    launcher: z.string().default('footer'),
  }),
})

/**
 * Register the plugin-owned settings namespace.
 *
 * Registration has no disposer (it lives as long as the settings provider), so
 * a hot reload that re-applies this plugin must not register a second time —
 * the namespace is already there and its schema is unchanged.
 *
 * @param {object} ctx - host context carrying the settings service.
 * @param {object} [config] - resolved plugin configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('model-studio: disabled by configuration')
    return
  }
  const registered = ctx.settings
    .describe()
    .some((descriptor) => descriptor.ns === NAMESPACE)
  if (registered) {
    ctx.logger?.info?.(`model-studio: settings namespace "${NAMESPACE}" already registered`)
    return
  }
  ctx.settings.register(NAMESPACE, StudioSchema, { applies: 'live' })
  ctx.logger?.info?.(`model-studio: settings namespace "${NAMESPACE}" registered`)
}
