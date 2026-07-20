# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.19...v1.1.0) (2026-07-20)

### Added
- **交互卡片消息完整落地：展示卡 + Agent 进度卡 + octo/v2 回调卡**（#156 / #159 / #165）：本版把 InteractiveCard（`payload.type=17`）从无到有做成一条完整能力线，让 bot 能发结构化卡片而不只是纯文本。
  - **展示卡（`octo/v1`，`octo_send_display_card` 工具）**：非交互的结构化输出——状态报告、键值摘要、三列 KPI/天气条、表格、可折叠详情、本地复制按钮、安全导航链接。工具自动做能力协商，服务端不支持的元素降级为纯文本，作者无需自己判断兼容性。
  - **Agent 进度卡**：长任务运行时以进度卡展示执行阶段与工具调用，随执行 edit 帧更新，让用户看得到"在干什么、跑到哪"，而非只有一个 typing 指示器。
  - **octo/v2 回调卡（`octo_send_card` 工具，#165）**：带 `Action.Submit` 按钮与 `text/number/date/time/toggle/choice` 输入的交互卡；按钮点击经服务端权威事件回流为**同一会话内新的、可信的 agent 轮次**。含 `/v1/bot/events` 短轮询（磁盘游标、进程重启后续跑，游标先落盘后 ack，崩溃至多重放不丢）、卡片 action 派发与 in-place 状态帧（处理中 / 完成 / 失败,含输入冻结与幂等 claim/complete/release）。
  - **能力协商与服务端权威（D12）**：卡片元素/输入/actions 由 `GET /v1/bot/card/profile` 的 manifest 决定，`card_version` 精确匹配 `1.5`，`limits.*` 服务端权威并递归生效，ColumnSet/Table 等按需渲染，不支持则降级。
- **账号级卡片开关（`cardProgress` / `cardDisplay` / `cardInteraction`，#159 / #165）**：进度卡、展示卡、交互卡可按 bot 独立关闭（顶层默认 + `accounts.<id>` 覆盖，与 `requireMention` 同款分层）。三态语义——只有显式 `false` 强制关，`true` / 省略都跟随服务端能力；只作收窄、不能强开，`card_version` 等 fail-closed 底线保留。开关同时作用于工具发现与执行两道关。

### Fixed
- **纯图片回合被误判为"未投递"**（#152）：agent 一个回合只发图片、不发文字时，OpenClaw core 认不出这是成功投递，把整回合判成 `non_deliverable_terminal_turn`。根因是出向 `extractToolSend` 返回的是 `target` 而非 core 识别的 canonical `to` 字段、结果里也没上浮媒体 URL，导致 core 的两个投递证据信号都拿不到。
  - 修复：`extractToolSend` 返回 `{ to }`、发送结果顶层补 `mediaUrls`，让 core 的 `isMessagingToolSendAction` / `collectMessagingMediaUrlsFromToolResult` 正确认账。同时修掉 dispatch reject 兜底分支无条件清空 deliverBuffer 的问题——加 `!replySucceeded` 守卫，有缓冲的 block 文本时优先投递而非发矛盾的错误兜底，不再吞掉有效回复。
- **历史注入不尊重会话重置（/new），穿透污染新会话**（#155）：用户 `/new` 重置会话后，注入的群历史仍会带入重置点之前的内容，污染新会话上下文。修复后历史注入以会话重置点为界，不再穿透。
- **卡片链路安全加固**：交互卡的信任边界与脱敏做了系统性收敛——卡片文本 / data / facts 中的内嵌 URL 统一降级为 `scheme://<registrable-domain>`（扩到任意 scheme，堵非 http 凭据 URI 泄露）、工具名 label 与工具错误文本同样脱敏 + 截断、首帧 4xx fail-closed、提交表单值当作数据而非控制文本并按原卡输入 id 校验，消除进度卡与错误路径的泄露 sink。
- **session 初始化 CAS 瞬时竞态导致的 inbound 失败**：对 core 的 session-init 冲突做重试，吸收该瞬时竞态。

### Changed
- **依赖 floor 提升到 openclaw >= 2026.6.9**：新增功能依赖 `getSessionEntry` 等 export，相应抬高 peer-dep 下限。

### Internal
- 抽出共享的卡片能力推导（`deriveCardCaps`），进度卡与展示卡复用同一能力判断，避免两处漂移。

## [1.0.19](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.18...v1.0.19) (2026-06-29)

