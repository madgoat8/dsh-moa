import z from '@deepseek-ai/schemastery'

// Ensure .volatile() helper exists on Schemastery schema prototype
try {
  const schemaProto = Object.getPrototypeOf(z.boolean())
  if (schemaProto && typeof schemaProto.volatile !== 'function') {
    schemaProto.volatile = function () {
      return typeof this.extra === 'function' ? this.extra('volatile', true) : this
    }
  }
} catch {
  // safe fallback
}

export const PriceRow = z.object({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheHit: z.number().default(0),
})

export const ModelSlotSchema = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
  role_persona: z.string().default(''),
  temperature: z.number().default(-1),
  // advisor/裁判的上下文窗口（token）。0 = 自动（查 OpenRouter 目录的 context_length）。
  // 用途：按槽位裁剪历史，避免小窗口 advisor 超窗吃 400 后被静默降级成"少一路"。
  context_window: z.number().default(0),
})

export const PresetSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  ask_clarifying_questions: z.boolean().default(true),
  curator_synthesis: z.boolean().default(false),
  stream_aggregator: z.boolean().default(true),
  quorum_enabled: z.boolean().default(false),
  grace_period_sec: z.number().default(10),
  reference_models: z.array(ModelSlotSchema).default([]),
  aggregator: ModelSlotSchema.default({ provider: '', model: '' }),
  aggregator_fallbacks: z.array(ModelSlotSchema).default([]),
  reference_temperature: z.number().default(0.6),
  aggregator_temperature: z.number().default(0.4),
  reference_timeout_sec: z.number().default(60),
  aggregator_timeout_sec: z.number().default(180),
  blind_evaluation: z.boolean().default(false),
  peer_critique_enabled: z.boolean().default(false),
  allow_candidate_override: z.boolean().default(false),
  max_tokens: z.number().default(4096),
  judge_criteria: z.string().default(''),
  test_gate_enabled: z.boolean().default(false),
  test_command: z.string().default(''),
  test_gate_timeout_sec: z.number().default(15),
  multi_judge_enabled: z.boolean().default(false),
  judge_models: z.array(ModelSlotSchema).default([]),
  judge_voting_strategy: z.string().default('majority'),
  composite_merge_enabled: z.boolean().default(false),
  smart_routing_enabled: z.boolean().default(false),
  smart_routing_model: ModelSlotSchema.default({ provider: '', model: '' }),
  budget_guard_enabled: z.boolean().default(false),
  max_budget_usd: z.number().default(0),
  budget_action: z.string().default('trim'),
  temperature_gradient_enabled: z.boolean().default(false),
  multi_turn_enabled: z.boolean().default(true),
  report_generation_enabled: z.boolean().default(false),
  local_fallback_enabled: z.boolean().default(false),
  local_fallback_models: z.array(ModelSlotSchema).default([]),
  interactive_workbench_enabled: z.boolean().default(false),
  // 本地分支：候选/裁判模型可用的工具。
  //   false            只给静态上下文（上游原行为）
  //   true             只读文件工具 + 联网搜索/抓取
  //   ["read_file",...] 精确指定
  //   { file:true, bash:false, web:true } 按类别开关（bash 为只读白名单）
  tools: z
    .union([
      z.boolean(),
      z.array(z.string()),
      z.object({
        file: z.boolean().default(true),
        bash: z.boolean().default(false),
        web: z.boolean().default(true),
      }),
    ])
    .default(true),
  tools_max_rounds: z.number().default(5),
  // 裁判模型是否也能用只读工具核对事实（默认开）
  judge_tools: z.boolean().default(true),
  // 某候选 429/503 时是否自动用同批次其他槽位顶上（默认开）
  auto_fallback_siblings: z.boolean().default(true),
  // 是否按每个 advisor 自己的上下文窗口裁剪历史（默认开）。
  // 关掉 = 所有候选共用同一份 messages（0.2.57 上游行为，小窗口模型会超窗）。
  trim_context: z.boolean().default(true),
})

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  default_preset: z.string().default('default').volatile(),
  smart_routing_enabled: z.boolean().default(false).volatile(),
  smart_routing_model: ModelSlotSchema.default({ provider: '', model: '' }).volatile(),
  prices: z.dict(PriceRow).default({}).volatile(),
  presets: z.array(PresetSchema).default([
    {
      name: 'default',
      enabled: true,
      ask_clarifying_questions: true,
      reference_models: [
        { provider: '', model: '', role_persona: 'proposer' },
        { provider: '', model: '', role_persona: 'challenger' },
      ],
      aggregator: { provider: '', model: '' },
      reference_temperature: 0.6,
      aggregator_temperature: 0.4,
      max_tokens: 4096,
      judge_criteria: '',
    },
    {
      name: 'fast',
      enabled: true,
      ask_clarifying_questions: false,
      reference_models: [
        { provider: '', model: '', role_persona: 'fast' },
      ],
      aggregator: { provider: '', model: '' },
      reference_temperature: 0.6,
      aggregator_temperature: 0.2,
      max_tokens: 4096,
      judge_criteria: '',
    },
    {
      name: 'deep-reasoning',
      enabled: true,
      ask_clarifying_questions: true,
      reference_models: [
        { provider: '', model: '', role_persona: 'architect' },
        { provider: '', model: '', role_persona: 'critic' },
      ],
      aggregator: { provider: '', model: '' },
      reference_temperature: 0.6,
      aggregator_temperature: 0.2,
      max_tokens: 8192,
      judge_criteria: '',
    },
  ]).volatile(),
})

export function plainConfig(value) {
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    return plainConfig(value.get())
  }
  if (Array.isArray(value)) {
    return value.map(plainConfig)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, plainConfig(child)])
    )
  }
  return value
}
