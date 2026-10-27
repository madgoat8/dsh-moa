/**
 * DSH 原生消息适配层（本地分支新增）
 *
 * 背景：MoA 的历史消息由 cleanAdvisoryMessages / pruneMultiTurnMessages 规范成
 * { role, content: string }，但 DSH 0.2.x 的 ctx.llm → pi-ai 适配器要求的是
 * harness 原生形态：
 *   - content 必须是 ContentBlock[]（[{ type:'text', text }]）
 *   - assistant 消息必须带 source: { kind:'model', provider, model }，
 *     否则 pi-ai 的 transformMessages / hasToolHistory 会对字符串 content
 *     调用 .flatMap / .some 并抛 TypeError。
 *
 * 本模块把任意形态的 messages 归一化成 DSH 能吃的形态，并剥掉工具历史，
 * 因为 MoA 的候选/裁判模型只做纯文本提案，不需要工具调用能力。
 */

import { runReadOnlyToolCall, describeReadOnlyTools, DEFAULT_READ_ONLY_TOOLS, MAX_TOOL_ROUNDS } from './moa-tools.js'

const ANSWER_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/**
 * 归一化工具调用参数。
 *
 * pi-ai 在不同路径下会给出三种形态：
 *   1. 已解析对象        { queries: [...] }
 *   2. 原始 JSON 字符串  '{"queries":[...]}'
 *   3. 流式半截字符串    '{"queries":["a","b'  （partialArgs 未闭合）
 *
 * 这里尽量救回 2 和 3，救不回来才抛错，并在错误里带上原始入参。
 */
export function parseToolArguments(raw) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw
  const text = String(raw).trim()
  if (!text) return {}
  const attempts = [text]
  // 半截 JSON：补齐括号后再试一次
  const repaired = repairTruncatedJson(text)
  if (repaired !== text) attempts.push(repaired)
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* try next */ }
  }
  return { __raw: text }
}

/** 尝试给截断的 JSON 补齐引号与括号。 */
function repairTruncatedJson(text) {
  let out = text
  let inString = false
  let escaped = false
  for (const ch of text) {
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString }
  }
  if (inString) out += '"'
  const opens = []
  let str = false
  let esc = false
  for (const ch of out) {
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { str = !str; continue }
    if (str) continue
    if (ch === '{' || ch === '[') opens.push(ch)
    if (ch === '}' || ch === ']') opens.pop()
  }
  while (opens.length > 0) {
    const open = opens.pop()
    out += open === '{' ? '}' : ']'
  }
  return out
}


/** 把任意 content 取成可见纯文本。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
  }
  return ''
}

/**
 * 归一化一条消息为 DSH 原生形态。
 * @param message 任意来源的消息
 * @param source  assistant 消息要写入的 source（provider/model）
 */
function normalizeMessage(message, source) {
  const role = message?.role
  if (!ANSWER_ROLES.has(role)) return null
  const text = contentToText(message?.content).trim()

  // system：保留（local.5 修复）。此前 system 不在 ANSWER_ROLES 里，候选/裁判的
  // SYSTEM_ROLE_PROPOSER + persona + 项目上下文在 cleanAdvisoryMessages 阶段就被丢掉，
  // attachToolsToSystem 只能补一句 "You are a helpful assistant."，
  // 导致 TOOL_USAGE_DIRECTIVE / 角色人格 / 项目快照从未到达模型。
  if (role === 'system') {
    if (!text) return null
    return { role: 'system', content: [{ type: 'text', text }] }
  }

  if (role === 'tool') {
    if (!message?.toolCallId) return null
    if (!text) return null
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      content: [{ type: 'text', text }],
      isError: Boolean(message?.isError),
    }
  }

  if (role === 'assistant') {
    // 带 tool-call 的 assistant 消息必须保留：即使正文为空（模型本轮只发起工具调用），
    // 丢掉它会让下面的 tool 消息成为孤立的 tool-result，pi-ai/OpenAI 会直接 400。
    const blocks = Array.isArray(message?.content) ? message.content.filter(Boolean) : []
    const hasToolCall = blocks.some((b) => b && (b.type === 'tool-call' || b.type === 'toolCall'))
    if (hasToolCall) {
      const content = text ? [{ type: 'text', text }, ...blocks.filter((b) => b.type !== 'text')] : blocks
      return {
        role: 'assistant',
        content,
        source: message?.source ?? { kind: 'model', ...source },
      }
    }
    if (!text) return null
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: message?.source ?? { kind: 'model', ...source },
    }
  }

  if (!text) return null
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * 把 MoA 的 messages 归一化成 DSH 原生形态。
 * 规则：
 *  - 保留 system / user / assistant / tool；丢弃其它角色
 *  - 相邻同角色合并，但 **system 与 assistant(含 tool-call) 永不合并**：
 *    前者是前缀锚点（合并会让 toolsAdded 挂错位置），后者是 tool-result 的配对锚点
 *  - 保证最后一条是 user（部分上游拒绝以 assistant 结尾）
 * @param messages 原始消息
 * @param source 候选/裁判模型的 provider 与 model
 * @returns 可直接交给 ctx.llm 的消息数组
 */
