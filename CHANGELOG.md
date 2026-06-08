# Changelog

All notable changes to this project will be documented in this file.

## [1.0.15](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.14...v1.0.15) (2026-06-08)

### Fixed
- **OctoPush / 老 Node 内嵌环境首条入站消息必崩 `Octo runtime not initialized`**（#77, PR #78）：受影响场景为 `OPENCLAW_NO_RESPAWN=1` + SIGUSR1 进程内重启（典型为 OctoPush 桌面客户端，Electron 内嵌的 Node 版本可能早于 22.12）。重启后 bot WebSocket 能连上，但首条入站消息处理时报错。
  - 根因：SDK `loadBundledEntryExportSync`（含 jiti fallback）加载 `src/runtime.js` 时，在 Node `require(esm)` 缓存未统一的版本上会产生一份与 ESM static `import` 独立的 module record；两份 record 各持一份 module-scope `let runtime`，setter 写 A、getter 读 B，永远拿到 `null`。`index.ts#registerFull` 里手动 `setOctoRuntime(api.runtime)` 的旧 workaround 在 SIGUSR1 路径上失效。同类机制 1.0.3 已踩过一次
  - 修复：`src/runtime.ts` 将状态从 module-scope 迁到 `globalThis[Symbol.for("openclaw.octo.runtime")]`。`Symbol.for` 跨 module 拷贝指向同一 symbol，globalThis 为进程级单例，任何 loader 拿到的实例都命中同一 slot，根治双实例 hazard
  - `index.ts#registerFull` 的手动 `setOctoRuntime(api.runtime)` 调用保留作为冗余防御；旧的长注释重写以反映新机制
  - 影响面：普通 openclaw 用户（Node 22.12+，`require(esm)` 缓存已统一）零感知；专修 OctoPush 等老 Node 内嵌环境

- **BotFather mixed-case bot ID 在 plugin 各处静默 misroute**（#33, PR #72）：BotFather 历史上生成大小写混合的 bot ID（如 `27pBwzf2F6bfa5cd142_bot`），但 OpenClaw 路由层用 `normalizeOptionalLowercaseString` 转小写后查找，plugin 内部却按原始大小写做 Map/Set key 与磁盘路径，结果在 owner 检查、persona 缓存、群/thread MD、mention 偏好、群→账号映射等多处静默走错。同类 bug 已在 #32 / #55 各修过一次，本 PR 一次性铺平
  - 单一入口：新增 `src/account-id.ts#normalizeAccountId()`
  - 契约：所有 exported 函数（含 test-only `_xxx` helper）接收 `accountId` 参数或含 `accountId` 字段对象时，函数体第一行 normalize；不依赖 caller
  - 覆盖面：owner-registry / channel（8 个 per-account Map + group→account Set，写入与读取两侧）/ inbound（composite session key）/ group-md（GROUP + THREAD 链：路径、读写删 ensure、meta 持久化 normalized）/ mention-prefs / persona-prompt（5 个 exported API + 内部生成路径 defense-in-depth）/ thread-binding-adapter
  - 启动时 audit：log 检测到的 mixed-case 账号数量，便于运营追踪遗留 bot
  - 兼容性：bot token / `openclaw.json` 配置 / WuKongIM channel 不变；macOS APFS 零变化；Linux 首次升级每群/thread 单次 cache miss（路径从 `<BotA>/` 移到 `<bota>/`），随后稳定，旧目录变成无害孤儿；之前 mixed-case bot 的 owner 权限本就静默坏，现在修好（是改善不是回归）
  - 配套：octo-server #302 让新 bot 一律小写。本 plugin PR 兼容存量 mixed-case bot 与新 lowercase bot 两种群体，**无服务端硬依赖**

### Internal
- 引入 release-please 做 PR-driven 自动发版（#42, PR #70）：基于 conventional commits 自动维护 release PR，合并后自动打 tag 触发 ClawHub 发布。版本号 / CHANGELOG / tag 不再需要手工同步

## [1.0.14] - 2026-06-06