### Added
- **`/fork`：从当前对话拉出带父上下文的子区**（#131）：群里发 `/fork` 可基于当前会话创建一个 Octo 子区（community topic），并把父对话的相关上下文 seed 进新子线程，让分支讨论延续上文而不污染主线。涵盖历史过滤、父 MD 继承、子线程 seed 派发等完整链路；`commands.fork.scope` 提供触发范围配置（v1 hook 实际只认默认的 owner-mentioned，其余值给启动告警）。
- **受限 tools.profile 下 `octo_management` 不可用时，bot 正确归因而非瞎建议**（#137, PR #142）：OpenClaw 的受限工具档（`minimal` / `coding` / `messaging`，且**新装默认就是 `coding`**）会在模型看到工具前过滤掉插件工具，导致 `octo_management`——它承载**全部** Octo 管理能力（建群、子区、GROUP.md/THREAD.md、成员管理、voice context、write-secret）——在 agent 工具列表里整个消失。此前 bot 会把「工具不见了」错误归因为「Octo 不支持这些功能」，转而建议改用企业微信 / 飞书，或对 write-secret 建议用户直接粘贴明文密钥，与该功能的安全初衷相悖。
  - 修复：通过 `before_prompt_build` 注入一段诊断 system 提示，让 bot 明白这是**工具档限制**而非功能缺失，并引导用户用 `tools.alsoAllow: ["octo_management"]`（全局或 per-agent）放行、或切到 `full` 档，明确**不要**建议替代平台或粘贴明文。改不改配置由用户决定。
  - 落点选择：用 `before_prompt_build` / `prependSystemContext` 而非 channel `messageToolHints`——后者被 system-prompt builder 的「message 工具是否可用」门槛包着，而受限工具档恰好也会移除 message 工具，导致挂在 messageToolHints 上的提示在我们要覆盖的场景里永不出现。
  - 仅在 octo 会话注入（gate 在 `messageProvider`，因为该 hook 是全局的）；文案条件式，`full` 档工具可用时无副作用。`octo_management` 仍保持为插件工具——这正是 write-secret 明文不进模型上下文的保证，与本次诊断提示正交。

### Fixed
- **thread 群的成员缓存永不回收、内存泄漏**（#128, PR #135）：`cleanupStaleCaches` 用 raw `channel_id`（线程频道为 `parent____short`）去删按 parent groupNo 存储的两类缓存（`_groupCacheTimestamps` / `_currentGroupMembersMaps`），key 维度不匹配，thread 群的这两类缓存永远删不掉，随时间累积泄漏。
  - 修复：改为两遍扫描——第一遍清理 raw-key 缓存及其活跃记录，第二遍遍历 parent-keyed 缓存自身，仅当该 parent 下**没有活跃的兄弟线程**时才删除。能回收旧逻辑已积压的「孤儿」parent 条目（raw 活跃记录已被清、但 parent 缓存残留的情况）。
- **主动发送不带目标时服务端返回不透明 500**（#138, PR #141）：agent 主动（非回复）发送但**未指定目标 channel** 时，`parseTarget` 解析出空 channelId 并被透传给服务端，`POST /v1/bot/sendMessage` 报 500。除空串外，`group:` / `user:` 等仅前缀、`group:@uid` 仅含 mention 等「解析后实体为空」的目标同样会触发。回复路径自带会话上下文，不受影响。
  - 修复：客户端 fail-fast，四道防线——出向解析主防线（`parseTarget` 之后、threadId 合并之前判空，避免 `group:` 拼上 threadId 合成出非空的伪线程 channel 而绕过）、message 工具 `handleSend` 入口返回结构化错误、三个 HTTP 发送函数入口兜底、`sendMedia` 在任何下载/上传之前提前校验（避免无效目标白白上传）。空请求不再发出，从根上消除该 500。服务端对任意客户端缺 target 返回干净 400 属 octo-server 范畴，本次修复后本插件请求已不会走到那条路径。


## [1.0.18](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.17...v1.0.18) (2026-06-27)

### Fixed
- **群成员上下文混入外群成员、人数虚高**（#125, PR #126）：群里 @bot 问「群里几个人」时，bot 答出的人数远多于实际，还会把**不在本群**的成员说成本群成员（真机 3 人群答「4 人，含 costest」，而 costest 属于该 bot 的另一个群；线上 7 人群答 87 人、不到 20 人群答 500 多人）。
  - 根因：`buildMemberListPrefix` 把 **per-account 累积**的 `uidToNameMap` 当成「本群名单」喂给 `[Group Members]` / 成员数 prompt。该 map 按 accountId 共享，被启动 prefetch + 每条 inbound 刷新地**只 set、从不按群清理**，因此它实际是 bot 待过的**所有群成员的并集**——人数虚高 + 跨群成员泄漏。
  - 修复：`refreshGroupMemberCache` 把本次拉到的**当前群名单**（按 parent groupNo 取，thread channelId 安全）写进新的 per-account `currentGroupMembersMap`，空返回 / fetch 失败时 `delete` 该条目（负缓存），避免再注入过期或外群名单；`buildMemberListPrefix` 改为接收当前群 `GroupMember[]` 而非累积 map；`cleanupStaleCaches` 同步清理新缓存，与 `groupCacheTimestamps` 共用 raw channel_id key、同生命周期。
  - 兼容性：**不动** `uidToNameMap` 的累积语义——sender-name 解析、@mention 解析仍依赖它跨群累积，本次只把「成员名单」这一路独立出来。