export function toHarnessMessages(messages, source = {}) {
  const sourceRef = {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model: typeof source.model === 'string' ? source.model : '',
  }
  const hasToolCall = (m) => m.role === 'assistant'
    && Array.isArray(m.content)
    && m.content.some((b) => b && (b.type === 'tool-call' || b.type === 'toolCall'))
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const normalized = normalizeMessage(message, sourceRef)
    if (!normalized) continue
    const last = out[out.length - 1]
    if (last && last.role === normalized.role && normalized.role !== 'system' && !hasToolCall(last) && !hasToolCall(normalized)) {
      const merged = `${contentToText(last.content)}\n\n${contentToText(normalized.content)}`.trim()
      if (normalized.role === 'assistant') {
        out[out.length - 1] = { ...last, content: [{ type: 'text', text: merged }] }
      } else if (normalized.role === 'tool') {
        // tool 消息带各自 toolCallId，合并会破坏配对：直接追加。
        out.push(normalized)
      } else {
        out[out.length - 1] = { role: 'user', content: [{ type: 'text', text: merged }] }
      }
      continue
    }
    out.push(normalized)
  }
  if (out.length === 0 || out[out.length - 1].role !== 'user') {
    out.push({ role: 'user', content: [{ type: 'text', text: '(empty)' }] })
  }
  return out
}

/** 校验消息数组是否已是 DSH 原生形态，用于日志诊断。 */
export function describeMessageShapes(messages) {
  return (Array.isArray(messages) ? messages : []).map((m, i) => ({
    index: i,
    role: m?.role,
    content: Array.isArray(m?.content) ? `array(${m.content.length})` : typeof m?.content,
    hasSource: Boolean(m?.source),
  }))
}

function combineSignals(signal, timeoutSignal) {
  if (!signal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') {
    try {
      return AbortSignal.any([signal, timeoutSignal])
    } catch {
      // fallback if signal is not an instance of AbortSignal
    }
  }
  const combinedCtrl = new AbortController()
  const onAbort = () => {
    const reason = signal.aborted ? (signal.reason || new Error('Turn aborted')) : timeoutSignal.reason
    combinedCtrl.abort(reason)
  }
  if (signal.aborted || timeoutSignal.aborted) {
    onAbort()
    return combinedCtrl.signal
  }
  signal.addEventListener?.('abort', onAbort, { once: true })
  timeoutSignal.addEventListener?.('abort', onAbort, { once: true })
  return combinedCtrl.signal
}

/**
 * Unified LLM Dispatcher using ctx.llm.prepareCall / stream
 */

/**
 * 把工具声明挂到首条 system 消息的 toolsAdded 上（pi-ai 唯一识别的入口）。
 * @param messages DSH 原生消息数组
 * @param tools [{ name, description, parameters }]
 */
export function attachToolsToSystem(messages, tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return messages
  const declarations = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters || { type: 'object', properties: {} },
  }))
  const list = [...messages]
  if (list.length > 0 && list[0].role === 'system') {
    list[0] = { ...list[0], toolsAdded: declarations }
    return list
  }
  // 没有 system 消息就补一条（内容不能为空，否则 buildParams 会丢弃该消息）。
  // local.5 起正常路径都带 system，这里只是兜底，占位文案保持中性，
  // 避免覆盖掉候选真正的人格/守则。
  return [{ role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }], toolsAdded: declarations }, ...list]
}

