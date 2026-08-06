# Plan: 修正 DM 默认可见回复策略(未配置时注入 automatic),修 DM 无回复(#172)

## 背景 / 问题

Octo **DM** 收到(readReceipt + typing 正常),但 bot **无终稿回复**,且同 session 后续 DM 全排在它后面 → 表现为"bot 彻底不回复了"。**群聊正常**,排除渠道级/Bot-API 级故障。

环境:Octo 插件 `1.1.1`,现场 host `2026.7.1-2`,runtime = **Codex app-server**。

> **版本核验说明**:根因链对本地实际安装的 `node_modules/openclaw` **`2026.6.9`** dist 核对。`sourceReplyDeliveryMode` 交付模式语义在两版间大概率一致,但未在 `2026.7.1-2` 同版本核验;最终端到端确认需现场 host + Codex runtime。

## 现场证据

```
Octo DM inbound: received / channel_type:1 / readReceipt:OK / typing:OK
agent dispatch: started
final delivered: (none)
dispatch finished: (none)
→ 同 session 后续 DM 排队,永不处理
```

## 两个独立诱因(不可混为一谈)

1. **回复 dispatch 不 settle → per-session 队列阻塞。** 插件维护 per-session inbound 队列;首条 DM 的 dispatch promise 若不 settle,DM#2/#3 全卡在它后面。**本 PR 不修这一层**——是否真未 settle 取决于模型空 payload / runtime hang(见诱因 2),队列的最终释放已由现有 #75 超时守卫兜底。
2. **模型空 payload / DM 默认交付策略 → 无可见回复。** 一是某些 runtime/thinking level 下 reasoning 模型返 `payloads=0` 的 incomplete turn(模型侧,独立);二是 DM 默认解析成 `message_tool_only` 导致终稿不自动交付(见下根因)。**本 PR 只修后者(DM 默认可见回复策略)**,不掩盖前者。

## 根因(已对 host `2026.6.9` 源码逐分支坐实)

`src/inbound.ts:2859` 向 host dispatcher 传 `replyOptions: {}`(即 `sourceReplyDeliveryMode` 为 **undefined**)。DM 与群**共用这一处** dispatch(`isGroup` 决定 reply 目标,但传给 dispatcher 的 `replyOptions` 两者相同)。

host `resolveSourceReplyDeliveryMode`(`source-reply-delivery-mode-D6vMorP8.js`)按 `ChatType` 分支解析"终稿是自动交付还是必须靠 message 工具":

```
requested(我们传的) 若非空且合法 → 直接采用(优先级最高,盖过下面所有 config)
…
DM(else 分支):  mode = (cfg.messages?.visibleReplies ?? defaultVisibleReplies) === "message_tool" ? message_tool_only : automatic
群/channel 分支: mode = (cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies) === "message_tool" ? message_tool_only : automatic
```

关键事实(均已 grep 核实):

- Octo 只设 `ChatType`(`inbound.ts:2562`),**不设 `InboundEventKind`**;所以不是 `room_event` 那条分支。
- **DM 且未配 `messages.visibleReplies`** 时,fall 到 `defaultVisibleReplies` —— **Codex harness 默认是 `"message_tool"`**(`harness-6rPoIoQE.js`)→ DM 解析成 `message_tool_only` → **终稿不自动交付,必须 agent 调 message 工具**。现场 Codex runtime 上 reasoning 模型没调工具 → 用户看不到任何回复。
- **群**在 `groupChat.visibleReplies` 与全局 `messages.visibleReplies` **均未配置**时 → `automatic` → 一直正常(全局配了 `message_tool` 则群也会是 message_tool_only)。**这才是"DM 坏、群好"的真因**:是 DM 的默认交付模式解析问题,与渠道无关。

### 因果表述的边界(不过度归因)

被抑制的终稿在 host 侧会被**跳过但仍标 completed 并返回**(`dispatch-F64i6im_.js` 附近),即 `message_tool_only` 本身只造成"**无可见回复**",**不应自行让 dispatch 的 Promise 悬挂**。因此本 PR 定位为:**修正 DM 的默认可见回复策略**(把"用户看不到回复"修好),**不宣称从机制上修复 dispatch settle**。

现场观察到的 "dispatch finished:(none)" + 队列堆积,可能叠加了**诱因 2(模型空 payload → incomplete turn)** 或真正的 runtime hang —— 那是独立层级,**本 PR 不碰、也不掩盖**;队列的最终兜底已由现有超时守卫覆盖(见下)。

## 修复方案

**只在"DM 且运维未显式配置交付方式"时注入 automatic**,精确覆盖 Codex harness 的隐式 `message_tool` 默认;群聊、以及任何显式 `messages.visibleReplies` / `groupChat.visibleReplies` 一律交给 host 原样解析。

`src/inbound.ts:2861` 处(`replyOptions:` 那一行):

```ts
replyOptions:
  !isGroup && config.messages?.visibleReplies === undefined
    ? { sourceReplyDeliveryMode: "automatic" as const }
    : {},
```

