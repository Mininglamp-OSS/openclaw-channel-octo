# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.3.0...v1.4.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* **doc-task:** 未写 docTasks 的账号在下次重启后开始接受文档评论 @Bot 任务, 并常驻 /v1/bot/events 轮询。升级前请确认信任边界(能评论文档的人即可驱使 Bot)、 轮询开销(建议配 eventWaitSeconds)、以及分体部署下的 docsApiUrl。README 新增 「Upgrading to the release that makes docTasks default on」一节。

### Added

* **doc-task:** dispatch document comment @Bot mentions to isolated sessions ([#217](https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues/217)) ([abda2b7](https://github.com/Mininglamp-OSS/openclaw-channel-octo/commit/abda2b7658bd91a146a4c45d9ca46cdb9824520e))
* **doc-task:** 文档评论 @Bot 任务改为默认开启 ([#222](https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues/222)) ([baf6dbf](https://github.com/Mininglamp-OSS/openclaw-channel-octo/commit/baf6dbfdaa08da5a6d4244bc2d12514fac28922b))


### Internal

* **release:** set v1.4.0 release ([#224](https://github.com/Mininglamp-OSS/openclaw-channel-octo/issues/224)) ([0c0d02d](https://github.com/Mininglamp-OSS/openclaw-channel-octo/commit/0c0d02d087924478d565dfd2b17c0a53d132ed4c))

## [1.3.0](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.2.0...v1.3.0) (2026-08-11)

### Added
- **卡片能力改为由服务端按 Bot 下发策略决定**（PR #204）：`GET /v1/bot/card/profile` 的顶层 `config` 成为 reasoning / display / interactive 三类卡片的**唯一权威**，插件不再自行决定发不发卡。
  - 移除本地自动的 Model B 进度卡回退，旧的本地卡片开关不再参与决策；reasoning 进度卡严格使用服务端选定的那个 Registry 模板 ref，最终答复仍走普通文本路径。
  - 新增进程内共享的 per-Bot profile 缓存：带 TTL、并发请求去重、按 generation 安全失效，并消费 `bot_setting_updated` 事件即时刷新。调用方各自的 abort 预算不会取消这次共享的 profile 请求。
  - fail-closed：profile config 缺失、格式错误或自相矛盾时，在执行时刻拒绝而不是猜一个默认值。工具发现只在缓存里有权威 deny 时才隐藏工具，未知状态保持可见并在执行前再校验一次。已存在的 reasoning 卡在新发送被禁用后仍可收到终态编辑。
  - 兼容性与部署顺序：`cardProgress` / `reasoningCardTemplateMode` / `cardDisplay` / `cardInteraction` 保留为 deprecated 类型，但运行时忽略、也不再出现在公开 schema。服务端对应改动是 octo-server #706 —— **先升级本插件，再在服务端设 `reasoning_enabled=false`**，否则旧版插件仍会发裸 Model B 卡，而服务端刻意不把它们归类为 reasoning 卡。
- **可选接入服务端 `/v1/bot/events` long poll，卡片点击响应从秒级降到几十毫秒**（PR #194）：服务端侧是 octo-server #685，给事件接口加了可选的 `wait`（秒），队列空时把请求挂住、有事件立刻应答，而不是等下一个轮询周期。
  - 现状：`startEventPoller` 每 `pollIntervalMs`（默认 2s）短轮询一次，一次卡片点击要 0~2s 才到 bot，且每个空闲 bot 长期维持 ~25–30 请求/分钟。开启后点击在几十毫秒内送达，空闲流量随 hold 时长下降：最小值 5s 约 12 请求/分钟，hold 到 12s 及以上约 5 请求/分钟。
  - **默认关闭、需显式开启**：新增 `eventWaitSeconds`（顶层默认 + `accounts.<id>` 覆盖）。不设它时升级后行为与旧版逐字一致。
  - 三个承重细节：**客户端超时**从固定 10s 改为 `wait * 1000 + 10s` —— 客户端永远不能是先放弃的一方，否则会丢掉服务端正要返回的那批事件（这个固定超时也正是服务端把 hold 做成 opt-in 的原因）。`eventWaitSeconds` 的取值区间是 5~30s，因此单次请求超时最高 **40s**，按这些说明配代理 / 读超时时请按 40s 留余量；**轮询节奏由每次请求的实际结果推导**，而不是由 `waitSeconds` 决定（拿到事件 → 立即续拉；空但确实被挂住了（耗时 ≥ 请求 wait 的 50%）→ 立即续拉；空但过早返回 → 判定服务端没在 hold，退回 `intervalMs`；出错 → 从 `intervalMs` 起指数退避、上限 30s、成功即重置）；**`stop()` 学会中止在途请求**，因为轮询是单条顺序链，把单次请求上限从 10s 抬到最高 40s 后，关停时不能再靠等它自己回来。
  - 与服务端 PR 无合并顺序依赖：老服务端 + 开了开关时，服务端会立刻返回，poller 探测到 hold 未被兑现并退回 `intervalMs` 节奏 —— 这是探测出来的 no-op，不是嘴上保证的。收益只在两端都部署且 `eventWaitSeconds` 已配置时出现。

### Fixed
- **被服务端限流后 bot 直接失联约 40 分钟，只能手工重启 OpenClaw**（#196, PR #208）：真正让 bot 下线的不是限流本身，是限流之后那条没有回头路的路径。
  - 根因链：服务端按源 IP 的限流桶对 `/v1/bot/heartbeat` 返回 429 → 插件把它计作第三次失败并拆掉 WebSocket（一条 REST 存活心跳说明不了 socket 是否健康，服务端也没有任何地方读这条心跳写入的 key）→ 三次快速断连后 socket 不再自行重连、把责任交给 token refresh，而 refresh 的 `registerBot` 因为同一个限流原因失败、它的 `catch` 只打了日志。此时 `needReconnect` 已是 false、socket 定时器已清、心跳只能从 `onConnected` 重启 —— 进程活着，但已经没有任何东西会把它连回来。
  - **429 退避收归一个负责人**：`postJson` 把 `Retry-After` 当作**最早**可重试时刻（jitter 只增不减；等待超过上限时直接放弃重试而不是缩短它 —— 缩短意味着回到服务端允许的时间点之前）。有自己节奏的调用方显式退出这套，因为把 sleep 藏在调用里即便退避本身是对的也是错的：心跳是周期性的、typing 与已读回执可丢弃、事件轮询按每次请求的结果自定节奏、ack 失败只记日志、进度卡帧共用一个 flush 槽。
  - **心跳不再碰 socket**：生命周期跟随账号，一次没能完成的重连不会让它永久停摆。429 只记日志、不计入失败；真实失败最多升级成一行日志。
  - **没有路径能让账号搁死**：连接建立阶段加了截止时间（此前完全没有，而卡在 CONNECTING、或 OPEN 但收不到 CONNACK 这两种情况都不产生 close 事件、也不触发 ping 超时）；延迟重连改走一个受追踪、可取消的句柄，不再凭空消失；新增守护定时器在慢节奏上检查"是否有账号该重连却没人在重连"。
  - **进度卡帧尊重限流窗口**：某后端返回 429 后记录它下次接受帧的时间，在此之前 flush 只保留最新状态而不去敲门，窗口结束时每张卡唤醒一次。窗口按后端维度记（服务端桶是按源 IP 的），并封顶 5 分钟，避免一个超长的 `Retry-After` 让该后端所有卡片沉默一整天。
  - **不解决的部分**：桶空着时发送仍会失败 —— 三次尝试跨 2~3 秒，扛不过空了一分钟的桶。变化的是频率：我们不再对一个已经拒绝我们的桶继续加压。配额隔离属于服务端改动，此处刻意不做。
- **agent 用 `message` 工具发出答复、本轮没有 final text 时，进度卡被判成「Generation failed / Reasoning was interrupted」**（PR #198）：用户其实已经拿到答复，只有卡片在喊失败，而卡上每个工具步骤都是绿的。
  - 根因：走工具投递时 reply dispatcher 的 deliver 回调从不被调用，`replySucceeded` 保持 false，`finalizeCard` 于是把卡推到 `phase=error`。
  - 这是插件自己的问题，不是 host：OpenClaw core 的 `resolveAttemptTrajectoryTerminal` 把同一轮算作**成功**（它统计 messaging 工具的投递证据），dispatch 正常收尾、从不抛 `non_deliverable_terminal_turn` —— 我们只是没消费那份证据。
  - 修复：把一次成功投递到本卡自己频道的 `message` 工具发送算作本轮的答复投递。归属 fail-closed：`action` 必须是 `send`、目标必须显式、`channelId` 与 `channelType` 都要匹配；显式的 `errorText` 仍然优先于这份证据。
  - 为什么此前看起来时好时坏：只要本轮有任何 final text，`replySucceeded` 就会翻真并掩盖它。
  - 顺带说明：卡上那句"Reasoning was interrupted"是 `reasoning-process.ts` 里的硬编码兜底（仅在 `errorText` 为空时使用），它断言了一个我们从未确立的原因，把第一轮排查带向了超时方向 —— 真正的超时走 `expired` 分支、文案不同。
- **通过卡片工具投递答复后返回 `NO_REPLY`，推理卡仍收成 Failed**（PR #209）：与上一条同源、下一层。
  - 根因：#198 加的投递统计只认核心 `message` 工具。Octo 自有的 `octo_send_display_card` / `octo_send_card` 刻意不参与进度步骤渲染，所以它们的成功结果从未设置投递证据；模型随后返回 `NO_REPLY`，卡片就在请求的卡片其实已经送达的情况下收成 `Failed / Interrupted`。
  - 修复：这两个工具的成功结果也算作答复投递证据，且只接受各自**明确的**成功信封 —— `details: null` 与 hook 错误仍然算失败；同时保留 dispatch 失败的优先级，投递证据不能掩盖一次真正失败的轮次。
  - 覆盖：成功 / 失败 / 优先级三类单测，外加真实 OpenClaw 容器 E2E 跑 display-card 投递后接 `NO_REPLY` 这条路径。
- **同一套部署里，失败的推理卡是展开还是折叠取决于服务端广告了什么模板**（PR #202）：Registry 卡（Model A）在 `error` 时保持推理轨迹展开，而本地 `renderProgressCard` 对所有终态一律折叠，两者由模板协商结果决定谁来渲染。
  - 只对齐这个布尔量并不叫 parity：error 块位于 `trace_panel` **内部**，折叠轨迹会把失败原因一起藏掉，常驻可见的 header 只剩 `✦ Reasoning`、一个恒定的 `Interrupted` 和 `Failed` 徽标。
  - 修复：失败原因改由 `timerText` 承载（形如 `⚠️ Interrupted: provider timeout`）。选它而不是改布局，是因为 Model A 的布局归服务端模板所有 —— 把 error 块从本地容器里提出来只能修好本地渲染器，模板卡照旧坏着；`timerText` 是两个渲染器都消费的数据，是唯一能同时修好两者的层。长度沿用 `sanitizeErrorText` 已有的 `ERROR_MAX`。
  - `expired` 单独给文案而不是复用通用那句：它来自 paused 卡的 TTL 定时器，此时没有 dispatch 在跑、也不会有伴随的文本消息，卡片是用户唯一的信号。
  - 折叠摘要不再把失败标成成功：`collapsed_panel` 原先硬编码 `✓`，在终态默认折叠之后这从"手工折叠失败卡才会看到"变成了**默认呈现** —— 每个失败与中止都显示成 `✓ Interrupted …` 配一个 Attention 色的 `Failed` 徽标。字形现在按状态推导（`error` / `stopped` → `⚠`）。
- **推理卡显示得比预期少时，说清为什么**（PR #206）：`FALLBACK_THOUGHT`（`Thinking through…`）有六个触发路径，还有第七条会把 OpenClaw 自己的诊断句原样渲染到群可见的卡上。读者分不清"模型什么都没产出"和"我们扣掉了它说的话"，而只有后者是可行动的。
  - `resolveReasoningThought` 现在返回四种明确结果：`text`（脱敏后的原文）、`no-summary`（"Reasoned without a visible summary"）、`redacted`（"Reasoning hidden — matched a redaction rule"）、`none`（不渲染思考行）。实测一次真实群会话：七个 thinking 块全部带 `thinkingSignature`，三个有文本、四个为空 —— OpenAI Responses 在 `summary: "auto"` 无产出时、以及 Anthropic 的 `redacted_thinking` 都会走到这里。
  - `redacted` 的文案刻意指向**规则**而非内容：这道守卫是 fail-safe 的，命中并不证明那里真有凭证 —— 长 hex、git SHA 等高熵字符串同样会触发。
  - 思考文本上限原为 280（一条推文的长度）：线上一张群卡正好在第 280 字符处断在句子中间，丢掉的恰是"模型接下来要做什么"那半句。放开长度后补上三层约束才真正收住：模板数据契约、聚合思考预算（逐字段 clamp 之后聚合仍然无界）、UTF-8 字节预算（按 rune 计仍然没有约束真实 payload 字节数）；send 与 edit 用的信封字段不同，因此精确打包会让 edit 超限，需要预留余量。
  - 已知脆弱点（在常量处注明）：识别 `no-summary` 依赖匹配 host 里一句硬编码英文，OpenClaw 升级可能静默改写它，而我们的测试用的是自己那份常量、不会因此变红。长期正解是上游给一个结构化标记。
  - 顺带修掉 skill 文档里指向已不存在配置键的说明。
- **默认配置下就能触发的两个卡片摘要缺陷，并把行为固化成可执行语料**（PR #203）：两个缺陷在当时的 `main` 上无需任何配置即可复现。
  - **归约管线无界**：`reduceUrlsInText` 的 pass 是二次复杂度且有 11 个调用点，所以边界必须放在它**内部** —— 早期版本放在 `summarizeToolParams` 只护住一条路径，漏掉了 `card-action-status.ts`，而后者的输入是群成员提交的表单值、是这组入口里信任级别最低的一个。默认配置下拿 `"a"×100k + "?x"` 实测：`reduceUrlsInText` 在 `main` 上 9814ms、`sanitizeErrorText` 10269ms；现在两者在任何 pass 跑起来之前就拒绝，该输入渲染为空 —— 那是边界在起作用，不是管线变快了。
  - **裁剪永远落在空白处，不切进 token 中间**：多个 pass 靠锚点定位要中和的内容，在 password 与它的 `@host` 之间盲 `slice` 会消掉锚点、把 password 明文渲染出去。保持 token 完整也意味着靠近裁剪点的 secret 要么整个留下（并被抓到）、要么整个丢掉，且代理对不会被劈开。
  - **裁剪不能把守卫正在读的证据一起删掉**：守卫检查的是**截断后**的字符串，所以丢掉尾部的 `token` / `password` / `AKIA…` 会让一个正因为那个关键词才被扣掉的凭证看起来是干净的。`boundedForReduction` 现在会用调用方自己的 predicate 扫一遍它准备丢弃的那一段。
  - 行为以可执行语料 `src/card-render.corpus.ts` 为准（LEAK / BENIGN / COST / REWRITE / UNFIXED / PERF 六组），不再由 PR 描述、README 和语料三处各写一份 —— 手工维护的多份说明会漂移，最终出现文档声明与代码矛盾。想知道某个输入渲染成什么，答案在语料里，且是可执行的。
- **补完随输入规模增长的每一步的边界**（PR #207）：`REDUCE_INPUT_MAX` 只约束了二次复杂度的归约 pass 本身，pass **周围**同样随不可信输入增长的工作却跑在同步、没有 `try`/`catch` 的路径上。
  - 现在三道限制各管一段：`RAW_INPUT_MAX`（64 KiB）管原始工具摘要提取、归约前的空白折叠、以及被丢弃尾部的扫描；`REDUCE_BUDGET_PER_CARD`（120 000）管单张 display 卡的累计脱敏工作量；`exec` 摘要的 4000 字符裁剪管归约管线之上的程序名提取。工具参数在 `trim()`、路径 `split()`、URL 解析之前就按 `RAW_INPUT_MAX` fail-closed。
  - 原先二次复杂度的 JWT 正则换成一次线性扫描，keyword、已知前缀、JWT、超长 userinfo 与通用 secret 五类检测共用一个 `SensitivePredicate` 权威实现 —— 消除了那个反复让扣留信号变得不可见的距离窗口，同时让归约与丢弃尾部的工作量与原始输入长度无关。
  - 无 scheme 的 `user:pass@host` 形式被归约成它的 host，且发出的 host 必须在匹配到的 host 段里**逐字出现**，以此防止 `new URL()` 的归一化、凭空构造与大小写折叠产生输入里根本不存在的输出。

## [1.2.0](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.1.2...v1.2.0) (2026-07-30)

### Added
- **消费 Registry 下发的 reasoning-process 模板渲染推理进度卡（Model A）**（#186）：进度卡从「只能由插件本地渲染（Model B）」升级为「优先消费服务端 Bot card profile 广告的 `ai.reasoning-process` 模板」，把模型的推理文本与工具调用轨迹以结构化模板帧（`template_ref` + `state` + `data`）呈现在群里，而非只有一个粗略的本地卡。
  - 工作方式：从 Bot card profile 发现兼容的 `ai.reasoning-process` 模板，捕获用户可见的推理文本 + 安全的工具输入/输出摘要，以稳定 reasoning ID、单调递增的 `card_seq` 编辑、瞬态进度帧与终态发送 Model A 卡；通用卡与 agent 自撰的 display 卡仍走 Model B。
  - 新增配置 `reasoningCardTemplateMode`（顶层默认 + `accounts.<id>` 覆盖，与 `requireMention` 同款分层），三态：`experimental`（**默认**，服务端广告兼容模板则发 Model A，否则回退 Model B）、`shadow`（只做发现验证仍发 Model B）、`off`（纯本地 Model B）。
  - 安全与隐私：推理文本**仅当** OpenClaw reasoning visibility 为 `on` / `stream` 时才捕获，经与其他可见输出同一套 URL / 凭证脱敏管道处理、疑似 secret 形态 fail-closed、并有长度上限。**注意**：在群里开启 reasoning 可见性等于把模型思考过程公开给该 channel 全体成员。不影响 `octo_send_display_card` / `octo_send_card`。

### Fixed
- **`sessions_yield` 后 continuation 只产出终稿文本时，进度卡永久冻结在「正在处理」**（#180, PR #189）：多工具 + final text 的任务经 `sessions_yield` 让出后，若恢复的 continuation 只回最终战报、不再调任何新工具，进度卡最后一步图标永远停在 ⏳，直到 1 小时 TTL 才被误标为「⏱️ 等待超时」——即便任务其实成功。
  - 根因：yielding run 收尾时把带 `messageId` 的可见卡移入 `pausedCards`；它 resume 后是一次新 dispatch，`setCardContext` 为其新建一张空 entry（无 `messageId`）。continuation 只产 final text 时这张空 entry 拿不到 `messageId`，`finalizeCard` 命中 `!messageId` 早退，躺在 `pausedCards` 里的真卡从未被推进到终态；非 subagent 的 bare yield 又没有 completion event 去认领 `continuationRunId`，lifecycle / `agent_end` 的兜底也不触发。
  - 修复：给 `finalizeCard` 加收尾兜底——当本 run 无法承载终态帧（`!messageId`）、本 run 已收尾（非 paused/resuming），且能证明本次收尾 run 归属该 paused 流程时，把孤儿卡直接收到 ✅ 已完成 / ⚠️ 已中断。
  - 归属校验 fail-closed：run 归属（`owner.runId === pausedFromRunId`，同一 yielded run resume 后收尾）、同身份（防跨账号）、不抢占仍在等子任务或已被 `continuationRunId` 认领的 subagent-yield 流程（那些仍由 lifecycle 收尾）、无 entry 可校验时直接返回不碰 `pausedCards`。
- **进度卡 / reasoning 卡的 fallback 文案与格式打磨**（#182）：进度卡文案改为紧凑英文并**保留原始工具名**（如 `read` / `write`），让客户端按稳定标识本地化，而非渲染翻译后的标签；长耗时按分钟 / 小时格式化，`fmtDuration` 对非有限值 / 负值返回空串并按四舍五入后的秒选单位，消除 `59_999ms → 60.0s` 这类落到分钟分支想避免的输出。
  - 截断标记改为可注入选项（默认仍中文，只有进度卡传英文 marker，agent 自撰的 display 卡不受影响）；进度卡与 reasoning 卡各有独立英文 placeholder，`inbound.ts` 仍用中文 placeholder。
  - 放宽一处脱敏守卫：`safeLabel` 改为按 `__` 分段扫描 MCP 标签，避免把 32+ 字符的 snake_case MCP 工具名误判成 secret 而渲染成「Tool」；关键字 / 已知前缀检测仍按段 fail-closed。
- **reasoning 模板版本改为信任服务端广告值，不再用本地版本白名单**（#188）：#186 的选择器带本地 `0.1.0` / `0.2.0` 白名单 + 「多版本选最新」推断，与 octo-server 的权威跨仓契约冲突（契约要求从 manifest 动态取版本、不设本地 allowlist、多版本无 semver 策略时 fail-closed）。
  - 修复：移除本地 allowlist，直接使用 catalog 中**唯一**的兼容版本；出现 0 个或多个兼容条目、无效版本、未知 Submit action、重复必需 view 时一律 fail-closed 回退 Model B。
  - 新增首帧重试：**仅当**初次 Model A 发送收到确定性的 `card_invalid` 响应、且已广告兼容的 Model B profile 时，首帧作为 Model B 重试**恰好一次**；超时 / 冲突 / 卡片禁用 / 瞬态 / 服务端错误均不触发；已存在的 Model A 消息永不切换 wire 模式。
- **`sendMedia` 发送裸绝对路径媒体时抛 `Invalid URL`**（#183, PR #184）：图片生成等工具产出的裸绝对路径（如 `/home/.../image.jpg`）经 `sendMedia` 发送时抛 `TypeError: Invalid URL`，媒体从未送达。
  - 根因：`sendMedia` 只识别 `data:` 与 `file://`，其他一律落到 HTTP 分支的 `new URL(mediaUrl)`，裸绝对路径无 scheme 直接抛错。
  - 修复：对 `path.isAbsolute()` 的 `mediaUrl` 按 `file://` 同等处理，从磁盘读取并走预签名上传路径，不再交给 URL 解析器。纯新增分支，不影响既有 `data:` / `file://` / http(s) 行为。

## [1.1.2](https://github.com/Mininglamp-OSS/openclaw-channel-octo/compare/v1.1.0...v1.1.2) (2026-07-23)

> 版本号从 1.1.0 直接跳到 1.1.2：1.1.1 此前因 ClawHub 发布重试被占用（内容等同 1.1.0），本次跳过以避免版本号语义歧义。

### Fixed
- **`sessions_yield` 让出等待期间，进度卡被误判为「已中断」**（#176, PR #178）：agent 主动 `sessions_yield` 让出、等待子任务（subagent）结果时，dispatch 收尾把进度卡渲染成终态「⚠️ 已中断」，用户误以为任务失败，且子任务真正完成后回来也无卡可更新。
  - 根因：yield 属于「正常暂停等待」而非「运行结束」，但收尾路径只有 done / error 两种终态；且下一条 inbound 的 `setCardContext` 会覆盖同 sessionKey 的 `messageId`，让后台任务回流时找不到原卡。
  - 修复：`sessions_yield` 成功后进度卡进入 `paused`（⏸️ 等待任务结果），并把卡从活跃 `cards` 挪进独立的 `pausedCards`，与后续 inbound 隔离，避免 messageId 被覆盖。受信子任务完成事件回流 → `resuming`（🤖 正在整理结果）→ `done`（✅ 已完成），全程复用同一张卡。
  - 安全与健壮性：completion 事件仅认 host 生成的受保护 internal-context 块 + `childSessionKeys` 白名单，用户伪造文本命不中；乱序 start/end 编辑经尾指针串行化，迟到帧不会覆盖终态；跨身份同 sessionKey 碰撞 fail-closed；paused 卡有 1 小时 TTL 有界回收；旧 host 无 lifecycle API 时回退到 `agent_end` + 成功的 `sessions_yield` tool hook。
  - 体验：终态卡新增「⏸️ 等待子任务 · <时长>」独立明细，把后台等待时间与工具执行耗时分开计，不再让大段端到端时长无法解释。
- **主动 / 工具驱动的私聊(DM)发送报 `400 query_failed`**（#170, PR #173）：经通用 `message` 工具向 DM 目标发送时，请求以群(`channel_type=2`)身份查询 DM uid，服务端查无此群返回 400。普通 DM 回复不受影响（inbound 路径直接钉 `ChannelType.DM`），只有 `message(action=send)` 这条路踩到。
  - 根因：DM 目标形如 `octo:<uid>`，`normalizeOutboundChannelPrefix` 落到通用群兜底(`group:` + bare)，把 DM 当群。
  - 修复：`octo:` 视为命名空间前缀而非频道类型标记，按内层形状解析——`user:`（含 `octo:user:`）→ DM；显式 `group:`/`channel:` token → 归一到单一 `group:`；裸 `octo:<id>` 无 user/group 线索 → 交由 `parseTarget`/`knownGroupIds` 分类（已知群→Group，否则→DM）。输出不再携带 `octo:`。DM 卡片共用 `resolveOutboundOctoTarget`，同样受益。
- **`message` 工具发送成功后，工具卡抛 `Cannot read properties of undefined (reading 'reduce')`**（#171, PR #175）：消息已成功投递，但工具结果转换阶段报错。与 #170 不同层、不同根因。
  - 根因：`handleAction` 返回裸业务 JSON(`{ ok, data }`)、无 `content` 字段，而 host 的 Codex 动态工具结果转换对 `result.content` 直接 `reduce`、无 `Array.isArray` 守卫，`undefined.reduce` 在消息投递**之后**抛出。
  - 修复：新增 `toActionToolResult` helper，把两条返回路径都包成合法 `AgentToolResult`——`content[]` 满足 host 契约让 reduce 不再抛；原始 payload 保留在 `details` 里，host 的成功/失败分类与下游 payload 提取行为不变；紧凑 JSON 避免膨胀大的 read/search/group-md 结果；序列化带 try/catch + 类型守卫，helper 永远返回字符串、绝不在发送成功后自身失败。异常刻意不在此捕获，交由 host 的 after-tool-call 错误 hook 与失败幂等键保留逻辑处理。
- **未配置的私聊(DM)不自动投递回复**（#172, PR #177）：收到 DM（回执 + typing 正常）但 bot 无可见回复，同会话后续 DM 排队堵在其后；群聊不受影响。
  - 根因：DM 与群共用一次 dispatch，`replyOptions` 未请求投递模式；host 对 DM 按 `ChatType` 解析，Codex harness 的 `defaultVisibleReplies` 为 `message_tool`，导致**未配置的 DM** 解析成 `message_tool_only`——agent 不调 message 工具时最终文本不自动投递。群聊走 `groupChat.visibleReplies ?? messages.visibleReplies` 兜底为 `automatic`，故一直正常。
  - 修复:仅对「operator 未设 `messages.visibleReplies`」的 DM 请求 `sourceReplyDeliveryMode: "automatic"`,纠正这一处隐式 harness 默认。因请求模式优先级高于 config,刻意**不**注入群聊、也不覆盖已显式配置的 `visibleReplies` / `groupChat.visibleReplies`,以免改变群行为或越过 operator 意图。

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