/**
 * 单次模型调用（不含工具循环）。返回 { text, toolCalls, usage }。
 * 这是原 createLlmCaller 的内核，被 runLlmWithTools 复用。
 */
async function invokeOnce({
  ctx, provider, model, messages, temperature, maxTokens, timeoutMs,
  onStreamDelta, signal, stop, reasoningEffort, tools = [],
}) {
    if (!ctx.llm) {
      throw new Error('ctx.llm is not available in cordis context')
    }

    // 关键修复：把 MoA 生成的纯文本历史转成 DSH 原生块数组 + assistant.source
    const harnessMessages = toHarnessMessages(messages, { provider, model })

    const callConfig = {
      provider,
      model,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    }

    let prep
    try {
      // DSH 0.2.0-rc.2 API expects LlmCallConfig object, supports signal
      prep = await ctx.llm.prepareCall(callConfig, signal)
    } catch (err) {
      if (typeof ctx.llm.prepareCall === 'function') {
        try {
          prep = await ctx.llm.prepareCall(provider, model)
        } catch {
          throw err
        }
      } else {
        throw err
      }
    }
    if (!prep || typeof prep.stream !== 'function') {
      throw new Error(`LLM provider/model ${provider}:${model} could not be prepared`)
    }

    if (signal?.aborted) {
      throw (signal.reason || new Error('Turn aborted'))
    }

    const effectiveTimeoutMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120000
    const abortCtrl = new AbortController()
    const timeoutId = setTimeout(() => abortCtrl.abort(new Error(`LLM call timeout after ${Math.round(effectiveTimeoutMs / 1000)}s`)), effectiveTimeoutMs)
    timeoutId.unref?.()
    const combinedSignal = combineSignals(signal, abortCtrl.signal)

    try {
      const streamConfig = prep.config || callConfig
      // pi-ai 的 openai-completions 只从 **system 消息的 toolsAdded** 读取工具声明，
      // context.tools 会被忽略。这里把工具挂到首条 system 消息上，
      // 否则模型永远看不到工具（实测 curl 直连网关能正常返回 tool_calls）。
      const messagesWithTools = attachToolsToSystem(harnessMessages, tools)
      const stream = prep.stream({
        ...streamConfig,
        messages: messagesWithTools,
        // 工具声明由 createLlmCaller 决定（默认空数组 = 纯文本提案）
        tools,
        temperature: streamConfig.temperature ?? temperature,
        maxTokens: streamConfig.maxTokens ?? maxTokens,
        signal: combinedSignal,
      })

      let fullText = ''
      let reasoningText = ''
      let usageInfo = null
      const toolCalls = []

      for await (const chunk of stream) {
        if (combinedSignal?.aborted) {
          throw (combinedSignal.reason || new Error('Turn aborted'))
        }
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          fullText += chunk.text
          if (typeof onStreamDelta === 'function') {
            onStreamDelta(chunk.text)
          }
        } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // 纯推理模型可能把 maxTokens 全用在思考上，记录下来便于诊断
          reasoningText += chunk.text
        } else if (chunk.type === 'block-end' && chunk.block) {
          const block = chunk.block
          if (block.type === 'tool-call' || block.type === 'toolCall') {
            toolCalls.push({
              id: block.id || `call_${toolCalls.length + 1}`,
              name: block.name,
              arguments: parseToolArguments(block.arguments ?? block.args),
              rawArguments: typeof (block.arguments ?? block.args) === 'string' ? (block.arguments ?? block.args) : undefined,
            })
          } else if (block.text && !fullText) {
            fullText = block.text
          }
        } else if (chunk.type === 'toolcall_end' || chunk.type === 'tool_call_end') {
          // pi-ai 原生流事件（DSH 适配器会把它转成 block-end）
          const tc = chunk.toolCall || chunk.block || chunk
          if (tc?.name) {
            toolCalls.push({
              id: tc.id || `call_${toolCalls.length + 1}`,
              name: tc.name,
              arguments: parseToolArguments(tc.arguments ?? tc.args),
              rawArguments: typeof (tc.arguments ?? tc.args) === 'string' ? (tc.arguments ?? tc.args) : undefined,
            })
          }
        } else if (chunk.type === 'done' && chunk.message) {
          // pi-ai 原生流的终态消息（DSH 适配器路径不产生此事件，重复收集无副作用）
          for (const block of chunk.message.content || []) {
            if ((block.type === 'toolCall' || block.type === 'tool-call') && block.name
              && !toolCalls.some((c) => c.id === block.id)) {
              toolCalls.push({
                id: block.id || `call_${toolCalls.length + 1}`,
                name: block.name,
                arguments: parseToolArguments(block.arguments),
                rawArguments: typeof block.arguments === 'string' ? block.arguments : undefined,
              })
            }
            if (block.type === 'text' && block.text && !fullText) fullText = block.text
            if (block.type === 'thinking' && block.thinking) reasoningText += block.thinking
          }
          if (chunk.message.stopReason === 'error') {
            const err = new Error(chunk.message.errorMessage || 'LLM stream error')
            err.code = 'LLM_ERROR'
            throw err
          }
        } else if (chunk.type === 'usage' && chunk.usage) {
          usageInfo = chunk.usage
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
            const failure = reason.failure || {}
            const errMsg = failure.message || failure.error?.message || reason.message || reason.error?.message || `LLM stream finished with ${reason.kind}`
            const err = new Error(errMsg)
            err.code = failure.code || reason.code || (reason.kind === 'error' ? 'LLM_ERROR' : 'ABORT_ERR')
            if (failure.cause) err.cause = failure.cause
            throw err
          }
        } else if (chunk.type === 'error') {
          const errMsg = chunk.error?.message || chunk.message || 'LLM stream error'
          const err = new Error(errMsg)
          err.code = chunk.code || chunk.error?.code || 'LLM_ERROR'
          if (chunk.error?.cause) err.cause = chunk.error.cause
          throw err
        }
      }

      if (combinedSignal?.aborted) {
        throw (combinedSignal.reason || new Error('Turn aborted'))
      }

      if (!fullText.trim() && toolCalls.length === 0) {
        // 给出可诊断的空响应：区分"模型什么都没说"和"思考吃完了 maxTokens"
        const detail = reasoningText.trim()
          ? `（模型输出了 ${reasoningText.length} 字符推理但无正文，多半是 max_tokens=${maxTokens} 被推理吃满，建议调大 max_tokens 或换非推理模型）`
          : '（模型未输出任何内容）'
        const err = new Error(`LLM call returned empty response ${detail}`)
        err.code = 'EMPTY_RESPONSE'
        throw err
      }

      clearTimeout(timeoutId)
      return {
        content: fullText,
        text: fullText,
        toolCalls,
        usage: usageInfo || {
          inputTokens: Math.round(JSON.stringify(harnessMessages).length / 4),
          outputTokens: Math.round(fullText.length / 4),
        },
      }    } catch (err) {
      clearTimeout(timeoutId)
      throw err
    }
}

