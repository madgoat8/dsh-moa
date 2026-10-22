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