### Fixed
- **图文混排 (RichText=14) / 图片消息 bot 端无法识别图片**（#58, PR #59）：图片实际下载成功，但 media-understanding 仍全量 `MediaFetchError`（0 成功）。根因两层：
  - 下载目录 `/tmp/octo-media` **不在 Core 允许的 media root** 下，Core 拒读本地文件
  - `MediaUrls` 直接塞本地路径，且没有远程 http(s) URL 兜底；RichText body 只有 `[图片]` 占位、不带链接，下载失败时图片 URL 彻底丢失
  - 修复：下载目录改到 `/tmp/openclaw/octo-media`（Core 白名单根）；新增 `MediaPaths`（all-or-nothing，全部本地成功才发，避免稀疏数组崩 sandbox staging）；每张图保留原始远程 URL，任一下载失败则整条消息回退到远程 URL 分支由 Core 重取

### Added
- **RichText=14 图文混排** bot adapter 支持（#55）：enum + inbound 展开成单条语义 `{ text, mediaUrls[] }` + outbound + 幂等
- **群级免@偏好 gate + pull-TTL 缓存**（#57）：mention.ais gate + 缓存 TTL
- mention-pref 缓存在 `mention_pref_updated` 事件时失效，正向 TTL 降到 30s（#61）

### Internal
- outbound：把 Octo message_id 透传到 `OutboundDeliveryResult` 和 toolResult（#53）
- mention：移除 mentionAll 触发，仅 gate on mention.ais（#50）

## [1.0.13] - 2026-05-27

### Fixed
- **多账号配置下 `octo_management` agent tool 永远报 `Multiple Octo accounts configured; please specify accountId`**（#37）：哪怕 LLM 显式传 `accountId: "default"` 也无效。根因两层：
  - Layer 1：旧代码无条件把 `"default"` 当作 `DEFAULT_ACCOUNT_ID` 占位符剥掉，但 `"default"` 也可以是用户实际的账号 key，此时被错误丢弃。改成只有当 `"default"` 不在 `listOctoAccountIds(cfg)` 中时才视为占位符
  - Layer 2：channel `agentTools` 工厂只接收 `{ cfg }`，没有 session 上下文，无法知道当前 session 绑哪个账号。把 `octo_management` 从 channel `agentTools` 迁移到 `api.registerTool()`，后者注入完整 `OpenClawPluginToolContext`，含 framework 自动解析的 `agentAccountId`
  - accountId 解析优先级：`args.accountId`（LLM 显式）→ `ctx.agentAccountId`（framework 注入）→ `resolveDefaultOctoAccountId(cfg)` → 错误
- `index.ts`：`api.registerTool(...)` 注册放在 `registrationMode !== 'full'` 守卫**之前**，让 tool-discovery 模式也能看到 tool 注册
- `openclaw.plugin.json`：声明 `contracts.tools: ["octo_management"]`，对齐 loader 校验

### Internal
- `src/agent-tools.test.ts` +3 case 覆盖 `agentAccountId` 优先级链
- `src/channel.ts` / `src/multi-bot-isolation.test.ts`：移除已无意义的 `agentTools` 字段及对应 mock

## [1.0.12] - 2026-05-26

### Fixed
- **ACP session 模式在 Octo 群 / 私聊里无法启动**（#23）：`sessions_spawn({runtime: "acp", ...})` 之前一律 abort `errorCode: "thread_binding_invalid"`，导致所有 ACP harness（Claude Code / Codex / Cursor / Gemini）只能跑 `mode: "run"` 一次性，丢失会话上下文
  - 根因：OpenClaw runtime 检查 `plugin.conversationBindings.supportsCurrentConversationBinding` 决定 channel 是否支持 thread binding；octo plugin 之前完全没声明 `conversationBindings`，runtime 拿到 `adapterAvailable: false` 直接抛错
  - `src/channel.ts`：给 `octoPlugin` 加 `conversationBindings` 块，含 `supportsCurrentConversationBinding: true` + `defaultTopLevelPlacement: "current"` + `resolveConversationRef`（处理 `groupNo____shortId` thread 格式）+ `createManager`（runtime on-demand 注册 SessionBindingAdapter）
  - `src/thread-binding-adapter.ts`（新增）：实现 SessionBindingAdapter 契约，支持 `current`（绑当前对话）和 `child`（自动 `POST /v1/bot/groups/{groupNo}/threads` 创建子 thread）两种 placement；accountId 在注册时 lowercase 一次，对齐 OpenClaw 内部 `normalizeOptionalLowercaseString` 规范，避免 BotFather mixed-case bot ID 触发 `resolveByConversation` 失败（#33 跟踪 octo-server 侧根治）
