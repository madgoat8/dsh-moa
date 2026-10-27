// lib/moa-parser.js
// Parsers for model outputs, winner selection, commands, and code blocks for @goodandready/dsh-moa.

/**
 * Extracts candidate winner index from judge output.
 * Looks for machine marker WINNER_CANDIDATE_INDEX: N first, then conversational fallbacks.
 */
export function parseWinnerIndex(judgeText, defaultIndex = 1, candidateCount = Infinity) {
  if (!judgeText || typeof judgeText !== 'string') return defaultIndex
  const inRange = (idx) => !isNaN(idx) && idx >= 1 && idx <= candidateCount
  const match = /WINNER_CANDIDATE_INDEX:\s*(\d+)/i.exec(judgeText)
  if (match) {
    const idx = parseInt(match[1], 10)
    if (inRange(idx)) return idx
  }
  const candMatch = /(?:Кандидат|Candidate|Reference)\s*(\d+)\b/i.exec(judgeText)
  if (candMatch) {
    const idx = parseInt(candMatch[1], 10)
    if (inRange(idx)) return idx
  }
  return defaultIndex
}

/**
 * Parses the recommended assembler model index and label from curator output.
 */
export function parseRecommendedAssembler(judgeText, defaultIndex = 1, candidateCount = Infinity) {
  if (!judgeText || typeof judgeText !== 'string') return { index: defaultIndex, label: '' }
  const inRange = (idx) => !isNaN(idx) && idx >= 1 && idx <= candidateCount
  const match = /RECOMMENDED_ASSEMBLER:\s*(\d+)(?:\s*\(([^)]+)\))?/i.exec(judgeText)
  if (match) {
    const idx = parseInt(match[1], 10)
    if (inRange(idx)) {
      return { index: idx, label: match[2]?.trim() || '' }
    }
  }
  return { index: defaultIndex, label: '' }
}

/**
 * Parses a `/moa [preset] <prompt>` command invocation.
 */
export function parseMoACommand(text, presets = [], defaultPreset = undefined) {
  if (typeof text !== 'string' || !text.startsWith('/moa')) {
    return null
  }

  // Check for promote subcommand: /moa promote <runId> <candidateIndex> or /moa promote <candidateIndex>
  const promoteMatch = /^\/moa\s+promote\s+([a-zA-Z0-9_\-]+)(?:\s+(\d+))?/i.exec(text.trim())
  if (promoteMatch) {
    const hasTwoArgs = Boolean(promoteMatch[2])
    return {
      isPromote: true,
      runId: hasTwoArgs ? promoteMatch[1] : null,
      candidateIndex: hasTwoArgs ? parseInt(promoteMatch[2], 10) : parseInt(promoteMatch[1], 10),
    }
  }

  const remainder = text.slice(4).trim()
  if (!remainder) {
    return {
      presetName: defaultPreset,
      prompt: '',
      isExplicit: false,
    }
  }

  const matchPreset = /^--preset(?:=|\s+)([a-zA-Z0-9_-]+)\s*(.*)/s.exec(remainder)
  if (matchPreset) {
    return {
      presetName: matchPreset[1],
      prompt: matchPreset[2] || '',
      isExplicit: true,
    }
  }

  const matchShortPreset = /^-p\s+([a-zA-Z0-9_-]+)\s*(.*)/s.exec(remainder)
  if (matchShortPreset) {
    return {
      presetName: matchShortPreset[1],
      prompt: matchShortPreset[2] || '',
      isExplicit: true,
    }
  }

  const parts = remainder.split(/\s+/)
  const firstWord = parts[0]
  if (Array.isArray(presets)) {
    const matched = presets.find((p) => p.name === firstWord)
    if (matched) {
      return {
        presetName: matched.name,
        prompt: parts.slice(1).join(' ').trim(),
        isExplicit: true,
      }
    }
  }

  return {
    presetName: defaultPreset,
    prompt: remainder,
    isExplicit: false,
  }
}

/**
 * Replaces large code blocks with concise file/code summaries to avoid token waste and huge chat dumps.
 *
 * 只用于**展示**（聊天里的 candidate 回复、已 promote 的合成结果）。
 * 给 judge/裁判喂候选内容时必须用 `renderCandidateForJudge`：那里把代码块换成占位符
 * 等于让裁判在看不到代码的情况下评优劣（local.5 修）。
 */
