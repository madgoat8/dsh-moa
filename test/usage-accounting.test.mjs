import test from 'node:test'
import assert from 'node:assert/strict'

import { createLlmCaller } from '../lib/moa-llm.js'

/**
 * 构造一个假的 ctx.llm：每次 prepareCall → stream 返回脚本化的事件序列。
 * rounds 是每轮返回的 chunk 数组，依次消耗。
 */
function fakeCtx(rounds) {
  let i = 0
  return {
    llm: {
      async prepareCall() {
        const chunks = rounds[Math.min(i, rounds.length - 1)]
        i += 1
        return {
          config: { provider: 'p', model: 'm' },
          stream() {
            return (async function* () {
              for (const c of chunks) yield c
            })()
          },
        }
      },
    },
  }
}

const usageChunk = (input, output) => ({ type: 'usage', usage: { inputTokens: input, outputTokens: output } })

test('单轮无工具调用：返回文本与 usage', async () => {
  const ctx = fakeCtx([[{ type: 'text-delta', text: 'hello' }, usageChunk(10, 5)]])
  const call = createLlmCaller(ctx)
  const r = await call({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'q' }], toolDefs: [] })
  assert.equal(r.text, 'hello')
  assert.equal(r.usage.inputTokens, 10)
  assert.equal(r.usage.outputTokens, 5)
})

test('多轮工具调用：usage 逐轮累加（回归：曾只保留最后一轮）', async () => {
  const round1 = [
    { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'a.js' } } },
    usageChunk(100, 20),
  ]
  const round2 = [
    { type: 'text-delta', text: 'done' },
    usageChunk(200, 30),
  ]
  const ctx = fakeCtx([round1, round2])
  const call = createLlmCaller(ctx)
  const r = await call({
    provider: 'p', model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    toolDefs: [{ name: 'read_file', description: 'x', parameters: { type: 'object' } }],
    // 让工具执行失败即可（不依赖真实文件系统），但调用统计仍要计上
    toolCtx: { cwd: '/nonexistent-dir-for-test' },
  })
  assert.equal(r.toolRounds, 1)
  assert.equal(r.usage.inputTokens, 300, '两轮 input 必须相加')
  assert.equal(r.usage.outputTokens, 50, '两轮 output 必须相加')
  assert.equal(r.usage.totalTokens, 350)
})

test('轮次耗尽时额外强制作答的那一轮也要计入 usage', async () => {
  const toolRound = [
    { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'a' } } },
    usageChunk(10, 1),
  ]
  const forced = [{ type: 'text-delta', text: 'final' }, usageChunk(7, 3)]
  const ctx = fakeCtx([toolRound, toolRound, forced])
  const call = createLlmCaller(ctx)
  const r = await call({
    provider: 'p', model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    toolDefs: [{ name: 'read_file', description: 'x', parameters: { type: 'object' } }],
    toolCtx: { cwd: '/nonexistent-dir-for-test' },
    maxToolRounds: 2,
  })
  assert.equal(r.text, 'final')
  assert.equal(r.usage.inputTokens, 27, '3 轮 input 相加')
  assert.equal(r.usage.outputTokens, 5)
})

test('失败的工具调用只补一条简短引导，不重复投喂工具结果', async () => {
  const calls = []
  const ctx = {
    llm: {
      async prepareCall() {
        return {
          config: {},
          stream(opts) {
            calls.push(opts)
            const round = calls.length
            return (async function* () {
              if (round === 1) {
                yield { type: 'block-end', block: { type: 'tool-call', id: 'c1', name: 'read_file', arguments: { path: 'nope' } } }
              } else {
                yield { type: 'text-delta', text: 'ok' }
              }
              yield usageChunk(1, 1)
            })()
          },
        }
      },
    },
  }
  const call = createLlmCaller(ctx)
  await call({
    provider: 'p', model: 'm',
    messages: [{ role: 'user', content: 'q' }],
    toolDefs: [{ name: 'read_file', description: 'x', parameters: { type: 'object' } }],
    toolCtx: { cwd: '/nonexistent-dir-for-test' },
  })
  const secondRoundMessages = calls[1].messages
  const asText = JSON.stringify(secondRoundMessages)
  assert.ok(asText.includes('tool'), '第二轮必须带 tool 结果消息')
  assert.ok(!asText.includes('## 工具 read_file 返回'), '不得再拼一份重复的工具结果文本')
  assert.ok(asText.includes('请修正参数或换一个工具'), '失败时必须给出修正引导')
})

test('空响应仍抛 EMPTY_RESPONSE', async () => {
  const ctx = fakeCtx([[usageChunk(1, 0)]])
  const call = createLlmCaller(ctx)
  await assert.rejects(
    () => call({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'q' }], toolDefs: [] }),
    (err) => err.code === 'EMPTY_RESPONSE',
  )
})