- 端到端验证：DM + 群两个场景均成功 spawn Claude ACP session 并回流消息

### Internal
- `src/constants.ts`：导出 `THREAD_ID_SEPARATOR = "____"` 常量，统一 Octo CommunityTopic 格式分隔符的来源

## [1.0.11] - 2026-05-25

### Fixed
- **persona-clone 群路径下 `persona_prompt` 被忽略**（#29）：当 grantor 和 persona-clone bot **都在同一群**（scenario 3）时，inbound 走 group-path 直接到达，绕过 OBO v2 fan-out。之前只在 `triggeredByMentionHumans` 路径下注入通用 "you are X's clone" hint，自定义 `persona_prompt`（如 "always reply in English"）只通过 `before_prompt_build` hook 的 `prependSystemContext` 注入，**优先级低于 `GroupSystemPrompt`**，导致被 LLM 忽略
  - `src/inbound.ts`：group-path 下通过 `getPersonaPromptForSession()` 拿缓存的 `persona_prompt` 追加到 `GroupSystemPrompt`，对齐 OBO v2 路径下 `obo_system_hint` 的行为
  - `src/api-fetch.ts`：放宽 OBO grant 解析，server 的 `GET /v1/bot/obo-grant` 返回包含 `grantor_uid` / `persona_prompt` / `active` 但缺 `has_grant` 字段时也接受（之前严格要求 `has_grant === true` 导致所有 grant 被静默丢弃）

## [1.0.10] - 2026-05-25

### Fixed
- **多附件消息丢失**（#26）：`handleSend()` 之前只发第一个附件，现在 `resolveActionMediaUrls()` 统一从 `attachments[]` / `mediaUrls[]` / 顶层标量（`mediaUrl` / `filePath` / `fileUrl` / `url`）收集去重，循环 `uploadAndSendMedia` 每个独立 try/catch；partial failure 不阻塞其余，返回值新增 `mediaCount` 与可选 `failedMedia`

### Internal
- CI：支持 UI 驱动发版（Releases UI Publish → 自动到 ClawHub）+ auto-bump package.json + 三态 release 处理（none / draft / published）+ 强制前向版本（拒绝降级）+ 严格 stable SemVer（拒绝 prerelease）（#27）

## [1.0.9] - 2026-05-23

### Fixed
- **群聊双 bot 并发 @mention 时回复静默丢失**（octo-adapters#56）：引入 `enqueueInbound` 按 `accountId:group:channel_id` 串行化 inbound message，避免 OpenClaw runtime mid-run injection 导致 deliver callback 接不上
- **accountId 大小写不匹配导致 outbound 丢失**（octo-adapters#55）：`resolveOctoAccount` 新增 case-insensitive fallback，兼容 BotFather mixed-case ID 与 OpenClaw lowercase 标准化的差异
- **persona-clone 群路径 GroupSystemPrompt 未注入**（octo-adapters#65）：在 `triggeredByMentionHumans` 路径下合成 persona hint

### Added
- **mention 三态透传**（octo-adapters#45）：适配 octo-server mention `humans`/`ais` 三态字段，bot 仅响应 `ais=1` 或显式 @，`humans=1`（@所有人）仅触发 persona-clone bot
- **persona-clone @所有人 响应**（octo-adapters#61）：配置 `onBehalfOf` 的 bot 作为授权人代理，响应 @所有人 / @grantor，outbound 携带 `on_behalf_of` 字段
- **persona_prompt 注入 LLM system prompt**（octo-adapters#69）：`before_prompt_build` hook 通过 `sessionAccountMap` composite key 解析 persona 身份，注入 `prependSystemContext`；含 `initPersonaPromptCache` 60s 轮询 + generation guard 防过期