- **App Bot（`app_`）token 连绑都绑不上**（PR #130, refs octo-adapters#129）：setup / bind 的 token 校验此前**只接受 `bf_`** User Bot token，对 Admin 后台「应用 Bot」生成的 `app_` token 一律拒绝（`Bot token must start with 'bf_'`）。用户照着 Admin 连接指南拿 App Bot token 绑定时直接被挡，即便他只需要一个私聊场景的 Agent（App Bot 的私聊能力对此足够）。
  - 修复：token 前缀白名单从 `{bf_}` 放宽到 `{bf_, app_}`，抽到共享 helper `isValidBotToken`，交互式 wizard 与非交互式 setup adapter 共用，避免两处判断漂移；同步更新 prompt / status / 报错文案说明两种合法前缀。仍挡掉空串、非字符串、长度不足、未知前缀（如误粘的 `uk_` API key）。
  - 设计取舍：token 的能力边界由 **server 强制**（octo-server `bot_api` 按前缀分流鉴权，对 App Bot 的群 / thread / OBO 调用显式拒绝），因此客户端校验**不应**替 server 预先拒绝 `app_`——绑上后能做什么由 server 说了算，插件不复制 server 的权限逻辑。

## [1.0.17](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.16...v1.0.17) (2026-06-17)

### Fixed
- **把 dispatch 超时配成极大值，反而导致每条消息秒回「处理超时」**（#121, PR #122）：1.0.16（#114）把派发看门狗超时改成从 `agents.defaults.timeoutSeconds` / `channels.octo.dispatchTimeoutMs` 动态派生，但只校验了「有限且为正」，没设上限。当用户把超时配成极大值（如 `Number.MAX_SAFE_INTEGER`，本意是「别给我超时」）时，派生出的毫秒数（`× 1000 + 60s ≈ 9 × 10¹⁸ ms`）远超 Node `setTimeout` 的 32 位上限，被运行时悄悄重置成 1ms 并抛 `TimeoutOverflowWarning` —— 结果每条入站消息都瞬间触发看门狗、秒回「⚠️ 处理超时，请稍后重试。」，真正的答案反而迟到补上。
  - 修复：新增上限常量 `DISPATCH_TIMEOUT_MAX_MS = 2³¹ − 1`（≈ 24.8 天，正是 `setTimeout` 的硬上限），对「显式配置」和「从 `timeoutSeconds` 派生」两条返回路径都用 `Math.min` 夹顶。
  - 兼容性：上限远超任何现实的 agent 运行时长，clamp 只在「超时配到 ~24.85 天以上」这种荒谬值时才生效；一切现实配置的行为保持不变，仍维持 #114「派发看门狗严格晚于 agent-run 超时触发」的不变量，不会重蹈 #113 提前误杀健康长任务的覆辙。原有 NaN / 0 / 负数 / Infinity 的回退逻辑不动。

## [1.0.16](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.0.15...v1.0.16) (2026-06-13)

### Fixed
- **长任务（>5min）必被 dispatch 超时强制中断**（#113, PR #114）：dispatch 超时硬编码 300s 且无配置入口，即便 OpenClaw 侧把 `agents.defaults.timeoutSeconds` 调到 1000s，octo 仍在 5 分钟砍掉派发，用户收到「处理超时」而 agent 其实还在正常跑。
  - 修复：超时改为每条入站动态解析 `resolveDispatchTimeoutMs` —— 显式 `dispatchTimeoutMs`（channel / account 级，account 覆盖 channel）优先，否则派生为 `(agents.defaults.timeoutSeconds ?? 600) × 1000 + 60s`
  - 60s buffer 保证看门狗**永远晚于** agent-run 超时触发：core 先优雅终止 run，这个守卫只兜真正卡死的基础设施，不再误杀健康长任务
  - 单一事实来源：调 `timeoutSeconds` 一个旋钮，看门狗自动跟随；默认从 300s 提到 660s
- **dispatch 静默卡死永久堵塞 per-group 队列**（Refs #75, PR #83）：上游 `dispatchReplyWithBufferedBlockDispatcher` 偶发挂起（不 resolve / 不 reject / 不 onError），叠加 per-group 串行队列，导致该群后续消息全部静默丢弃，需重启 gateway 恢复。
  - 修复：给派发加超时看门狗，把「静默永久卡死」转成「单条消息超时 + warn 日志 + 道歉 + 队列推进」；道歉与 final-flush 发送各自 `AbortSignal.timeout` 兜底，避免 Octo API 同时生病时二次卡死
