import crypto from 'node:crypto'
import path from 'node:path'
import { setLogger, logger } from './logger.js'
import { refreshCatalogInBackground } from './pricing.js'
import {
  PriceRow,
  ModelSlotSchema,
  PresetSchema,
  Config,
  plainConfig,
} from './moa-schema.js'
import { createLlmCaller } from './moa-llm.js'
import {
  parseMoACommand,
  streamMoATurn,
  streamPromoteTurn,
} from './moa-runner.js'
import { registerMoaRoutes } from './routes.js'
import { resolvePresetForPrompt } from './moa-router.js'
import { createLiveCanvasClient } from './live-canvas.js'
import { registerPluginUpdater } from './updater.js'
import { bestEffort } from './best-effort.js'
import { getMoaHistory } from './history.js'

export const name = '@yongfan/dsh-moa'
export { collectProjectContext, formatProjectContext } from './file-workspace.js'
export const inject = ['webServer', 'llm', 'sessions', 'tools']
export const NS = 'dsh-moa'

export {
  PriceRow,
  ModelSlotSchema,
  PresetSchema,
  Config,
  plainConfig,
} from './moa-schema.js'
export { createLlmCaller } from './moa-llm.js'

/**
 * 本地分支：探测宿主能力，构造只读工具运行时。
 *  - bash 执行：优先用 ctx.tools 提供的 bash 工具；不可用时返回 null，工具自动禁用
 *  - web 搜索/抓取：用 ctx.get('web') 的 search / fetch（若已挂载）
 * 任何探测失败都静默降级，保证不影响 MoA 主流程。
 */
function createToolRuntime(ctx, live) {
  const runBash = async (command, options = {}) => {
    const tools = ctx.get?.('tools')
    const bashTool = tools?.get?.('bash') || tools?.byName?.('bash')
    if (bashTool?.execute) {
      const result = await bashTool.execute(
        { command, description: options.description || 'Read-only command from MoA advisor', workdir: options.workdir },
        { signal: options.signal },
      )
      if (typeof result === 'string') return result
      return result?.output || result?.text || JSON.stringify(result?.result ?? result)
    }
    const direct = ctx.get?.('bash')
    if (direct?.execute) {
      const result = await direct.execute(
        { command, description: options.description || 'Read-only command from MoA advisor', workdir: options.workdir },
        { signal: options.signal },
      )
      return typeof result === 'string' ? result : (result?.output || result?.text || JSON.stringify(result))
    }
    throw new Error('宿主未提供 bash 工具执行能力')
  }

  const webService = () => {
    try { return ctx.get?.('web') ?? null } catch { return null }
  }

  // DSH 的 ctx.web.search 契约是 { query, maxResults }（单条查询），
  // 而 MoA 工具层给的是 { queries: [...] }，这里负责逐条翻译并合并结果。
  const webSearch = async (request = {}) => {
    const web = webService()
    if (!web) throw new Error('宿主未挂载 web 服务')
    const queries = Array.isArray(request.queries)
      ? request.queries.filter((q) => typeof q === 'string' && q.trim())
      : (typeof request.query === 'string' && request.query.trim() ? [request.query.trim()] : [])
    if (queries.length === 0) throw new Error('搜索词为空')
    const maxResults = Number.isFinite(request.maxResults) ? request.maxResults : 5
    const searchFn = (q) => (typeof web.search === 'function'
      ? web.search({ query: q, maxResults })
      : (typeof web.runSearch === 'function' ? web.runSearch({ query: q, maxResults }) : Promise.reject(new Error('web 服务没有 search 接口'))))
    const results = []
    for (const q of queries.slice(0, 4)) {
      try {
        const res = await searchFn(q)
        results.push({ query: q, result: res })
      } catch (err) {
        results.push({ query: q, error: err?.message || String(err) })
      }
    }
    if (queries.length === 1) {
      const only = results[0]
      if (only.error) throw new Error(only.error)
      return only.result
    }
    return results
  }

  const webFetch = async (request = {}) => {
    const web = webService()
    if (!web) throw new Error('宿主未挂载 web 服务')
    const url = request.url || request.uri
    if (!url) throw new Error('URL 为空')
    if (typeof web.fetch === 'function') return web.fetch({ ...request, url })
    if (typeof web.runFetch === 'function') return web.runFetch({ ...request, url })
    throw new Error('web 服务没有 fetch 接口')
  }

  return { exec: runBash, webSearch, webFetch }
}