/**
 * 事实类问题识别（本地分支新增）。
 *
 * 只在「问题在问事实」时才考虑强制核查，避免干扰方案规划类对话。
 */
const FACTUAL_PATTERNS = [
  /最新版本|哪个版本|版本号|多少版本|latest version|which version/i,
  /多少钱|价格|收费|pricing|cost/i,
  /什么时候发布|发布日期|release date|when was .* released/i,
  /是否支持|支持[^，。？\n]{0,12}吗|支不支持|does .* support|is .* supported/i,
  /有多少|多少个|how many/i,
  /谁是|who is|who owns/i,
]

export function isFactualQuestion(userPrompt = '') {
  const text = String(userPrompt || '')
  if (!text.trim()) return false
  return FACTUAL_PATTERNS.some((re) => re.test(text))
}

/** 回答里是否出现具体版本号/日期，用于判断「疑似凭记忆作答」。 */
function looksLikeFactClaim(text = '') {
  const value = String(text || '')
  return /\bv?\d+\.\d+(\.\d+)?(-[a-z0-9.]+)?\b/i.test(value)
    || /\b20\d{2}[-/年]\d{1,2}/.test(value)
}

/**
 * 事实类问题强制核查轮（本地分支新增）。
 *
 * 触发条件（全满足才触发，避免误伤）：
 *   1. 用户问题被判定为事实类
 *   2. 该候选一次工具都没调用
 *   3. 回答里出现了具体版本号/日期（疑似凭记忆作答）
 * 触发后用「只给 web 工具 + 强制核查」的方式重跑一次。
 */