- **工具警告覆盖真回复、真答案丢失**（#117, PR #115）：同一回合 core 同时产出正经 final 回复和工具报错警告（都 `kind=final`）时，单槽 deliver buffer 被较短的警告覆盖，用户只看到「⚠️ … failed」，多段真答案丢失。
  - 修复：照搬 Discord 的「警告延迟」模式 —— 工具警告 final 先压在 `pendingToolWarningFinal`，正经回复立即发；仅在「确实没发过正经回复」时才补发警告；`onError` 后不补发。跨 SDK 特性探测，老 SDK 退化为立即发、绝不丢真答案
- **自建 MinIO / S3 部署下 bot 文件上传 100% 失败**（#65, PR #66）：上传写死了腾讯 COS 专用的 `GET /v1/bot/upload/credentials`（`cos-nodejs-sdk-v5` 无 endpoint 选项、默认指向 `*.myqcloud.com`），无 COS 配置的自建 Docker + MinIO 部署该接口 500，图片 / 文件 / 视频上传全挂。
  - 修复：改走服务端早已提供、后端无关的 `GET /v1/bot/upload/presigned`（签名 PUT，MinIO / COS / S3 / OSS 通吃，与 web / iOS / Android 同路径）。**仅改 adapter，服务端不变**
- **write-secret 安全收口**（consolidates #92/#95/#96, PR #97）：fail-closed jail（无 `process.cwd()` 回退，未配 root 直接拒写，根除 `root="/"` 自锁与 fail-open）；默认 jail = agent workspace（带 realpath 退化根防护 + agent-id 命名空间匹配，常见场景零配置）；resolve 契约对齐 octo-server #301。
- **主动发送时 outbound @mention 失败**（#85, PR #86）：cron / 新建 thread / agent 主动发起的消息，@mention 渲染成裸 `@<uid>:<name>` 或永不匹配的 `@<bot_username>`；同样内容走 inbound 回复却正常。
  - 根因：成员 Map 只在 inbound 路径填充，outbound 跑在空 / 过期 Map 上；且成员列表与 mention 格式提示也只在 inbound 注入，主动回合拿不到
  - 修复：主动 outbound 路径补齐成员预取 + mention 格式引导
- **thread 内发送泄漏到父群**（#98, PR #100）：bot 在子 thread session 里，LLM 传 `group:<gid>` 目标（多数是「发到群里」在 thread 语境下的理解）时，被路由到**父群**，泄露给全体父群成员、thread 参与者却看不到。
  - 修复：加确定性运行时护栏，thread session 内把裸 parent-group 目标自动重路由回当前 thread（呼应 #86 的 prompt + 兜底双保险模式，不再只靠概率性的 prompt 引导）
- CI：check-sprint 触发类型补 `ready_for_review`（#49）

### Added
- **write-secret agent action**（PR #71）：`octo_management` 工具新增 `write-secret`，让 assistant 通过**别名**（显示名 / secret id）把用户外部托管的密钥（如 OpenAI key）写入本地文件，原始明文全程不经过模型与聊天记录。use-time 解析（每次调用现取），返回 `resolved` / `not_found` / `ambiguous`
- **`scope:"parent"` 逃生口 + 发送回执字段**（#98, PR #110）：在 #100 自动重路由基础上，允许 agent 显式指定发到父群、主动 opt-out 重路由（仅认字面量 `"parent"`）；并补充目标回执 / 可观测字段
- **按名字解析目标**（#105, PR #109）：`octo_management` 新增 `resolve` action，把「转发给『XXX』」这种命名目标解析成具体 group / thread 候选，不再让 agent 手搓 `group:` 地址靠猜。依赖 octo-server #337（`GET /v1/bot/resolve/targets`），未部署时返回干净的「resolve unavailable」

### Internal
- **统一 channel-prefix 归一化**（#102, PR #103）：`src/actions.ts` 此前对「剥 channel 命名空间前缀」有三套不同实现，`handleRead` 只剥 `octo:`，导致带 `group:` / `channel:` 前缀的 `currentChannelId` 与 `parseTarget` 剥净后的 channelId 比较时 `isSameChannel` 误判为跨 channel。收敛为单一 helper，统一剥同一组前缀。
- **文档：incoming webhook bot 端点**（PR #112）：在 `octo-bot-api` skill 文档化 octo-server #340 的 7 个 webhook 管理端点 + 免登录推送 URL，让 agent 可自助为群配置 CI / 监控 / GitHub / 企业微信的免登录推送通道并管理其生命周期（docs-only，无插件代码改动）
- force patch release for v1.0.16（#107）

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
