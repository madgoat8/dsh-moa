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

const ANSWER_ROLES = new Set(['user', 'assistant', 'tool'])

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
  if (!text) return null
  if (role === 'tool') {
    if (!message?.toolCallId) return null
    return {
      role: 'tool',
      toolCallId: message.toolCallId,
      content: [{ type: 'text', text }],
      isError: Boolean(message?.isError),
    }
  }
  if (role === 'assistant') {
    // 已带 tool-call 块的 assistant 消息必须原样保留（工具回灌依赖配对）
    if (Array.isArray(message?.content) && message.content.some((b) => b && b.type === 'tool-call')) {
      return {
        role: 'assistant',
        content: message.content,
        source: message?.source ?? { kind: 'model', ...source },
      }
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: message?.source ?? { kind: 'model', ...source },
    }
  }
  return { role: 'user', content: [{ type: 'text', text }] }
}

/**
 * 把 MoA 的 messages 归一化成 DSH 原生形态。
 * 规则：
 *  - 只保留 user / assistant，丢弃 system / tool / toolResult（工具历史对提案无用）
 *  - 合并相邻同角色消息，避免空 assistant 或末尾 assistant
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
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const normalized = normalizeMessage(message, sourceRef)
    if (!normalized) continue
    const last = out[out.length - 1]
    if (last && last.role === normalized.role) {
      const merged = `${contentToText(last.content)}\n\n${contentToText(normalized.content)}`.trim()
      if (normalized.role === 'assistant') {
        out[out.length - 1] = { ...last, content: [{ type: 'text', text: merged }] }
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
  // 没有 system 消息就补一条（内容不能为空，否则 buildParams 会丢弃该消息）
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
              arguments: block.arguments ?? block.args ?? {},
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
              arguments: tc.arguments ?? tc.args ?? {},
            })
          }
        } else if (chunk.type === 'done' && chunk.message) {
          // pi-ai 原生流的终态消息（DSH 适配器路径不产生此事件，重复收集无副作用）
          for (const block of chunk.message.content || []) {
            if ((block.type === 'toolCall' || block.type === 'tool-call') && block.name
              && !toolCalls.some((c) => c.id === block.id)) {
              toolCalls.push({ id: block.id || `call_${toolCalls.length + 1}`, name: block.name, arguments: block.arguments ?? {} })
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
      }
    } catch (err) {
      clearTimeout(timeoutId)
      throw err
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
  const { toolDefs = [], toolCtx = {}, onToolCall = null, ...callArgs } = options
  if (!Array.isArray(toolDefs) || toolDefs.length === 0) {
    return invokeOnce({ ...callArgs, tools: [] })
  }
  const conversation = [...callArgs.messages]
  const toolTrace = []
  let lastResult = null
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const result = await invokeOnce({ ...callArgs, messages: conversation, tools: toolDefs })
    lastResult = result
    const calls = Array.isArray(result.toolCalls) ? result.toolCalls : []
    if (calls.length === 0) return { ...result, toolTrace }
    if (round === MAX_TOOL_ROUNDS) break

    // 工具调用要按 pi-ai 原生形态回灌，否则下一轮会丢失 tool_call/tool_result 配对
    conversation.push({
      role: 'assistant',
      content: [
        ...(result.text ? [{ type: 'text', text: result.text }] : []),
        ...calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      ].filter(Boolean),
    })
    const outputs = []
    const toolResults = []
    for (const call of calls) {
      let output = ''
      try {
        output = await runReadOnlyToolCall(call.name, call.arguments, toolCtx)
      } catch (err) {
        output = `工具执行失败: ${err?.message || String(err)}`
      }
      toolTrace.push({ round, name: call.name, args: call.arguments, ok: !output.startsWith('工具执行失败'), output: output.slice(0, 500) })
      if (typeof onToolCall === 'function') {
        try { onToolCall({ name: call.name, args: call.arguments, output }) } catch { /* noop */ }
      }
      outputs.push(`## 工具 ${call.name} 返回\n${output}`)
      toolResults.push({
        role: 'tool',
        toolCallId: call.id,
        content: [{ type: 'text', text: output }],
        isError: output.startsWith('工具执行失败'),
      })
    }
    // 原生 tool 结果消息 + 一条 user 摘要，保证不依赖工具结果的模型也能继续
    conversation.push(...toolResults)
    conversation.push({ role: 'user', content: outputs.join('\n\n') })
  }
  return { ...lastResult, toolTrace }
}

export function createLlmCaller(ctx) {
  return async ({ provider, model, messages, temperature = 0.6, maxTokens = 2048, timeoutMs, onStreamDelta, signal, stop, reasoningEffort, toolDefs, toolCtx, onToolCall }) =>
    runLlmWithTools({
      ctx, provider, model, messages, temperature, maxTokens, timeoutMs,
      onStreamDelta, signal, stop, reasoningEffort, toolDefs, toolCtx, onToolCall,
    })
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