- `!isGroup` → 只影响私聊,群聊保持 `{}` 不动。
- `config.messages?.visibleReplies === undefined` → 只在运维**没设过**时注入;一旦设了(无论 `message_tool` 还是别的),尊重运维,传 `{}` 让 host 按配置解析。
- 因为 host 里 `requested` 优先级最高,所以"注入 automatic"只在我们确认该覆盖 harness 默认时才做;其余情况绝不 requested,避免盖掉配置。

### 为什么不无条件传 automatic(踩过的坑)

`requested` 优先级盖过 `messages.visibleReplies` 和 `groupChat.visibleReplies`。无条件传 `automatic` 会:① 改变群聊交付(群本正常);② 覆盖运维显式配的 `message_tool`。故必须收窄到 DM + 未配置。若产品将来要"Octo 强制 automatic",应新增明确的 Octo 配置项并文档标注是有意覆盖 host 配置的破坏性语义 —— 不在本 PR。

### 不新增超时兜底(已存在)

`Promise.race([dispatch, dispatchTimeoutPromise])` + `resolveDispatchTimeoutMs`(为 #75 加)已在;超时会 rethrow 让 `enqueueInbound`(`inbound-queue.ts`)推进队列。队列释放兜底不缺,本 PR 不重复加。

### 不改动的点

- 群聊交付、显式配置解析、dispatch 超时守卫、onError/finally-flush 全不变。
- `src/commands/fork-inbound.ts:166` 也以 `replyOptions:{}` 调 dispatcher,但那是**独立的 fork 子区 seed 投递**(spawnChildBoundSession seed),不是普通消息 inbound,**不纳入本次 DM 修复**。
- 只改普通 inbound 的这一处 `replyOptions`。

## 回归测试(复用 inbound-member-roster.test.ts 的 runtime stub 范式)

`installRuntimeStub` 返回 `dispatch` mock(= `dispatchReplyWithBufferedBlockDispatcher`),可断言其收到的 `replyOptions`。TDD,**测试矩阵锁定条件逻辑**(不是只证"传了 automatic"):

1. **DM + 未配 visibleReplies → 注入 automatic**:驱动 `handleInboundMessage` 处理一条 DM(channel_type=1),cfg 不含 `messages.visibleReplies`,断言 `dispatch` 收到 `replyOptions: { sourceReplyDeliveryMode: "automatic" }`。
2. **DM + 显式 `messages.visibleReplies:"message_tool"` → 不覆盖**:同 DM,cfg 设该值,断言 `dispatch` 收到 `replyOptions: {}`(尊重运维,不注入)。
3. **群 → 不注入**:群消息(channel_type=2),cfg 不含配置,断言 `dispatch` 收到 `replyOptions: {}`(群保持默认 automatic 由 host 解析,我们不 requested)。
4. **群 + `groupChat.visibleReplies:"message_tool"` → 保留**:断言 `dispatch` 仍收到 `replyOptions: {}`,证明群的 message-tool 配置不被我们破坏。
5. **投递回调回归(改名,非 host-settle 证据)**:stub deliver 触发 `{kind:"final"}` 后终稿被投递(sendMessage 被调)——这条**只证插件的 deliver 回调仍工作**,标题明确写"plugin delivery callback regression",**不作为"automatic 让 host settle"的证据**。

> 说明:runtime stub 不消费 `sourceReplyDeliveryMode`,插件层单测**只能确定性验证"我们在正确条件下传了正确的 option"**;"DM 真的不再无回复/不再堆积"是 host 侧行为,需现场同版本 Codex runtime 端到端验证。

## 验证

- `npx vitest run` 全量 + `npx tsc --noEmit` 干净。
- build → pack → install → 重启 → octo channel OK + 结构断言(条件矩阵:DM 未配注入、DM 显式配不覆盖、群不注入)。
- 端到端"DM 不再无回复"只能在 **Codex runtime** 现场证伪(本地明湖 claude 路径 `defaultVisibleReplies` 不同,复现不了 DM 的 message_tool 默认);本地以源码级 + 条件矩阵断言为主,现场做最终确认(与 #170/#171 同类约束)。

## DoD

- `replyOptions` 仅在 **DM 且 `config.messages?.visibleReplies === undefined`** 时带 `sourceReplyDeliveryMode: "automatic"`;群聊、显式配置一律 `{}`。
- 回归测试覆盖上述 5 项(尤其 DM-未配注入 / DM-显式配不覆盖 / 群不注入 / 群配保留),防回退且防 C2 配置回归被固化。
- 全量测试绿、tsc 干净;仅改 `src/inbound.ts` 一处 + 对应测试,单一职责。
- 根因表述如实(修 DM 默认可见回复策略,不宣称机制修 dispatch settle);不碰诱因 2、不碰 fork seed、不重复加超时兜底。
- 无 provenance 痕迹。

## Scope / 顺序

- 独立分支 `fix/octo-dm-dispatch-settle`,基于最新 `origin/main`(已含 #170)。改 `src/inbound.ts`,与 #171(channel.ts)不同文件。
- 走完整 Qflow:plan 过 codex 关 → TDD 开发 → cc-review ‖ codex-review 双审 → 本地包测试 → PR 合回 main。
