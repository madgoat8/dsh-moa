import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanAdvisoryMessages, ADVISORY_INSTRUCTION, ADVISORY_TOOL_RESULT_BUDGET } from '../lib/moa-prompts.js'
import { toHarnessMessages, attachToolsToSystem } from '../lib/moa-llm.js'

test('advisory 视图保留 system（候选的人格/守则不能丢）', () => {
  const out = cleanAdvisoryMessages([
    { role: 'system', content: 'SYSTEM RULES' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(out[0].role, 'system')
  assert.equal(out[0].content, 'SYSTEM RULES')
})

test('system + persona 能一路到达 final 请求（回归：曾被替换成 "helpful assistant"）', () => {
  const adv = cleanAdvisoryMessages([
    { role: 'system', content: 'SYSTEM RULES\nPERSONA' },
    { role: 'user', content: 'q' },
  ])
  const final = attachToolsToSystem(toHarnessMessages(adv, { provider: 'p', model: 'm' }), [
    { name: 'web_search', description: 'x', parameters: { type: 'object' } },
  ])
  assert.equal(final[0].role, 'system')
  const serialized = JSON.stringify(final)
  assert.ok(serialized.includes('SYSTEM RULES'), 'system 正文必须存在')
  assert.ok(serialized.includes('PERSONA'), 'persona 必须存在')
  assert.ok(final[0].toolsAdded, 'toolsAdded 必须挂在首条 system 上')
})

test('tool-call 内联、tool-result 折叠进前一条 assistant', () => {
  const out = cleanAdvisoryMessages([
    { role: 'user', content: '读 a.js' },
    { role: 'assistant', content: [{ type: 'text', text: '先读' }, { type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'a.js' } }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'AAA' }] },
  ])
  // user → assistant(折叠) → 合成 user 指令（尾随 assistant 会被当 prefill）
  assert.equal(out.length, 3)
  assert.equal(out[0].role, 'user')
  assert.equal(out[1].role, 'assistant')
  assert.ok(out[1].content.includes('先读'))
  assert.ok(out[1].content.includes('[called tool: read_file({"path":"a.js"})]'))
  assert.ok(out[1].content.includes('[tool result: AAA]'))
})

test('tool-result 超预算时头尾保留并标注省略量', () => {
  const huge = 'z'.repeat(ADVISORY_TOOL_RESULT_BUDGET * 3)
  const out = cleanAdvisoryMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: huge }] },
  ])
  const folded = out[1].content
  assert.ok(folded.length < huge.length, '必须被截断')
  assert.match(folded, /chars omitted/)
})

test('只发起工具调用的 assistant（正文为空）必须保留，否则 tool 消息孤立', () => {
  const adv = cleanAdvisoryMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'grep_files', arguments: { pattern: 'x' } }] },
  ])
  assert.equal(adv[1].role, 'assistant')
  assert.ok(adv[1].content.includes('[called tool: grep_files'))
})

test('纯图片 user 轮替换为占位符而不是丢弃', () => {
  const out = cleanAdvisoryMessages([
    { role: 'user', content: [{ type: 'image', data: '...' }] },
  ])
  assert.equal(out[0].role, 'user')
  assert.match(out[0].content, /non-text content/)
})

test('advisory 以 user 结尾（防 Anthropic 把尾随 assistant 当 prefill）', () => {
  const out = cleanAdvisoryMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ])
  assert.equal(out.at(-1).role, 'user')
  assert.equal(out.at(-1).content, ADVISORY_INSTRUCTION)
})

test('toHarnessMessages 保留 system 且不合并它', () => {
  const out = toHarnessMessages([
    { role: 'system', content: 'S1' },
    { role: 'system', content: 'S2' },
    { role: 'user', content: 'u' },
  ], { provider: 'p', model: 'm' })
  assert.equal(out[0].role, 'system')
  assert.equal(out[1].role, 'system', '两条 system 各自保留（合并会让 toolsAdded 挂错位置）')
})

test('toHarnessMessages 为 tool 消息保留 toolCallId 配对', () => {
  const out = toHarnessMessages([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 't', arguments: {} }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'R' }] },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'R2' }] },
  ], { provider: 'p', model: 'm' })
  const tools = out.filter((m) => m.role === 'tool')
  assert.equal(tools.length, 2, 'tool 消息不得互相合并（各自 toolCallId 不同）')
  assert.equal(tools[0].toolCallId, 'c1')
  assert.equal(tools[1].toolCallId, 'c2')
})

test('toHarnessMessages 不以 assistant 结尾', () => {
  const out = toHarnessMessages([{ role: 'assistant', content: 'a' }], { provider: 'p', model: 'm' })
  assert.equal(out.at(-1).role, 'user')
})

test('空消息数组得到一条 user，而不是空请求', () => {
  const out = toHarnessMessages([], { provider: 'p', model: 'm' })
  assert.equal(out.length, 1)
  assert.equal(out[0].role, 'user')
})