export function apply(ctx, config) {
  if (ctx.logger) setLogger(ctx.logger)
  refreshCatalogInBackground()

  let localOverrides = null
  let baseAtOverride = {}
  const getSourceConfig = () => {
    let liveCandidate = ctx.fiber?.config
    if (!liveCandidate && ('config' in ctx)) {
      bestEffort('ctx.config probe', () => { liveCandidate = ctx.config }, ctx.logger)
    }
    const liveSource = plainConfig(liveCandidate ?? config ?? {})
    if (localOverrides) {
      for (const key of Object.keys(localOverrides)) {
        if (baseAtOverride[key] !== undefined && JSON.stringify(liveSource[key]) !== baseAtOverride[key]) {
          delete localOverrides[key]
          delete baseAtOverride[key]
        }
      }
      if (Object.keys(localOverrides).length === 0) {
        localOverrides = null
      }
    }
    return localOverrides ? { ...liveSource, ...localOverrides } : liveSource
  }
  const live = () => {
    try {
      const raw = getSourceConfig() ?? {}
      const validated = plainConfig(Config(plainConfig(raw)))
      return plainConfig(validated) ?? raw
    } catch {
      return getSourceConfig()
    }
  }

  let settingsService = null

  // Optional policy hook for DSH 0.1.7 settings forms:
  // Suppress auto-generated settings form since dsh-moa provides its own
  // custom settings surface in settings.plugin.item.
  ctx.inject(['settings'], (sctx) => {
    settingsService = sctx.settings
    if (sctx.settings && typeof sctx.settings.configure === 'function') {
      try {
        const dispose = sctx.settings.configure({ auto: false }, ctx.fiber)
        if (typeof sctx.effect === 'function') {
          sctx.effect(() => () => {
            dispose()
            settingsService = null
          }, 'dsh-moa: settings policy')
        }
      } catch {
        // Safe fallback if configure is already registered or throws
      }
    }
  })

  const saveConfig = async (newFields) => {
    const plain = plainConfig(newFields)
    let persisted = false
    if (settingsService && typeof settingsService.replace === 'function') {
      await settingsService.replace(NS, plain)
      persisted = true
    } else if (settingsService && typeof settingsService.update === 'function') {
      await settingsService.update(NS, plain)
      persisted = true
    }
    if (config && typeof config === 'object') {
      for (const [k, v] of Object.entries(plain)) {
        if (config[k] && typeof config[k] === 'object' && typeof config[k].get === 'function') continue
        const desc = Object.getOwnPropertyDescriptor(config, k)
        if (desc && desc.get && !desc.set) continue
        bestEffort('update in-memory config key', () => { config[k] = v }, ctx.logger)
      }
    }
    let liveCandidate = ctx.fiber?.config
    if (!liveCandidate && ('config' in ctx)) {
      bestEffort('ctx.config probe', () => { liveCandidate = ctx.config }, ctx.logger)
    }
    const currentLive = plainConfig(liveCandidate ?? config ?? {})
    baseAtOverride = baseAtOverride || {}
    for (const key of Object.keys(plain)) {
      baseAtOverride[key] = JSON.stringify(currentLive[key])
    }
    localOverrides = { ...(localOverrides || {}), ...plain }
    return { ok: true, persisted, ...live() }
  }

  const callLlm = createLlmCaller(ctx)

  // 本地分支：把 Harness 的 bash / 联网搜索能力适配成 MoA 只读工具可用的形式。
  // 失败一律降级为 null（工具自动不启用），绝不影响主流程。
  const toolRuntime = createToolRuntime(ctx, live)


  // Optional Live Canvas preview client: the harness port is resolved per
  // call and any failure degrades to "no preview link" (live-canvas is not
  // required to be installed).
  const liveCanvas = createLiveCanvasClient({ getPort: () => ctx.webServer?.port })

  // Route: /dsh-moa/status
  // Register one-click updater endpoint
  ctx.effect(() => {
    return registerPluginUpdater(ctx, {
      endpoint: '/api/dsh-moa/update',
      // 本地分支：不使用上游一键更新（会覆盖本地修复）
      packageName: '',
      manifestUrl: new URL('../package.json', import.meta.url),
    })
  }, 'dsh-moa: plugin updater route')

  // Route dispatch: req.method verified fail-closed in lib/routes.js
  registerMoaRoutes(ctx, {
    live,
    callLlm,
    liveCanvas,
    saveConfig,
    Config,
    plainConfig,
    webServerPort: ctx.webServer?.port,
    timeMachineEngine: ctx.reflect?.get?.('timeMachineEngine', false),
    toolRuntime,
  })

  // Session turn interceptor: route turn to real aggregator model & stream MoA synthesis
  ctx.effect(() => {
    return () => {
      for (const entry of moaSessionTurns.values()) {
        if (entry?.ttlTimer) clearTimeout(entry.ttlTimer)
      }
      moaSessionTurns.clear()
    }
  }, 'dsh-moa: session turns cleanup')
  const moaPendingTurns = new WeakMap()
  const moaSessionTurns = new Map()

  function setSessionTurn(sessionId, turnContext) {
    if (!sessionId) return
    const existing = moaSessionTurns.get(sessionId)
    if (existing?.ttlTimer) clearTimeout(existing.ttlTimer)

    // TTL (3 minutes) to prevent memory leaks if turn is aborted or skipped before llm/stream
    const ttlTimer = setTimeout(() => {
      moaSessionTurns.delete(sessionId)
    }, 180000)
    ttlTimer.unref?.()

    moaSessionTurns.set(sessionId, { ...turnContext, ttlTimer })
  }

  function getSessionTurn(sessionId) {
    if (!sessionId) return null
    return moaSessionTurns.get(sessionId) || null
  }

  function consumeSessionTurn(sessionId) {
    if (!sessionId) return null
    const entry = moaSessionTurns.get(sessionId)
    if (entry) {
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer)
      moaSessionTurns.delete(sessionId)
    }
    return entry
  }

  ctx.effect(() => {
    return ctx.on('agent/pre-step', async (event, next) => {
      const messages = event.messages || []
      const lastUserMsg = [...messages].reverse().find((m) => m && m.role === 'user')
      const userText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content.trim()
        : (Array.isArray(lastUserMsg?.content)
            ? lastUserMsg.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n').trim()
            : '')

      if (userText.startsWith('/moa')) {
        const cfg = live()
        if (cfg.enabled !== false) {
          const effectiveDefault = cfg.default_preset || 'default'
          const parsed = parseMoACommand(userText, cfg.presets || [], effectiveDefault) || { prompt: userText, presetName: effectiveDefault, isExplicit: false }
          if (parsed.isPromote) {
            let promoteRunId = parsed.runId
            if (!promoteRunId) {
              const latestRun = getMoaHistory(1, 0)?.runs?.[0]
              if (latestRun?.id) promoteRunId = latestRun.id
            }
            const sessCwd = event.cwd || event.session?.cwd || (event.session?.path ? path.dirname(event.session.path) : undefined) || process.cwd()
            const turnContext = {
              isPromoteTurn: true,
              runId: promoteRunId,
              candidateIndex: parsed.candidateIndex,
              cwd: sessCwd,
              webServerPort: ctx.webServer?.port,
              timeMachineEngine: ctx.reflect?.get?.('timeMachineEngine', false),
            }
            if (event.signal) moaPendingTurns.set(event.signal, turnContext)
            if (event.session?.id) setSessionTurn(event.session.id, turnContext)
            return next()
          }
          const isExplicitPreset = Boolean(parsed.isExplicit || userText.includes('--preset') || userText.includes('-p '))
          if (!isExplicitPreset && (cfg.smart_routing_enabled || cfg.presets?.some((p) => p.smart_routing_enabled))) {
            try {
              const activePreset = (cfg.presets || []).find((p) => p.name === (parsed.presetName || effectiveDefault)) || cfg.presets?.[0]
              const routingModel = (activePreset?.smart_routing_model?.model && activePreset.smart_routing_model)
                || (cfg.smart_routing_model?.model && cfg.smart_routing_model) || activePreset?.smart_routing_model || cfg.smart_routing_model
              const routed = await resolvePresetForPrompt({
                prompt: parsed.prompt || userText,
                presets: cfg.presets || [],
                defaultPreset: parsed.presetName || effectiveDefault,
                routingModel,
                callLlm,
                enabled: true,
              })
              if (routed?.isAutoRouted && routed.presetName) {
                parsed.presetName = routed.presetName
              }
            } catch {
              // fallback silently
            }
          }
          const targetPreset = (cfg.presets || []).find((p) => p.name === (parsed.presetName || effectiveDefault))
            || (!isExplicitPreset ? (cfg.presets || []).find((p) => p.name === effectiveDefault) || cfg.presets?.[0] : null)
          if (!targetPreset) {
            logger.warn(`[dsh-moa] Unknown explicit preset "${parsed.presetName}" in /moa command.`)
            return next()
          }
          const aggProvider = targetPreset?.aggregator?.provider || ''
          const aggModel = targetPreset?.aggregator?.model || ''
          const sessCwd = event.cwd || event.session?.cwd || (event.session?.path ? path.dirname(event.session.path) : undefined) || process.cwd()
          const runId = crypto.randomUUID()

          const turnContext = {
            runId,
            targetPreset,
            userPrompt: parsed.prompt || userText,
            messages: messages.slice(0, -1),
            cwd: sessCwd,
            aggregator: { provider: aggProvider, model: aggModel },
            callLlm,
            prices: cfg.prices || {},
            liveCanvas,
            webServerPort: ctx.webServer?.port,
            timeMachineEngine: ctx.reflect?.get?.('timeMachineEngine', false),
            webSearch: toolRuntime.webSearch,
            webFetch: toolRuntime.webFetch,
          }

          if (event.signal) {
            moaPendingTurns.set(event.signal, turnContext)
          }
          if (event.session?.id) {
            setSessionTurn(event.session.id, turnContext)
          }
        }
      }

      return next()
    })
  }, 'dsh-moa: agent pre-step interceptor')

  ctx.effect(() => {
    return ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const turnContext = (payload.signal ? moaPendingTurns.get(payload.signal) : null)
        || (payload.session?.id ? getSessionTurn(payload.session.id) : null)

      if (turnContext && !turnContext.isPromoteTurn) {
        return {
          ...resolved,
          provider: turnContext.aggregator?.provider || resolved.provider,
          model: turnContext.aggregator?.model || resolved.model,
        }
      }
      return resolved
    })
  }, 'dsh-moa: agent request interceptor')

  ctx.effect(() => {
    return ctx.on('llm/stream', (options, next) => {
      const turnContext = (options.signal ? moaPendingTurns.get(options.signal) : null)
        || (options.session?.id ? consumeSessionTurn(options.session.id) : null)

      if (turnContext) {
        if (options.signal) moaPendingTurns.delete(options.signal)
        if (options.session?.id) consumeSessionTurn(options.session.id)

        if (turnContext.isPromoteTurn) {
          return streamPromoteTurn(turnContext, options)
        }
        return streamMoATurn(turnContext, options)
      }

      return next(options)
    })
  }, 'dsh-moa: llm stream interceptor')
}

export { executeTestGateForCandidates, runCandidateTestGate } from './moa-test-gate.js'
export {
  COMPANION_PLUGINS,
  formatFileScoresDirective,
  parseFileScores,
  findTopModel,
  assembleWorkbenchSelection,
  handleWorkbenchGet,
  handleWorkbenchAssemble,
} from './moa-workbench.js'