export function stripOrSummarizeCode(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/```([a-zA-Z0-9_\-\.\/]*)\s*([\w\.\/\-]+\.[a-zA-Z0-9]+)?\n([\s\S]*?)```/g, (match, lang, fileTag, code) => {
    const lines = code.trim().split('\n')
    if (lines.length <= 3 && !/html|jsx|tsx|vue|svelte|css|js|ts/i.test(lang)) {
      return match
    }
    const fileHint = fileTag || (code.match(/^\s*(?:\/\/|#|<!--|\/\*)\s*(?:file|filepath|path):\s*([^\s*]+)/im)?.[1])
    const label = fileHint ? `file \`${fileHint}\`` : (lang ? `code \`${lang}\`` : 'code')
    return `\n> 📄 *[${label} - ${lines.length} lines saved to disk]*\n`
  })
}

/** 裁判侧候选内容的默认 token 预算（每候选）。 */
export const JUDGE_CANDIDATE_TOKEN_BUDGET = 8000

/** 粗略 token 估算（chars/3.2，与 moa-context 同口径）。 */
function roughTokens(text) {
  return Math.ceil(String(text || '').length / 3.2)
}

/**
 * 把一条候选回复渲染进裁判 prompt。
 *
 * 与 `stripOrSummarizeCode` 的根本区别：**代码是裁判判断的主要依据**，因此这里
 *  - 预算内：原样完整给出（含代码块）；
 *  - 超预算：保留头尾 + **代码块原文**（按块均分剩余预算），只裁散文化部分；
 *  - 明确告诉裁判"已省略多少字符"，而不是假装内容就只有这么多。
 *
 * @param {object} candidate 候选结果对象（需要 .text）
 * @param {object} options { budgetTokens, filesWritten }
 */
export function renderCandidateForJudge(candidate, options = {}) {
  const text = String(candidate?.text || '')
  const budget = Number(options.budgetTokens) > 0 ? Number(options.budgetTokens) : JUDGE_CANDIDATE_TOKEN_BUDGET
  const budgetChars = budget * 3.2
  if (text.length <= budgetChars) return text

  const blocks = []
  const re = /```([a-zA-Z0-9_\-\.\/]*)\s*([\w\.\/\-]+\.[a-zA-Z0-9]+)?\n([\s\S]*?)```/g
  let match
  while ((match = re.exec(text)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length, full: match[0] })
  }
  if (blocks.length === 0) {
    // 没有代码块：头尾截断，中间标注省略量。
    const half = Math.floor(budgetChars / 2)
    return `${text.slice(0, half)}\n[... ${text.length - 2 * half} chars omitted — full text is on disk under .moa/<runId>/candidate-N/ ...]\n${text.slice(-half)}`
  }

  // 先给代码块留足预算（每块均分，至少 400 字符），剩余给散文。
  const perCodeShare = Math.max(400, Math.floor((budgetChars * 0.7) / blocks.length))
  const proseBudget = Math.max(400, Math.floor(budgetChars * 0.3))
  const proseSlots = blocks.length + 1
  const perProse = Math.max(200, Math.floor(proseBudget / proseSlots))

  const out = []
  let cursor = 0
  const pushProse = (segment) => {
    if (!segment) return
    if (segment.length <= perProse) {
      out.push(segment)
    } else {
      const head = Math.floor(perProse * 0.7)
      const tail = perProse - head
      out.push(`${segment.slice(0, head)}\n[... ${segment.length - perProse} chars omitted ...]\n${segment.slice(-tail)}`)
    }
  }
  for (const block of blocks) {
    pushProse(text.slice(cursor, block.start))
    let codeBlock = block.full
    if (codeBlock.length > perCodeShare) {
      // 代码块本体也超预算时：保留开头（签名/配置/主体）与结尾（收尾/导出），
      // 不要静默替换成"已保存到磁盘"的占位符。
      const head = Math.floor(perCodeShare * 0.6)
      const tail = perCodeShare - head
      codeBlock = `${codeBlock.slice(0, head)}\n[... ${codeBlock.length - perCodeShare} chars of code omitted ...]\n${codeBlock.slice(-tail)}`
    }
    out.push(codeBlock)
    cursor = block.end
  }
  pushProse(text.slice(cursor))
  return out.join('')
}

/**
 * Formats user-facing markdown response for synthesis, questions, and failure kinds.
 */
export function formatMoAResponse({ moaResult, presetName }) {
  const parts = []
  const pName = presetName || moaResult?.presetName || 'default'
  const judge = moaResult?.aggregator || 'unknown'
  const refs = moaResult?.references || []

  if (moaResult?.kind === 'questions') {
    parts.push('## 🧠 Mixture of Agents — Requirements Clarification')
    parts.push(`*Judge (${judge}) and the advisors analyzed the task:*\n`)
    parts.push(moaResult.content)
    return parts.join('\n')
  }

  if (moaResult?.kind === 'failure') {
    parts.push('## ⚠️ Mixture of Agents — Execution Failed')
    parts.push(moaResult.content)
    return parts.join('\n')
  }

  const modeBadge = moaResult?.isFastMode
    ? '⚡ Fast Mode'
    : (moaResult?.isCuratorSynthesis ? `🧠 Curator: ${judge}` : `Judge: ${judge}`)
  parts.push(`## 🧠 Mixture of Agents (Preset: ${pName} | ${modeBadge})`)
  parts.push('')

  if (moaResult?.isRefinement) {
    parts.push('> 🔄 **Mode**: Iterative project refinement (Refinement)')
  }

  if (moaResult?.skippedFiles > 0) {
    const preview = moaResult.skippedList?.slice(0, 3)?.join(', ') || ''
    const more = (moaResult.skippedList?.length || 0) > 3 ? ` and ${(moaResult.skippedList?.length || 0) - 3} more` : ''
    parts.push(`> ⚠️ **Workspace Notice**: ${moaResult.skippedFiles} file(s) skipped during workspace scan (${preview}${more}). Context representation may be partial.`)
  }

  const hasPromoted = moaResult?.promotedFiles && moaResult.promotedFiles.length > 0
  if (hasPromoted) {
    parts.push(`> 📦 **Files created in the project**: \`${moaResult.promotedFiles.join('`, `')}\``)
  }

  if (moaResult?.recommendedAssembler?.label) {
    parts.push(`> 🎯 **Recommended Master Assembler**: Candidate ${moaResult.recommendedAssembler.index} (\`${moaResult.recommendedAssembler.label}\`)`)
  }

  if (moaResult?.liveCanvas?.previewUrl) {
    parts.push(`> 🎨 **Live Canvas**: [🚀 Open ${moaResult.liveCanvas.title || 'preview'} in Live Canvas](${moaResult.liveCanvas.previewUrl}) | [↗ Open in new tab](${moaResult.liveCanvas.previewUrl})`)
  }

  // Cost tracking card
  if (moaResult?.usage) {
    const u = moaResult.usage
    const costStr = u.totalCostUsd > 0 ? `~\$${u.totalCostUsd.toFixed(4)}` : 'Free'
    const tokStr = u.totalTokens >= 1000 ? `${(u.totalTokens / 1000).toFixed(1)}k` : `${u.totalTokens}`
    parts.push(`> 💰 **Run cost**: ${costStr} (${tokStr} tokens total)`)
  }

  parts.push('')

  if (!moaResult?.isFastMode) {
    parts.push(`### ⚖️ Judge verdict and final synthesis (Synthesis: ${judge})`)
    parts.push('')
    const cleanJudgeContent = hasPromoted
      ? stripOrSummarizeCode(moaResult?.content || '')
      : (moaResult?.content || '(no response)')
    parts.push(cleanJudgeContent)
    parts.push('')
  }

  if (Array.isArray(refs) && refs.length > 0) {
    const title = moaResult?.isFastMode ? '### 🚀 Candidate generation result:' : `### 👥 Advisor responses (${refs.length}):`
    parts.push(title)
    parts.push('')
    refs.forEach((ref, i) => {
      const statusIcon = ref.ok ? '✅' : '⚠️'
      const fileBadge = ref.files?.length ? ` (${ref.files.length} file${ref.files.length > 1 ? 's' : ''})` : ''
      const costBadge = ref.costUsd > 0 ? ` [~\$${ref.costUsd.toFixed(4)}]` : ''
      parts.push(`#### ${statusIcon} Model ${i + 1}: ${ref.label}${fileBadge}${costBadge}`)
      parts.push('')
      parts.push(stripOrSummarizeCode(ref.text))
      parts.push('')
      parts.push('---')
      parts.push('')
    })
  }

  if (moaResult?.allowCandidateOverride && refs.length > 1) {
    const runId = moaResult?.runId || ''
    parts.push('### 🔄 Candidate Override Actions')
    parts.push('To apply an alternative candidate\'s files instead of the judge\'s pick:')
    refs.forEach((ref, idx) => {
      const isWinner = (idx + 1) === moaResult.winningIndex
      const tag = isWinner ? ' *(Current Judge Pick)*' : ''
      const promoteCmd = runId ? `/moa promote ${runId} ${idx + 1}` : `/moa promote ${idx + 1}`
      parts.push(`- \`${promoteCmd}\` — Candidate ${idx + 1} (${ref.label})${tag}`)
    })
    parts.push('')
  }

  return parts.join('\n')
}