async function maybeForceVerification({ result, userPrompt, toolDefs, verifyOptions }) {
  if (!verifyOptions?.enabled) return result
  if (result?.toolTrace?.length > 0) return result
  const candidateTools = Array.isArray(verifyOptions.availableTools) && verifyOptions.availableTools.length > 0
    ? verifyOptions.availableTools
    : (toolDefs || [])
  const factualTool = candidateTools.filter((t) => t.name === 'web_search' || t.name === 'web_fetch')
  if (factualTool.length === 0) {
    if (typeof verifyOptions.onProgress === 'function') {
      verifyOptions.onProgress('⚠️ *No web tools available — factual claims could not be verified.*\n')
    }
    return result
  }
  if (!isFactualQuestion(userPrompt)) return result
  if (!looksLikeFactClaim(result?.text)) return result
  try {
    if (typeof verifyOptions.onProgress === 'function') {
      verifyOptions.onProgress('🧾 *Answer contained unverified facts without any tool call — forcing one verification round...*\n')
    }
    const verified = await runLlmWithTools({
      ...verifyOptions.callArgs,
      messages: [
        ...(verifyOptions.callArgs.messages || []),
        { role: 'assistant', content: result.text },
        {
          role: 'user',
          content: 'You answered with specific version/date values but never used a tool. '
            + 'Verify them now with web_search or web_fetch. If you cannot verify, keep the answer but prefix each unverified value with [unverified].',
        },
      ],
      toolDefs: factualTool,
      maxRounds: 2,
      toolTrace: null,
    })
    const mergedTrace = [...(result.toolTrace || []), ...(verified.toolTrace || [])]
    return { ...verified, toolTrace: mergedTrace, verificationForced: true }
  } catch {
    return result
  }
}

/**
 * 带只读工具的多轮调用器。
 *
 * 流程：模型返回 tool-call → 本地执行只读工具 → 结果以 user 消息回灌 → 重新调用，
 * 直到模型给出正常文本或达到 MAX_TOOL_ROUNDS 上限。
 *
 * @param options 同 createLlmCaller 的参数，另加 toolDefs / toolCtx
 * @returns { content, text, usage, toolTrace }
 */
