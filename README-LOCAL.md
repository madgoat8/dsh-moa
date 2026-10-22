# @yongfan/dsh-moa — 本地修复分支

基于 `@goodandready/dsh-moa@0.2.57`（npm / GitHub main 最新版），修复其在 DSH 0.2.x
（pi-ai 适配器）上完全不可用的问题。

## 为什么要 fork

上游 0.2.57 在 DSH 0.2.x 上调用 `/moa` 必定失败，报：

```
All advisor models (N) failed: xxx: content.some is not a function
```

根因在 LLM 调用层，不在模型或网关：

| 层 | 问题 |
|---|---|
| `moa-prompts.js#cleanAdvisoryMessages` / `moa-context.js#pruneMultiTurnMessages` | 把历史消息规范成 `{ role, content: string }` |
| DSH `ctx.llm` → `pi-ai` 适配器 | 要求 `content` 是 `ContentBlock[]`，且 assistant 消息必须带 `source: { kind:'model', provider, model }` |
| 结果 | pi-ai 的 `transform-messages.js` / `hasToolHistory` 对字符串调用 `.flatMap` / `.some` → TypeError |

## 本分支的修复

1. **消息适配层**（`lib/moa-llm.js`）
   - `toHarnessMessages()`：把任意形态历史归一化成 DSH 原生块数组 + assistant.source
   - 剥掉 system / tool / toolResult；合并相邻同角色；保证末条为 user
   - 显式 `tools: []`，避免 pi-ai 回灌 harness 工具声明
2. **失败诊断**（`lib/moa-candidates.js` / `lib/moa-runner.js`）
   - 逐候选记录 `errorCode` 与 `stack`，并在 all-failed 时写日志
   - 空响应时区分「模型没说话」与「思考吃满 max_tokens」
3. **配置自检**（`lib/routes.js`）
   - `/dsh-moa/status` 返回每个 preset 的模型解析结果与 `warnings`
4. **禁用上游自动更新**（`lib/updater.js`）：避免一键更新把本地修复覆盖回上游

## 版本

`0.2.57-local.1`，包名 `@yongfan/dsh-moa`

## 构建与安装

```bash
cd /Volumes/P3Plus_1T/code/dsh-moa
npm pack --pack-destination dist
cd ~/.dsh/profiles/desktop
# package.json: dependencies 加 "@yongfan/dsh-moa": "file:.../dist/yongfan-dsh-moa-0.2.57-local.1.tgz"
#               dsh.profile.bundles 里把 @goodandready/dsh-moa 换成 @yongfan/dsh-moa
pnpm install --no-frozen-lockfile
```

`cordis.patch.yml` 里 `id: dsh-moa` 的 `name` 需同步改为 `@yongfan/dsh-moa`。

## 0.2.57-local.2 — 只读工具调用

原版 MoA 的候选/裁判模型**无法调用任何工具**（搜索、读文件、执行命令全都没有），
只能基于静态上下文作答。本版补齐：

### 新增能力

| 工具 | 说明 | 默认 |
|---|---|---|
| `read_file` | 读工作区文件（offset/limit 分行） | 开 |
| `list_dir` | 列目录 | 开 |
| `grep_files` | 正则内容搜索 | 开 |
| `find_files` | glob 文件名查找 | 开 |
| `web_search` | 联网搜索（走宿主 web 服务） | 开 |
| `web_fetch` | 抓网页正文 | 开 |
| `bash` | **只读** shell 命令（白名单） | **关** |

### 关键实现细节

1. **pi-ai 只认 `system 消息的 toolsAdded`**
   `openai-completions` 的 `buildParams()` 调 `resolveTranscriptTools(messages)`，
   该函数**只扫描 system 消息的 `toolsAdded` 字段**，`context.tools` 被完全忽略。
   所以 `attachToolsToSystem()` 把工具挂到首条 system 消息上。
   （这也是上游 MoA 传 `tools: []` 时"看起来传了但没生效"的原因）

2. **工具循环**：`runLlmWithTools()` 最多 `MAX_TOOL_ROUNDS`（默认 5）轮，
   模型返回 tool-call → 本地执行 → tool 结果 + user 摘要回灌 → 再调用。

3. **原生流事件**：pi-ai 发 `toolcall_end` / `done`，DSH 适配器发 `block-end`，
   两种都识别。

4. **安全边界**
   - 所有文件路径必须落在 `cwd` 内（`path.relative` 越界即拒绝）
   - `bash` 仅在显式开启时可用，且必须命中只读白名单（ls/cat/grep/find/git status…），
     含 `>`、`rm`、`|sh`、`sudo` 等一律拒绝
   - 工具执行失败回灌为文本，不中断流水线

### 配置

```yaml
presets:
  - name: default
    tools: true                      # 只读文件 + 联网搜索（默认）
    # tools: false                   # 关闭，回到上游纯文本行为
    # tools: ["read_file","grep_files"]
    # tools: { file: true, bash: false, web: true }
    tools_max_rounds: 5
```

## 0.2.57-local.3 — 工具链修复与能力增强

### 修复（来自实际运行日志）

日志证据：
```
🔧 Tool web_search("{"queries\":[\"deepseek harness...") -> 工具执行失败: queries 不能为空
🔧 Tool web_fetch("{"url\":\"https://github.com/deepseek-ai") -> 工具执行失败: 只支持 http(s) URL
🔧 Tool grep_files("{"pattern\":\"harness\"}") -> 工具执行失败: pattern 不能为空
```

**根因**：pi-ai 在某些路径下把 `tool-call.arguments` 给成**原始 JSON 字符串**（甚至流式半截串），
上游代码直接 `args.queries` 取字段必然是 `undefined`。

| 修复 | 说明 |
|---|---|
| `parseToolArguments()` | 对象/字符串/半截 JSON 三种形态统一解析，含引号括号自动补齐 |
| `normalizeArgs()` | 兼容 `{queries:[]}` / `{query:"x"}` / 纯字符串 / `__raw` 抢救 |
| 错误信息带原始入参 | 失败时回灌 `原始入参: ...`，模型可自行修正，而不是盲目重试 |

### 增强

| 能力 | 说明 |
|---|---|
| **重复调用去重** | 同一 `(工具+参数)` 只执行一次，复用时提示"已执行过"，实测把 4 次重复 web_search 收敛为 1 次 |
| **轮次预算** | 默认 5 轮，超限时**强制不带工具再要一次回答**，避免空转 |
| **失败引导** | 某轮有工具失败时，追加提示"请修正参数或换工具，不要重复相同调用" |
| **自动降级** | 候选 429/503 时自动用**同批次其他槽位**顶上（可用 `auto_fallback_siblings: false` 关闭） |
| **裁判接入工具** | judge 也能 `web_search`/`web_fetch`/`read_file` 核对事实（`judge_tools: false` 可关） |
| **web 契约适配** | DSH 的 `ctx.web.search` 是 `{ query, maxResults }`（单条），插件里翻译成多条并发合并 |
| **结果格式化** | provider 返回 `{sources:[{title,url,snippet}]}` 等结构统一转成模型可读文本 |

### 新增配置

```yaml
presets:
  - name: default
    tools: true
    tools_max_rounds: 5          # 候选模型工具轮次上限
    judge_tools: true            # 裁判是否也能用工具核对
    auto_fallback_siblings: true # 候选挂了自动换同批次其他模型
```