### Changed
- `release-drafter.yml` name-template 加 `v` 前缀，与 tag-template 一致

## [1.0.8] - 2026-05-20

### Changed
- 启用 GitHub Actions 自动发版流程（PR #9 / #10）：推 `v*.*.*` tag 到 `main` 后自动跑 `verify → npm pack → clawhub package publish + GitHub Release`，不再依赖本地 `clawhub` CLI 手工 publish。

### Internal
- 相对 1.0.7 没有运行时 / plugin 代码改动；本版本主要用于验证自动发版链路。

## [1.0.7] - 2026-05-18

### Fixed
- README + `skills/octo-bot-api/SKILL.md`：交互式入口改为裸命令（`openclaw channels add` 不带 `--channel octo`）。之前 `openclaw channels add --channel octo` 会进入非交互模式期待所有 flag，无法 prompt 用户输入 token/url

## [1.0.6] - 2026-05-17

### Fixed
- `registerFull` 内的手动注册路径（`setOctoRuntime` / `api.registerChannel` / `api.on('before_prompt_build')`）增加 `registrationMode` 守卫，仅在 `full` 模式下执行，避免 tool-discovery 路径产生副作用（codex review round 3 MAJOR 2）
- 修正过时注释，准确描述 contract `runtime: {}` / `plugin: {}` 字段的用途（codex review MINOR 1）

## [1.0.5] - 2026-05-17

### Fixed
- 恢复 `setOctoRuntime` + `api.registerChannel` 的手动注册（之前 1.0.4 误删导致 regression），完整解决 SDK loader 与 manual setup 双重写入冲突

## [1.0.4] - 2026-05-16

### Removed
- 移除孤立的 `cli/` 目录与未使用的 `commander` 依赖，缩减 dist 体积

### Changed
- 简化 `registerFull` 注册流程，去除重复的 `registerChannel` / `setRuntime` 调用

## [1.0.3] - 2026-05-16

### Fixed
- 修复 ESM 双实例 runtime init regression：将 `setOctoRuntime` 同时注入 `dist/index.js` 与 `dist/setup-entry.js` 两个 bundled entry，解决首条 inbound 消息触发 `Octo runtime not initialized` 报错

## [1.0.2] - 2026-05-16

### Removed
- runtime 模块移除 `child_process` 依赖，通过 OpenClaw ClawScan install gate
- 删除残留的 plugin self-management slash commands（`/octo_info`, `/octo_add_account`, `/octo_remove_account`）—— OpenClaw 已有 `channels add` / `plugins install` 等标准命令覆盖

## [1.0.1] - 2026-05-16

### Removed
- 删除 npm CLI entry 与 4 条 plugin self-management slash commands（`/octo_install`, `/octo_update`, `/octo_uninstall`, `/octo_doctor`）—— OpenClaw 已有 `plugins install` / `channels add` 等标准命令覆盖

### Changed
- 修正 npm artifact 与 ClawHub 元数据一致性问题；移除过期的 npm-only update check；清理 stale skill 文档（codex review round 2 反馈）
- 重新 publish 到 ClawHub

## [1.0.0] - 2026-05-15

Initial release of the OpenClaw channel plugin for Octo.

### Features

- Full WebSocket-based real-time messaging with Octo
- Multi-account support: run multiple bot accounts per OpenClaw instance
- Group, DM, and Thread (sub-topic) message routing
- GROUP.md and THREAD.md per-channel context injection
- Typing indicator, heartbeat, and read receipt support
- File upload via multipart and STS direct-to-COS
- Mention gating (`requireMention`) and @all ignore (`ignoreMentionAll`)
- Agent tool: `octo_management` for group and thread management
- ClawHub-compliant plugin metadata and setup entry
- CI: type-check + test on Node 22