async function runLlmWithTools(options) {
  const { toolDefs = [], toolCtx = {}, onToolCall = null, maxRounds = MAX_TOOL_ROUNDS, ...callArgs } = options
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
    const plain = await invokeOnce({ ...callArgs, tools: [] })
    return { ...plain, toolTrace: [], toolRounds: 0 }
  }
  const conversation = [...callArgs.messages]
  const toolTrace = []
  // 同一个 (工具名 + 参数) 只执行一次；重复请求直接回灌上次结果，
  // 避免模型陷入「同一调用反复重试」的死循环（实测会烧掉 4 轮）。
  const cache = new Map()
  let lastResult = null
  // 逐轮累加 usage（local.5）：此前只保留最后一次 invokeOnce 的 usage，
  // 多轮工具调用的前几轮 token 全部丢失 → 成本系统性少报。
  const usageTotal = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const foldUsage = (result) => {
    const u = result?.usage
    if (!u) return
    const input = Number(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens ?? 0) || 0
    const output = Number(u.outputTokens ?? u.completionTokens ?? u.completion_tokens ?? 0) || 0
    usageTotal.inputTokens += input
    usageTotal.outputTokens += output
    usageTotal.totalTokens += Number(u.totalTokens ?? 0) || (input + output)
    const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.cacheHitTokens ?? 0) || 0
    if (cached > 0) usageTotal.cacheHitTokens = (usageTotal.cacheHitTokens || 0) + cached
  }

  for (let round = 0; round <= maxRounds; round++) {
    const result = await invokeOnce({ ...callArgs, messages: conversation, tools: toolDefs })
    lastResult = result
    foldUsage(result)
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : []
    if (calls.length === 0) {
      return { ...result, usage: usageTotal, toolTrace, toolRounds: round }
    }
    if (round === maxRounds) {
      // 轮次用尽：强制作答，不再给工具，避免模型继续要求调用
      const forced = await invokeOnce({ ...callArgs, messages: conversation, tools: [] })
      foldUsage(forced)
      return { ...forced, usage: usageTotal, toolTrace, toolRounds: round, truncated: true }
    }

    conversation.push({
      role: 'assistant',
      content: [
        ...(result.text ? [{ type: 'text', text: result.text }] : []),
        ...calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      ].filter(Boolean),
    })

    const toolResults = []
    for (const call of calls) {
      const key = `${call.name}:${stableKey(call.arguments)}`
      // 参数为空说明模型没表达清楚，这次失败不具备复用价值：
      // 既不写缓存，也不阻止下一轮带着新参数重试。
      const hasArgs = call.arguments && typeof call.arguments === 'object'
        && Object.keys(call.arguments).filter((k) => k !== '__raw').length > 0
      let output
      let ok = true
      const cached = hasArgs ? cache.get(key) : null
      if (cached) {
        output = `[相同调用已执行过，复用上次结果]\n${cached.output}`
      } else {
        try {
          output = await runReadOnlyToolCall(call.name, call.arguments, toolCtx)
          ok = true
        } catch (err) {
          output = `工具执行失败: ${err?.message || String(err)}\n原始入参: ${JSON.stringify(call.rawArguments ?? call.arguments).slice(0, 300)}`
          ok = false
        }
        if (hasArgs) cache.set(key, { output, ok })
      }
      toolTrace.push({
        round, name: call.name, args: call.arguments,
        ok, repeated: Boolean(cached), output: String(output).slice(0, 500),
      })
      if (typeof onToolCall === 'function') {
        try { onToolCall({ name: call.name, args: call.arguments, output, repeated: Boolean(cached), round }) } catch { /* noop */ }
      }
      toolResults.push({
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: String(output) }],
        isError: !ok,
      })
    }
    conversation.push(...toolResults)
    // 工具结果已经通过上面的 tool 消息回灌，不要再拼一份 "## 工具 X 返回" 的 user 文本
    // （local.5：重复投喂既浪费 token 又会让模型把同一结果读两遍）。
    // 这里只补一条失败引导，且仅在确有失败时。
    const failedCount = toolTrace.filter((t) => t.round === round && !t.ok && !t.repeated).length
    if (failedCount > 0) {
      conversation.push({
        role: 'user',
        content: '注意：上面有工具调用失败，请修正参数或换一个工具，不要重复相同调用。',
      })
    }
  }
  return { ...lastResult, usage: usageTotal, toolTrace, toolRounds: maxRounds }
}

/** 参数对象的稳定序列化，用于重复调用去重。 */
function stableKey(value) {
  try {
    const normalize = (v) => {
      if (Array.isArray(v)) return v.map(normalize)
      if (v && typeof v === 'object') {
        return Object.keys(v).sort().reduce((acc, k) => { acc[k] = normalize(v[k]); return acc }, {})
      }
      return typeof v === 'string' ? v.trim() : v
    }
    return JSON.stringify(normalize(value ?? {}))
  } catch {
    return String(value)
  }
}

export function createLlmCaller(ctx) {
  return async ({ provider, model, messages, temperature = 0.6, maxTokens = 2048, timeoutMs, onStreamDelta, signal, stop, reasoningEffort, toolDefs, verifyTools, toolCtx, onToolCall, maxToolRounds, userPrompt, forceVerification }) => {
    const callArgs = {
      ctx, provider, model, messages, temperature, maxTokens, timeoutMs,
      onStreamDelta, signal, stop, reasoningEffort, toolCtx, onToolCall,
    }
    const result = await runLlmWithTools({
      ...callArgs,
      toolDefs,
      maxRounds: typeof maxToolRounds === 'number' && maxToolRounds > 0 ? maxToolRounds : MAX_TOOL_ROUNDS,
    })
    return maybeForceVerification({
      result,
      userPrompt: userPrompt || '',
      toolDefs: toolDefs || [],
      verifyOptions: {
        enabled: forceVerification !== false,
        availableTools: verifyTools || toolDefs || [],
        onProgress: onToolCall ? (msg) => { try { onToolCall({ notice: msg }) } catch { /* noop */ } } : null,
        callArgs,
      },
    })
  }
}

export function callConfigEquals(a, b) {
  if (!a || !b) return false
  if (a.provider !== b.provider) return false
  if (a.model !== b.model) return false
  if (a.temperature !== b.temperature) return false
  if (a.maxTokens !== b.maxTokens) return false
  if (a.reasoningEffort !== b.reasoningEffort) return false
  return true
}
