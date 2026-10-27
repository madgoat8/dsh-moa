import test from 'node:test'
import assert from 'node:assert/strict'

import { renderCandidateForJudge, stripOrSummarizeCode, JUDGE_CANDIDATE_TOKEN_BUDGET } from '../lib/moa-parser.js'
import { buildSynthesisPrompt, buildPeerCritiquePrompt, buildCuratorSynthesisPrompt } from '../lib/moa-prompts.js'

const code = 'export function f(){ return 42 }\n'.repeat(400)

test('预算内：原文完整返回', () => {
  const cand = { text: 'short answer' }
  assert.equal(renderCandidateForJudge(cand), 'short answer')
})

test('超预算且含代码块：代码原文保留，不用 "saved to disk" 占位符', () => {
  const out = renderCandidateForJudge({ text: `说明\n\`\`\`js file="a.js"\n${code}\`\`\`\n结论` })
  assert.ok(out.includes('export function f(){ return 42 }'), '代码必须可见')
  assert.ok(!out.includes('saved to disk'), '不得替换成占位符')
})

test('超预算无代码块：头尾保留并标注省略量', () => {
  const text = 'p'.repeat(100000)
  const out = renderCandidateForJudge({ text })
  assert.ok(out.length < text.length)
  assert.match(out, /chars omitted/)
  assert.ok(out.startsWith('p'.repeat(10)))
})

test('代码块本身超预算时保留头尾，不静默丢弃', () => {
  const out = renderCandidateForJudge({ text: `\`\`\`js\n${code}\`\`\`` }, { budgetTokens: 500 })
  assert.ok(out.includes('export function f(){ return 42 }'))
  assert.match(out, /chars of code omitted/)
})

test('stripOrSummarizeCode 仍用于展示（保留原行为）', () => {
  // 注意：该函数只识别 ```lang file.ext 这种空格分隔的标注形式；
  // file="x" 引号形式本来就匹配不到（既有行为，本次未改）。
  const out = stripOrSummarizeCode(`\`\`\`js a.js\n${code}\`\`\``)
  assert.ok(out.includes('saved to disk'), '展示路径仍走摘要')
})

test('buildSynthesisPrompt 把代码交给裁判', () => {
  const cand = { label: 'magpie:hy3', text: `\`\`\`js file="a.js"\n${code}\`\`\``, files: [] }
  const prompt = buildSynthesisPrompt('评估实现', [cand])
  assert.ok(prompt.includes('export function f(){ return 42 }'))
  assert.ok(!prompt.includes('saved to disk'))
})

test('buildCuratorSynthesisPrompt 同样把代码交给裁判', () => {
  const cand = { label: 'magpie:hy3', text: `\`\`\`js file="a.js"\n${code}\`\`\``, files: [] }
  const prompt = buildCuratorSynthesisPrompt('评估实现', [cand])
  assert.ok(prompt.includes('export function f(){ return 42 }'))
})

test('buildPeerCritiquePrompt 的对手提案同样带代码', () => {
  const other = { label: 'peer', text: `\`\`\`js file="a.js"\n${code}\`\`\`` }
  const prompt = buildPeerCritiquePrompt('题目', '我的方案', [other])
  assert.ok(prompt.includes('export function f(){ return 42 }'))
})

test('judgeCandidateTokens 可覆盖默认预算', () => {
  const long = 'a'.repeat(40000)
  const tight = renderCandidateForJudge({ text: long }, { budgetTokens: 100 })
  const loose = renderCandidateForJudge({ text: long }, { budgetTokens: 20000 })
  assert.ok(tight.length < loose.length)
  assert.ok(loose.length <= long.length)
  assert.equal(JUDGE_CANDIDATE_TOKEN_BUDGET, 8000)
})
