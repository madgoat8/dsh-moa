import test from 'node:test'
import assert from 'node:assert/strict'

import { streamMoATurn } from '../lib/moa-stream.js'

const baseTurn = {
  messages: [],
  cwd: '/tmp/moa-stream-test',
  prices: {},
  webServerPort: null,
  timeMachineEngine: null,
  force: false,
}

const preset = (over = {}) => ({
  name: 'default',
  reference_models: [{ provider: 'p', model: 'm' }],
  aggregator: { provider: 'p', model: 'm' },
  reference_timeout_sec: 5,
  aggregator_timeout_sec: 5,
  ...over,
})

async function collect(turn) {
  const events = []
  for await (const ev of streamMoATurn(turn, {})) events.push(ev)
  return events
}

test('全部候选失败：以 finish{kind:error} 结束，而不是 stop', async () => {
  const events = await collect({
    ...baseTurn,
    targetPreset: preset(),
    userPrompt: 'hi',
    callLlm: async () => { throw new Error('provider 400') },
  })
  const finish = events.find((e) => e.type === 'finish')
  assert.ok(finish, '必须有 finish 事件')
  assert.equal(finish.reason.kind, 'error', '失败回合不能被记成成功')
  assert.equal(finish.reason.failure.code, 'MOA_ALL_REFERENCE_FAILED')
})

test('预算熔断是用户配置的守卫生效，仍以 stop 正常结束', async () => {
  const events = await collect({
    ...baseTurn,
    targetPreset: preset({ budget_guard_enabled: true, max_budget_usd: 0.0000001, budget_action: 'abort' }),
    userPrompt: 'hi',
    callLlm: async () => { throw new Error('should not be called on abort') },
  })
  const finish = events.find((e) => e.type === 'finish')
  assert.ok(finish)
  assert.equal(finish.reason.kind, 'stop')
})

test('成功回合以 stop 结束', async () => {
  const events = await collect({
    ...baseTurn,
    targetPreset: preset(),
    userPrompt: 'hi',
    callLlm: async () => ({ content: 'answer', usage: { inputTokens: 1, outputTokens: 1 } }),
  })
  const finish = events.find((e) => e.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
})
