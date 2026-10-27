import test from 'node:test'
import assert from 'node:assert/strict'

import {
  trimMessagesForAdvisor,
  estimateMessagesTokens,
  extractPriorTurnBaseline,
  pruneMultiTurnMessages,
  DEFAULT_OUTPUT_RESERVE,
} from '../lib/moa-context.js'
import { resolveModelContextLength } from '../lib/pricing.js'

const big = (n, tag) => `${tag} ` + 'x'.repeat(n)

function history() {
  return [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: big(4000, 'q1') },
    { role: 'assistant', content: big(4000, 'a1') },
    { role: 'user', content: big(4000, 'q2') },
    { role: 'assistant', content: big(4000, 'a2') },
    { role: 'user', content: 'q3 latest' },
  ]
}

test('窗口未知（0）时原样返回，不做猜测性裁剪', () => {
  const msgs = history()
  const r = trimMessagesForAdvisor(msgs, 0)
  assert.equal(r.messages, msgs)
  assert.equal(r.trimmed, false)
})

test('超窗时从最旧开始丢，保留 system 头部', () => {
  const r = trimMessagesForAdvisor(history(), 12000)
  assert.equal(r.trimmed, true)
  assert.ok(r.dropped > 0)
  assert.equal(r.messages[0].role, 'system')
})

test('裁剪后仍以 user 开头（system 之后）且以 user 结尾', () => {
  const r = trimMessagesForAdvisor(history(), 12000)
  const body = r.messages[0].role === 'system' ? r.messages.slice(1) : r.messages
  assert.equal(body[0].role, 'user', 'assistant 开头会被严格上游拒绝')
  assert.equal(r.messages.at(-1).role, 'user')
})

test('预算为负（窗口小于输出预留）时仍裁到最小保留集，而不是原样发出', () => {
  const r = trimMessagesForAdvisor(history(), 8000, { reserveOutputTokens: 8192 })
  assert.ok(r.budget < 0)
  assert.equal(r.trimmed, true, '超窗必须裁，不能因为预算为负就跳过')
  assert.ok(r.messages.length <= 2)
  assert.equal(r.messages[0].role, 'system')
  assert.equal(r.messages.at(-1).role, 'user')
})

test('窗口充足时不裁剪', () => {
  const r = trimMessagesForAdvisor(history(), 200000)
  assert.equal(r.trimmed, false)
  assert.equal(r.messages.length, 6)
})

test('空数组与非法窗口值是安全的', () => {
  assert.equal(trimMessagesForAdvisor([], 8000).trimmed, false)
  assert.equal(trimMessagesForAdvisor(history(), NaN).trimmed, false)
  assert.equal(trimMessagesForAdvisor(history(), -5).trimmed, false)
})

test('estimateMessagesTokens 计正文与工具入参，不把 reasoning 元数据算进去', () => {
  const a = estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(320) }])
  assert.equal(a, 100)
  const withCall = estimateMessagesTokens([
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'x'.repeat(3200) },
      { type: 'tool-call', name: 't', arguments: { a: 'b' } },
    ] },
  ])
  assert.ok(withCall < 100, '推理块不应计入')
})

test('resolveModelContextLength：显式槽位优先，其次目录，最后 0', () => {
  assert.equal(resolveModelContextLength({ provider: 'p', model: 'm', context_window: 32000 }), 32000)
  assert.ok(resolveModelContextLength({ provider: 'magpie', model: 'workbuddy-ai/hy4-preview' }) > 0)
  assert.equal(resolveModelContextLength({ provider: 'no-such', model: 'zzz-unknown-xyz' }), 0)
})

test('extractPriorTurnBaseline 接受块数组（DSH 0.2.x），不再恒为 null', () => {
  const baseline = extractPriorTurnBaseline([
    { role: 'assistant', content: [{ type: 'text', text: '上一轮结论' }] },
  ])
  assert.equal(baseline, '上一轮结论')
})

test('pruneMultiTurnMessages 未超限时原样保留（不做无谓改写）', () => {
  const input = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'visible' }] },
    { role: 'user', content: 'q2' },
  ]
  const out = pruneMultiTurnMessages(input, 3000)
  assert.equal(out.at(-1).content, 'q2')
  assert.ok(JSON.stringify(out).includes('visible'))
})

test('pruneMultiTurnMessages 裁剪长消息时只取可见文本，不把 reasoning 元数据当正文', () => {
  const long = 'V'.repeat(20000)
  const out = pruneMultiTurnMessages([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'SECRET_REASONING' }, { type: 'text', text: long }] },
    { role: 'user', content: 'q2' },
  ], 3000)
  const prunedAssistant = out.find((m) => m.role === 'assistant')
  assert.equal(typeof prunedAssistant.content, 'string', '裁剪后必须是纯文本')
  assert.ok(prunedAssistant.content.includes('context pruned'))
  assert.ok(!prunedAssistant.content.includes('SECRET_REASONING'), 'reasoning 不得进入 prompt')
  assert.ok(!prunedAssistant.content.includes('"type":"reasoning"'), '不得 JSON.stringify 元数据')
})

test('默认输出预留与 Hermes 对齐（8192）', () => {
  assert.equal(DEFAULT_OUTPUT_RESERVE, 8192)
})
