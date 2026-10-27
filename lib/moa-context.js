/**
 * Multi-Turn Conversation Memory & Context Pruning
 * Feature 8 (Multi-Turn Continuity)
 */

/** 把任意形态的 content 取成可见纯文本（不 JSON.stringify：那会把 reasoning /
 *  tool-call 元数据当正文喂进 prompt）。 */
function plainText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return content.text
    if (typeof content.content === 'string') return content.content
  }
  return ''
}

/**
 * Extracts concise prior turn baseline from previous conversation messages.
 */
export function extractPriorTurnBaseline(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return null

  // Find the last assistant message. DSH 0.2.x assistant.content 是 ContentBlock[]，
  // 只接受 string 会让多轮基线恒为 null（多轮连续性实际变成死代码）。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const text = plainText(msg.content).trim()
    if (text.length > 0) {
      // Strip out noisy banners if present
      const cleaned = text
        .replace(/^#+\s*🏆[^\n]+\n/m, '')
        .replace(/<!--\s*moa-metadata[\s\S]*?-->/g, '')
        .trim()
      return cleaned.slice(0, 3500)
    }
  }
  return null
}

/**
 * Prunes conversation history for candidate fan-out to prevent token ballooning
 * while preserving multi-turn context continuity.
 */
export function pruneMultiTurnMessages(messages = [], maxHistoryTokens = 3000) {
  if (!Array.isArray(messages) || messages.length <= 2) {
    return messages || []
  }

  const pruned = []
  const sysMsg = messages.find((m) => m && m.role === 'system')
  if (sysMsg) {
    pruned.push(sysMsg)
  }

  // Get conversation turns excluding system
  const nonSys = messages.filter((m) => m && m.role !== 'system')
  if (nonSys.length === 0) return pruned

  // Always keep up to the final 4 turns (last 2 user + assistant pairs)
  const recentTurns = nonSys.slice(-4)

  // Calculate dynamic character budget derived from maxHistoryTokens (approx 4 chars per token)
  const totalCharBudget = Math.max(1200, (Number(maxHistoryTokens) || 3000) * 4)
  const maxTurnChars = Math.max(400, Math.floor(totalCharBudget / recentTurns.length))
  const maxHead = Math.floor(maxTurnChars * 0.75)
  const maxTail = Math.max(50, maxTurnChars - maxHead)

  for (let idx = 0; idx < recentTurns.length; idx++) {
    const msg = recentTurns[idx]
    const isLatest = idx === recentTurns.length - 1
    // 只取可见文本：块数组里的 reasoning / tool-call 元数据不是对话内容。
    const content = plainText(msg.content)

    if (isLatest || content.length <= maxTurnChars) {
      pruned.push(msg)
    } else {
      // Prune long prior assistant or user text to protect candidate context
      const truncated = content.slice(0, maxHead) + '\n\n[...context pruned for token efficiency...]\n' + content.slice(-maxTail)
      pruned.push({
        role: msg.role,
        content: truncated,
      })
    }
  }

  return pruned
}

/**
 * 粗略 token 估算（chars/3.2，对中英混排偏保守）。
 * 与 Hermes 的 `estimate_messages_tokens_rough` 同一思路：只用来判断"要不要裁"，
 * 不需要精确。
 */
export function estimateMessagesTokens(messages = []) {
  let chars = 0
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue
    chars += plainText(msg.content).length
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && (part.type === 'tool-call' || part.type === 'toolCall')) {
          chars += JSON.stringify(part.arguments ?? {}).length
        }
      }
    }
  }
  return Math.ceil(chars / 3.2)
}

/** 默认给输出留的 token 预算（与 Hermes `_REFERENCE_DEFAULT_OUTPUT_RESERVE` 一致）。 */
export const DEFAULT_OUTPUT_RESERVE = 8192

/** 估算误差的安全边距（Hermes 用 10%）。 */
export const TRIM_SAFETY_FRACTION = 0.10

/**
 * 按 advisor **自己的**上下文窗口裁剪消息（对齐 Hermes `_trim_messages_for_reference`）。
 *
 * 为什么要按槽位裁：advisor 的窗口可能远小于聚合器（262K 的 advisor 看 1M 的会话），
 * 超窗会吃 provider 的硬 400，而调用方通常把 400 转成"[failed: …]"注记 ——
 * 于是"少一个 advisor"这件事对用户完全不可见。
 *
 * 规则：
 *  - 保留首条 system（前缀锚点），从最旧的消息开始丢
 *  - 丢弃后若起始是 assistant，继续丢到 user 开头（assistant 开头的对话会被严格上游拒绝）
 *  - 至少保留尾部 user 一条 + 一条前序消息，即使仍超预算
 *  - `contextLength <= 0`（窗口未知）时原样返回，不做猜测性裁剪
 *
 * @returns { messages, trimmed, dropped, budget, contextLength }
 */
export function trimMessagesForAdvisor(messages = [], contextLength = 0, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const reserve = Number.isFinite(options.reserveOutputTokens) && options.reserveOutputTokens > 0
    ? options.reserveOutputTokens
    : DEFAULT_OUTPUT_RESERVE
  const safety = Number.isFinite(options.safetyFraction) && options.safetyFraction > 0
    ? options.safetyFraction
    : TRIM_SAFETY_FRACTION

  const result = { messages: list, trimmed: false, dropped: 0, estimated: 0, budget: 0, contextLength }
  if (list.length === 0 || !Number.isFinite(contextLength) || contextLength <= 0) return result

  const budget = Math.floor(contextLength * (1 - safety)) - reserve
  const estimated = estimateMessagesTokens(list)
  result.budget = budget
  result.estimated = estimated
  // budget <= 0 表示"连输出预留都塞不进这个窗口"（例如窗口 8k 而 maxTokens 8192）：
  // 这仍然是超窗，必须裁到最小保留集，而不是原样发出去等 400。
  if (estimated <= budget) return result

  const hasSystem = list.length > 0 && list[0].role === 'system'
  const headCount = hasSystem ? 1 : 0
  const weights = list.map((m) => estimateMessagesTokens([m]))
  let total = estimated
  let start = headCount
  let remaining = list.length - headCount

  while (remaining > 2 && total > budget) {
    total -= weights[start]
    start += 1
    remaining -= 1
    while (remaining > 2 && list[start]?.role === 'assistant') {
      total -= weights[start]
      start += 1
      remaining -= 1
    }
  }
  // 循环可能停在"只剩两条且首条是 assistant"：即使如此也要保证 user 开头。
  while (remaining > 1 && list[start]?.role === 'assistant') {
    total -= weights[start]
    start += 1
    remaining -= 1
  }

  const trimmed = [...list.slice(0, headCount), ...list.slice(start)]
  result.messages = trimmed
  result.trimmed = start > headCount
  result.dropped = list.length - trimmed.length
  return result
}
