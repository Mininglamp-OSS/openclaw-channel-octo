# 插件侧限流(429)韧性 —— 心跳不再拆连接、退避单一所有者、重连补兵底

> 对应 issue #196：`xiaow_king_bot` 在高频对话后 `/v1/bot/heartbeat` 连续 429，心跳连败 3 次触发"断联"，实际断联约 40 分钟，必须人工重启 OpenClaw 才恢复。

## 背景

### 429 从哪来（服务端，插件不改）

- `octo-server/main.go:199-211`（GitLab 版 `main.go:210-222`）挂了**全局 per-IP 令牌桶** `ratelimit:ip:`，默认 500 rps / burst 1000，`route.Use` 覆盖所有端点，只排除 `/v1/ping`、`/v1/health`（`main.go:53-55`）。桶 key 是解析后的客户端 IP（`octo-lib/pkg/wkhttp/ratelimit.go:195-209,234-268`），**同一出网 IP 下所有客户端 × 所有未排除端点共享一个桶**。
- `/v1/bot/heartbeat` 所在的普通 botAPI 路由组只挂 `ba.authBot()`（`bot_api.go:212`，GL 版 `:263-276`），**没有 per-uid / per-bot / App Bot 专有限流**。
  - 需要修正的一处：GL 版另有 `/v1/bot/messages/_search*` 挂了 UID 桶和搜索专用桶（`bot_api/search_route.go:28-53`），插件不调这组端点，与本 issue 无关，但"bot API 上完全没有 UID 限流"的说法不准确。
- **限流本身是正常的服务端设计**，插件的责任是被限流时表现得当。给 `/v1/bot/*` 按 bot token 单独发桶不在本设计范围，另行提 octo-server issue。
- 归因边界：以上结论基于 `octo-server` / `octo-server-gl` / `octo-lib` / `octo-deployment` 四个仓库的代码核实。**仓库外的 CLB / WAF / Ingress 是否另有限流规则，本地代码无法排除** —— 见文末"开放问题"。

### 插件侧的四个缺陷（现场链路）

1. **不认 429。** `postJson`（`api-fetch.ts:75-105`）对所有非 2xx 一律 `throw new Error(...)`，`Retry-After` 头与 body 的 `error.details.retry_after` 只被拼进字符串；`channel.ts:1418` 的 catch 不看状态码就 `consecutiveHeartbeatFailures++`。一次 1 秒的瞬时限流被判成"连接坏了"。
2. **药方错了。** 心跳是纯 REST 探活，失败却去拆 WebSocket（`channel.ts:1424-1430`：clear 心跳定时器 → `disconnectAndWait()` → `connect()`）。REST 被限流与 WS 健康无关，这一步拆掉一条正常连接，并把流程推进第 4 条那个死路。
3. **心跳无法自恢复。** `startHeartbeat()` 全文唯一调用点是 `onConnected`（`channel.ts:1614`），而失败路径先 `clearInterval` 了定时器（`:1424`）。只要重连没走到 `onConnected`，心跳永久停摆。
4. **存在真死路。** `socket.ts:413-418` 连续 3 次 <5s 的快速断开 → `needReconnect = false` + 抛 `onError("Connect failed: ...")`；`channel.ts:1638` 的 token 刷新分支里 `registerBot()` 在 429 风暴中同样会 429 → 落进 `:1656` 的 catch，只打一行日志就结束，**不排重连、不设定时器**。此时 `needReconnect` 仍为 false、`disconnectAndWait()`（`socket.ts:308-320`）又已清掉 socket 自己的重连定时器、心跳定时器也已被清 —— 进程活着但永久假死。

补充事实：服务端 `bot:heartbeat:<robot_id>` 只有写（`bot_api/typing.go:227`，TTL 60s）和删（`botfather/command.go:621,758,789`、`botfather/api_user.go:471`、`robot/api_manager.go:371`），GitHub 版与 GitLab 版皆然，**octo-server / fleet / web / matter / adapters 全仓无读方**。心跳失败本身不影响消息路由 —— 真正的"断联"是插件自己拆连接拆出来的。

> 代码只能证明这条死路会**无限期不恢复**；"恰好 40 分钟"来自 issue 的现场观测，不是代码能推出的量。

排查过程中还发现两个**没出现在本次现场、但会让任何兵底方案失效**的既存缺口（`reconnectTimer` 触发后不置 null、建连全程无 deadline），一并列在 §6。

## 目标

1. 429 不再被当成故障：识别它、按服务端给的节奏退避、不污染健康判定。
2. 心跳与 WebSocket 生命周期解耦：心跳失败只告警，绝不动 WS。
3. 任何失败路径都不能让适配器永久假死 —— 一定有兵底把连接拉回来。
4. 429 现场可诊断：服务端已给的 `X-RateLimit-*` / `Retry-After` 落进日志。
5. **429 重试只有一处所有者** —— `postJson`；其余各层要么显式弃权（`retryOn429: false`），要么不自己重试，不出现叠乘。
6. 顺手补齐三个会让上述保证失效的既存缺口（见 §6）。

## 非目标

- **不**在插件侧做客户端自限流 / 令牌桶（决定见"自限流"一节）。
- **不**改服务端限流配额设计。**这是刻意的先后顺序，不是遗漏**：本次事故的症状（断联 40 分钟 + 人工重启）完全由插件侧造成、也能完全由插件侧消除，因为心跳被限流本身不影响消息路由（`bot:heartbeat` 无读方）。而"谁把那个 500 rps 的 per-IP 桶打满"目前**没有证据** —— 单 bot 的量级差好几个数量级，在不知来源时调服务端配额是在猜。本设计 §2 把 `scope` / `remaining` / `Retry-After` 打进日志，正是为了产出这个证据；拿到数据后再评估要不要给 `/v1/bot/*` 按 bot token 单独发桶。
- **不**承诺"限流期间消息一定发得出去"。桶持续干涸时，一次发送带 2 次重试也就跨 2~3 秒，三次全撞 429 仍会失败，用户仍可能看到失败提示 —— 只是频率显著降低（我们不再往干涸的桶里加压）。彻底解决需要服务端配额隔离，见上一条。
- **不**为 5xx / 网络错误新增重试。5xx 时写请求可能已在服务端落地，重试有重复副作用；429 由限流中间件在业务逻辑之前 `RenderError` + `Abort`（`octo-lib/pkg/wkhttp/ratelimit.go:259-269`，不会执行 `c.Next`），请求确定未落地，重试是安全的。这条边界是刻意的，且只对已核实的限流中间件成立。
- **不**把 `botFetchJson` / 裸 `fetch` 的低频写接口迁到统一请求层（见 §2 覆盖面）。

## 设计

### 1. `src/api-error.ts`（新文件）—— 结构化 API 错误

```ts
export class OctoApiError extends Error {
  readonly status: number;
  readonly path: string;
  readonly body: string;                // 截断
  readonly retryAfterMs?: number;
  readonly rateLimitScope?: string;     // X-RateLimit-Scope，如 "ip"
  readonly rateLimitRemaining?: string; // X-RateLimit-Remaining
  get isRateLimited(): boolean;         // status === 429
}
```

`retryAfterMs` 取值优先级：`Retry-After` 响应头（秒）→ body `error.details.retry_after`（秒）→ 默认 1000ms。

**零与极小值一律视为"没有可用提示"。** `0` 是有限非负数，天真的校验会放它过去，然后退避睡 0ms —— 三次背靠背重试，恰好砸在服务端刚说"停"的那一刻。极小正数同理：`0.0004` 秒经四舍五入也是 0ms。所以换算后要再查一次结果是否 > 0，否则回落默认值。

**解析层保留服务端给的原值，不做上限截断。** 只对垃圾输入做兜底（非数字 / 负数 / HTTP-date 格式 → 回落默认 1000ms）。上限 `MAX_RETRY_AFTER_MS` 是**决策阈值**，只在 §2 用来判断"这次还值不值得等"，不能在解析层就把它 clamp 短 —— clamp 短等于把服务端的"30 秒后再来"改写成"10 秒后再来"，那就是提前重试，正是本 issue 要消掉的行为。

**向后兼容（关键）：** `message` 必须继续是 `Octo API <path> failed (<status>): <text>` 这个格式 —— 现有 `API_FETCH_STATUS_RE` / `httpStatusFromApiFetchError`（`api-fetch.ts:55-73`）从 message 正则解析状态码，`card-progress.ts:408` 与 fork-inherit-md 都依赖它。同时把 `httpStatusFromApiFetchError` 改成**优先读 `err.status`、正则作为 fallback**，让新旧两条路径都对。

单独成文件而非塞进 `api-fetch.ts`：`channel.ts` / `heartbeat.ts` / `card-progress.ts` 都要 `instanceof` 它，独立文件避免为一个错误类去 import 整个 REST 层，也让头/body 解析可单测。

### 2. `postJson` —— 唯一的 429 退避所有者

```
attempt = 0; waited = 0
loop:
  if callerSignal?.aborted: throw callerSignal.reason      // 进入前先查
  // 调用方的 signal 优先（它比我们更清楚这次请求该等多久），但仍叠一个硬天花板兜底；
  // 没传 signal 时用默认 deadline。deadline 必须每次尝试重建 ——
  // 建在循环外会变成跨尝试共享，第 2 次尝试可能一出生就过期。
  fetchSignal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(POST_HARD_CEILING_MS)])
    : AbortSignal.timeout(DEFAULT_POST_TIMEOUT_MS)
  resp = fetch(..., fetchSignal)
  if resp.ok: return parsed
  err = OctoApiError.from(resp, path)
  warn(path, scope, remaining, retryAfterMs, attempt)      // 每次 429 都打，含不再重试的那次
  if err.status !== 429: throw err
  if !retryOn429 or attempt >= MAX_429_RETRIES: throw err
  if err.retryAfterMs > MAX_RETRY_AFTER_MS: throw err       // 太久 → 放弃，不缩短
  delay = err.retryAfterMs * jitter(1.0..1.25)              // 只向上抖，绝不早于服务端要求
  if waited + delay > MAX_429_BACKOFF_WAIT_MS: throw err     // 只约束退避等待，见下
  await sleep(delay, callerSignal)                          // abort 立刻抛，原 OctoApiError 挂 cause
  waited += delay; attempt++
```

- `MAX_429_RETRIES = 2`（合计最多 3 次尝试）。
- **抖动只能向上（1.0..1.25），不能向下。** `Retry-After` 的语义是"最早可重试时间"，`0.75×` 会让我们比服务端明确要求的更早再撞一次 —— 那正是这个 issue 要消掉的行为。同理，**服务端给的等待超过 `MAX_RETRY_AFTER_MS = 10_000` 时直接放弃重试，而不是把它 clamp 短**：clamp 短等于提前重试。上限只在这里用来决定"还值不值得等"，解析层不得截断（见 §1）。
- **`MAX_429_BACKOFF_WAIT_MS = 15_000` 只约束退避等待的累计时长，不是端到端预算 —— 名字要如实。** 端到端兜底靠**每次尝试独立重建的 fetch deadline**：改动前 `postJson` 把调用方 signal 原样交给 `fetch`，调用方不传就等于无超时，一个挂住的连接可以永久卡住。deadline 的构造规则见下一条。
- **调用方的 signal 优先，但仍有一个硬天花板。** `/v1/bot/events` 的 long poll 会**故意**要求远超 30s 的超时：`fetchBotEvents` 传的是 `eventsPollTimeoutMs(waitSeconds)`，而 `eventWaitSeconds` 上限 30（`config-schema.ts:143,169`）、margin 10s（`api-fetch.ts:26`），最大 **40s**。所以**不能**拿默认 30s 去和它求交 —— 在 hold 中途 abort 会丢弃服务端正要返回的那批事件，把循环退化成超时重试风暴，这正是上游刻意避免的。
  但"调用方给了 signal 就完全不管"也不行：`AbortSignal` 类型分不出对方是否自带 deadline，将来任何一个裸 controller signal 都会让请求无界挂死 —— 而无界挂死正是本设计要消灭的东西。所以规则是 `AbortSignal.any([callerSignal, AbortSignal.timeout(POST_HARD_CEILING_MS)])`，天花板取 **60s**：高于 long poll 的 40s（不砍合法 hold），又给"忘了带 deadline"兜了底。经 `postJson` 的请求没有任何一个有理由跑满一分钟；超过 60s 的两处（媒体下载 300s / 120s）走的是裸 `fetch`，不经这里。
  调用方没传 signal 时用 `DEFAULT_POST_TIMEOUT_MS`（30s）。

- `sleep` 被 abort 时抛出的错误要把原 `OctoApiError` 挂在 `cause` 上，否则现场只剩一个 `TimeoutError`，丢掉"是被限流"这个诊断语义。
- `OctoApiError.from()` 读响应头必须**容错**（`resp.headers?.get?.(…)`）：`Response`-like 的 mock 与非标准实现可能没有 `headers`，不能因为读头把一个正常的错误路径变成 `TypeError`。
- 新增第 6 个可选参数 `opts?: { retryOn429?: boolean }`，默认 `true`；**以下调用点显式传 `false`**：
  - `sendHeartbeat` —— 周期性任务，30s 后自然重试；且 `bot:heartbeat` 无人读，重试没有收益。
  - `sendTyping`（`inbound.ts:2715` 每 5s 一次）、`sendReadReceipt` —— 可丢弃，重试只给正在干涸的桶加压。
  - **`fetchBotEvents` / `ackBotEvent`** —— 事件轮询有自己的、按结果分档的节奏控制（`events-poll.ts:152-175`：错误走指数退避并在成功时重置）。让 postJson 在里面偷偷睡会**破坏它的判定依据**：`requestMs` 是绕整个调用测的（`:178 → :254`），包含退避睡眠；`eventWaitSeconds: 5` 时"服务端是否真的 hold 了"的阈值是 `5000 × HELD_FRACTION(0.5) = 2500ms`，两次约 1s 的 429 退避就能把 `requestMs` 推过阈值 → poller 误判服务端 hold 过 → `nextDelayMs` 返回 0 → 立即重 poll，正是上游刚修掉的热循环。429 交给 poller 自己的错误退避处理，语义更准。
  - **card-progress 的 flush 路径（占位卡首帧 + `transient: true` 编辑）** —— 见 §3。

**覆盖面（修正过的说法）。** `postJson` 是这些端点的出口：`sendMessage` 全部变体（`:163,308,378,460,548`）、`message/edit`（`:616,645`，即卡片进度帧）、`events` + `events/ack`（`:779,799`）、`typing`（`:816`）、`readReceipt`（`:831`）、`heartbeat`（`:843`）、`register`（`:871`）。
**不覆盖**：`botFetchJson`（`:1175`）与裸 `fetch` 的 GROUP/THREAD.md 读写、群 / thread 管理、voice context、文件上传等（`:1127,1152,1255,1274,1433,1578,1731,1821-2023`）。这些都是低频接口，本次**刻意不迁**——它们被 429 时的表现和今天一样（抛错、由各自 caller 处理），不在本 issue 的现场链路上。要迁的话是独立重构，不塞进这个 fix。

### 3. `card-progress.ts` —— 进度帧退出 429 重试 + 尊重冷却窗口

`isRetryableRegistryEditError`（`:407-418`）目前把 429 列为可重试，`editTemplateCardWithRetry`（`:435-448`）用 `REGISTRY_EDIT_RETRY_DELAYS_MS = [100, 250]` 重试 —— 两个问题：100/250ms 远低于服务端给的 `retry_after: 1s`，等于无视服务端节奏空转；加上 `postJson` 的 3 次尝试后还会叠乘。

改动**三处**：

1. 从 `isRetryableRegistryEditError` 的可重试集合去掉 429（网络失败与 5xx 不变）。
2. flush 路径（占位卡首帧 send + `transient: true` 编辑）给 `postJson` 传 `retryOn429: false`。
3. **新增按 `apiUrl` 的 429 冷却门 `rateLimitedUntil`**（见下）。

为什么不是"交给 postJson 退避"：进度帧是**允许丢弃的瞬时中间帧**，在 flush 路径里睡 1~3s 会占着 `entry.inFlight` 单飞位、把后续帧一起拖住，代价大于收益。另外这也保住了测试套件已有的契约 —— `card-progress.test.ts:879-918` 与 `:2659-2681` 编码的正是"429 → 下一个事件重试成功"这个语义。finalize / 终态帧 / 最终卡都不传 `transient`（`:706-768,775-784,876-951`），仍走默认的 postJson 退避。

**冷却门（必须有，否则只消掉了叠乘、没消掉反复撞）。** 光让 transient 帧不重试是不够的：只要事件持续到来，`dirty` 就持续为真，flush 会每约 800ms（`FLUSH_DEBOUNCE_MS`）发一个新 edit —— 正好在服务端刚给出的 `Retry-After` 窗口里反复撞 429。

做法：进程内维护 `rateLimitedUntil: Map<normalizedApiUrl, number>`。transient flush 前先看这张表，未到期就**跳过本次发送但保留 `dirty`**，到期后只发最新一帧（天然合并了中间帧）。收到 429 时按 `OctoApiError.retryAfterMs` 写入到期时间。**finalize / 终态帧绕过此门** —— 终态必须落地。

三条实现细则，缺一个就会出问题：

1. **key 规范化。** 用 `apiUrl.replace(/\/+$/, "")` 统一去尾斜杠后作 key（与 `postJson` 拼 URL 时的处理一致，`api-fetch.ts:82`）。同一后端写成 `https://x.test` 和 `https://x.test/` 必须落进同一个桶，否则冷却门形同虚设。
2. **单调更新。** 写入用 `max(已有到期时间, now + retryAfterMs)`，不能直接覆盖。并发的两个 429 若后到的那个 `retry_after` 更小，直接覆盖会把已有冷却**缩短** —— 又变成提前重试。
3. **到期唤醒要明确，且唤醒定时器本身要防两种竞态。** flush 在冷却期内直接 `return` 会导致"没有新事件就永远不醒"，而靠 800ms 去抖反复进来又是空轮询。做法：跳过时给该 entry 排**一次**精确到到期时刻的定时器（已排过就不重排）。定时器回调必须做三件事：
   - **先清掉自己的句柄**，再往下走（否则"已排过"永远成立，后续不会再排）。
   - **重读共享 deadline**，不用排它时捕获的那个值。窗口被后续 429 延长（单调更新）后，旧定时器会在旧到期点提前醒 —— 此时仍在冷却，应当**只把自己重排到新的截止时间**，不发送。
   - **校验 entry 仍然有效**（复用现有的 `isCurrentEntry(sessionKey, entry)`，`:620,628,636` 已是这个模式），避免一个陈旧定时器给已被替换的 entry 触发 flush。

   另外 entry 被 **replacement / finalize / clear** 时必须取消这个定时器，与现有 `entry.flushAbort` 的清理放在一处（`:649`），不留悬挂。

按 `apiUrl` 而不是按 entry：服务端桶是 per-IP 的，同一 `apiUrl` 下所有 session / bot 撞的是同一个桶，按 entry 分别计时等于每个 session 各自去踩一遍。

**冷却门自己要有上限（`MAX_CARD_COOLDOWN_MS = 5 分钟`）。** 解析层刻意保留服务端原值，但冷却门是它唯一的消费方，而影响面是"该后端下整个进程所有 session 的进度帧"。一个 `Retry-After: 86400`（或代理乱填）会让卡片静默停摆一整天 —— 进度帧本来就是可丢弃的，偶尔早回去一次的代价远小于此。超限时 warn 记录服务端原值。

**唤醒要错峰。** 窗口按 `apiUrl` 共享而唤醒按 entry，同后端的多个 session 会在同一刻醒来，正好把一批请求同时怼给刚刚才恢复的桶。到期时刻上叠 0~500ms 的随机错峰把这一下摊开。

**这不是我们在"非目标"里否掉的自限流。** 自限流是插件**猜**服务端还剩多少额度；冷却门只是**遵守服务端明确告知的最早重试时间**，输入完全来自响应本身。

**被限流的帧是暂缓，不是丢弃。** 429 不会置 `entry.skip`（fail-closed 条件显式排除了 429），所以不会永久禁用本 session。但 `dirty` 在发送前已被清，若不额外处理，真正撞上限流的这一帧会成为唯一没人重试的一帧 —— 卡片停在旧状态，直到下一个事件恰好到来。所以 429 的 catch 里重新置 `dirty` 并排唤醒，规则统一：**被限流的帧总会在窗口结束时带着最新状态发出**，即使之后再没有任何新事件。

### 4. `src/heartbeat.ts`（新文件）—— 心跳与 WS 解耦

把 `channel.ts:1405-1434` 的内联心跳搬成独立模块，注入依赖以便单测：

```ts
createHeartbeatLoop({
  intervalMs, accountId, log,
  send: (signal: AbortSignal) => Promise<void>,
  isConnected: () => boolean,
}): { start(): void; stop(): void }
```

| 情况 | 现在 | 改后 |
|---|---|---|
| 429 | `failures++`，达 3 次拆 WS | 记 warn（含 scope / remaining），**不计入失败**，不动 WS |
| 其他错误 | 同上 | `failures++`，达阈值记 error，**不动 WS** |
| WS 未连接 | 定时器已被 `onDisconnected` 清掉 | 定时器照跑，**跳过本次 POST**（"我在线"在 WS 断开时不该上报） |

另外三条 `setInterval` 异步任务的必备防护（现在都缺）：

- **单飞**：上一拍还在飞就跳过这一拍，否则慢请求会在 30s 间隔上堆叠。
- **每拍超时**：`AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS = 10_000)` 传给 `sendHeartbeat`。现在 `channel.ts:1413` 不传 signal，而 `fetch` 无默认超时，一个挂住的连接能永久占着单飞位。
- **`stop()` abort 在途请求**，避免账号停掉后仍有请求落地。

**不写 `setStatus({ lastError })`，心跳错误只打日志。** 说明理由要准确：`lastError` **不是** WebSocket 专用字段，而是账号级通用错误字段（`channel.ts:1282` 注册失败也写它，OpenClaw 的 `channels status` 会展示它）。选择不写有两个原因：一是**这就是今天的行为** —— 现有心跳失败路径（`:1418-1432`）只 log + 重连，从不写 `lastError`，所以不写等于零回归；二是心跳既已与连接健康解耦，往同一个字段里写会覆盖 WS / 注册的真实错误，而恢复时清与不清都不对（清了可能抹掉别人的真错误，不清则长期挂着旧错）。

**代价要写明**：`channels status` 因此看不到心跳故障，心跳可观测性只在日志里。本次接受这个取舍 —— 心跳既然无人消费，它的故障本身不代表账号不可用；真要对外暴露，应该是独立字段或指标，不是挤占 `lastError`。

生命周期改为**跟随账号**：账号启动时 `start()`，`cleanup()` 时 `stop()`。删掉 `onConnected` 里的 `startHeartbeat()`（`:1614`）、`onDisconnected` 里的 `clearInterval`（`:1619`）、失败路径里的 clear（`:1424`）。缺陷 3 从结构上消失。

### 5. `src/connection-watchdog.ts`（新文件）—— 兵底监督者

```ts
createConnectionWatchdog({
  intervalMs: 60_000, accountId, log,
  shouldReconnect: () => boolean,
  reconnect: () => void,
}): { start(): void; stop(): void }
```

每 60s（±25% 抖动）问一次 `shouldReconnect()`，为真则 warn + `reconnect()`。

`WKSocket` 为此暴露两个只读访问器（`connected` 现为 private，`socket.ts:257`）：`isConnectingOrConnected()`（读 `this.ws?.readyState`，覆盖 CONNECTING 与 OPEN）与 `hasPendingReconnect()`（读 `this.reconnectTimer !== null`）。

**`shouldReconnect` 的谓词必须涵盖所有"已有人在管重连"的状态**，否则重演 `#139` 的双连接互踢。由 `channel.ts` 提供闭包：

```ts
() => !stopped
   && !reconnectInFlight                  // 有重连序列正在执行中（见下）
   && !socket.isConnectingOrConnected()   // WS readyState CONNECTING / OPEN —— 正在连就别插手
   && !socket.hasPendingReconnect()       // socket 自己的指数退避已排队
   && !isRefreshingToken                  // token 刷新中（stagger sleep 也在窗口内，:1633-1660）
   && cooldownReconnectTimer === null     // cooldown 重连已排队（:1673）
```

`reconnectInFlight` 是**必需的**，光靠上面其余四项不够。反例在 `channel.ts:1673-1680`：cooldown 回调**先**把 `cooldownReconnectTimer` 置 null，再 `await socket.disconnectAndWait()`；而 `disconnectAndWait()`（`socket.ts:308-320`）会把 `this.ws` 置 null、`needReconnect` 置 false、清掉重连定时器。于是在那个 `await` 期间，`cooldownReconnectTimer === null`、`isConnectingOrConnected() === false`、`hasPendingReconnect() === false`、`isRefreshingToken === false` —— 四项全部放行，watchdog 会并发调 `connect()`，正好造出双连接。**这个"重连序列执行中"的状态今天在代码里没有任何表示**，必须新增。

实现是一个账号级布尔加一个包装器，不是状态机重构：

```ts
let reconnectInFlight = false;
const runReconnectSequence = async (label: string, fn: () => Promise<void>) => {
  if (reconnectInFlight) return;          // 已有人在管
  reconnectInFlight = true;
  try { await fn(); } finally { reconnectInFlight = false; }
};
```

三条重连路径全部包进去：token 刷新（`:1633-1661`）、cooldown（`:1673-1680`）、watchdog 自己的 `reconnect()`。

**每条序列内部的动作顺序也要统一**：`await socket.disconnectAndWait()` → `socket.stopReconnectTimer()` → `socket.connect()`。现有 cooldown 路径已经这么做（`:1676-1678`），watchdog 的序列必须照抄 —— 否则 watchdog 占住 `reconnectInFlight` 期间，socket 自己的退避定时器仍可能到点再进一次 `doConnect()`，虽然有 stale-guard 兜底不至于产生双连接，但会白白累加 `rapidDisconnectCount`。

**每个 `await` 之后重新检查 `stopped`。** 现有 cooldown 回调在 `await disconnectAndWait()` **之前**检查 `stopped`（`:1675`），之后直接 `socket.connect()` —— 账号在 await 期间被停掉就会给一个已停账号建连接。token 刷新路径同理（`:1654` 检查了 stagger 后的 stopped，但 `registerBot` 之后、`updateCredentials` 之前没查）。

### 6. 三个前置 bug 修复（不修则本设计失效）

1. **`socket.ts:441-445` 的 setTimeout 回调从不把 `reconnectTimer` 置回 null。** 于是"有待执行重连"在第一次重连之后永久为真，watchdog 被永久哑掉。回调进入时先 `this.reconnectTimer = null` 再判断 `needReconnect`。全文只有 4 处引用该字段（`:259,441,449-451`），`stopReconnectTimer()` 有非空守卫，置 null 安全。

2. **建连全程没有超时。** `onConnack`（`socket.ts:620-645`）里 `connected = true` / `restartHeart()` / `startStableTimer()` 全都只在 CONNACK 到达后发生。有**两个**都会永久挂住的窗口：
   - `readyState = CONNECTING`：TCP / HTTP Upgrade 永不完成 —— 没有任何超时。
   - `readyState = OPEN` 但 CONNACK 永不到达：`connected` 停在 false、没有 heart 定时器（ping 超时救不了）、没有 close 事件（`scheduleReconnect` 不触发）。

   两个窗口里 `isConnectingOrConnected()` 都为真，watchdog 会**恰好拒绝救这两种**，等于把潜在挂死变成必然挂死。

   修法放在正确的层（socket 自己管建连），且用**一个**覆盖全程的定时器而不是两个：在 **`doConnect()` 里**（不是在 `open` 回调里）起 `connectTimer = setTimeout(…, CONNECT_DEADLINE_MS = 15_000)`，涵盖 CONNECTING → OPEN → CONNACK 整段。
   - **定时器回调必须绑定创建它的 ws 实例**，并像其它 handler 一样加 stale-guard（`if (this.ws !== ws) return`，参照 `:356,378,392,426`），否则一个陈旧回调会去关掉一条新建立的连接。
   - 超时则 warn + `ws.close()`，交给现有 close handler 走 `scheduleReconnect`（此时 `needReconnect` 仍为 true）。
   - **清除点要列全**：`onConnack` 的**所有** reasonCode 分支（`:632,646,653`）、ws `close` handler（`:388`）、`doConnect()` 开头替换旧 socket 处（`:345-348`）、`disconnect()`（`:294`）、`disconnectAndWait()`（`:309`）、以及协议级 `onDisconnect()`（`:714-725`，它会把 `this.ws` 置 null，虽然 stale-guard 已能兜住，但不该留一个悬挂 15s 的定时器）。

   修完之后 `isConnectingOrConnected()` 才是安全谓词。


3. **`channel.ts:1656` 的 catch 静默结束。** `registerBot` 失败后显式排一次带退避的重连（包在 `runReconnectSequence` 里）。

三层并存是刻意的 defense-in-depth：握手超时让 socket 自愈（~15s）、局部 catch 修复让已知路径快速恢复（秒级）、监督者保证任何遗漏路径最迟 ~60s 内被拉回来。

**关于"要不要做一个账号级重连协调器"**：不做完整状态机。上面的 `reconnectInFlight` + 谓词 + `await` 后复查 `stopped` 已覆盖同一组状态，改动面小、可测、风险低；完整协调器会重写 `channel.ts` 的整段连接管理，留作后续独立重构。这一条列入"开放问题"请 caster 拍。

### 7. 数据流

```
fetch 429
  └─ postJson: 解析 Retry-After/scope/remaining → warn
       ├─ retryOn429=true  → 退避重试 ≤2 次（delay >= Retry-After，只向上抖；
       │                      退避等待累计 ≤ MAX_429_BACKOFF_WAIT_MS；
       │                      Retry-After > 10s 则直接放弃而非缩短；
       │                      每次尝试另有重建的 DEFAULT_TIMEOUT_MS fetch deadline）
       │    ├─ 成功 → 调用方无感
       │    └─ 耗尽 / 放弃 → throw OctoApiError(429, retryAfterMs, scope, remaining)
       └─ retryOn429=false → 立刻 throw（heartbeat / typing / readReceipt / card flush 帧）
            ├─ heartbeat.ts: isRateLimited → warn，不计失败，不动 WS，不写 lastError
            ├─ card-progress flush 帧: 丢帧 + 按 apiUrl 记 rateLimitedUntil；
            │    冷却窗口内的 transient 帧全部跳过但保留 dirty，到期只发最新一帧；
            │    finalize / 终态帧绕过冷却门，走默认退避
            └─ 发送路径: 冒泡给现有错误处理（用户可见提示不变）

WS 断开（任何原因）
  ├─ 建连卡住（CONNECTING 不 open，或 OPEN 无 CONNACK）→ CONNECT_DEADLINE_MS 到点 close → 走下面的重连
  ├─ socket 自身指数退避重连（reconnectTimer，回调进入即置 null）
  ├─ onError token 刷新路径 / cooldown 路径 / watchdog —— 都包在 runReconnectSequence 里
  │    统一顺序 disconnectAndWait → stopReconnectTimer → connect，每个 await 后复查 stopped
  │    registerBot 失败 → 显式排一次退避重连（而非静默结束）
  └─ watchdog 每 60s 复查 shouldReconnect() → 拉起
```

## 测试策略

**`src/api-error.test.ts`**
- `Retry-After` 头优先于 body `retry_after`；两者皆缺 → 默认 1000ms
- **畸大但合法的值原样换算保留、不截断**（`Retry-After: 300` → `300_000`）；只有非法值（非数字 / 负数 / HTTP-date 格式）才回落默认 1000ms。`MAX_RETRY_AFTER_MS` 的截止判断**只在 `api-fetch` 的重试决策里测**，解析层不涉及。
- `scope` / `remaining` 正确带出；`isRateLimited` 只对 429 为真
- **message 仍匹配 `API_FETCH_STATUS_RE`**（兼容锁）
- `httpStatusFromApiFetchError` 对 `OctoApiError` 走 `.status`，对旧式 `Error` 走正则

**`src/api-fetch.test.ts`（扩充，假时钟）**
- 429 → 按 `retryAfterMs` 退避后重试，第二次成功即返回
- 连续 429 耗尽 → 抛 `OctoApiError`，字段齐全
- 500 / 400 → 立刻抛，不重试（守住"只重试 429"边界）
- `retryOn429: false` → 立刻抛，不睡
- 抖动只向上：`delay >= retryAfterMs` 恒成立（100 次采样断言下界），且 `<= retryAfterMs * 1.25`
- `retryAfterMs > MAX_RETRY_AFTER_MS` → 直接抛，**不重试、也不把等待缩短**
- **畸大值在解析层不被截断**：`Retry-After: 30` → `retryAfterMs === 30_000`（锁住 §1 的"解析层不 clamp"）
- 非法值（非数字 / 负数 / HTTP-date）→ 回落默认 1000ms
- 退避等待累计超 `MAX_429_BACKOFF_WAIT_MS` 时提前放弃
- 退避中 `signal` abort → 立刻抛，且 `cause` 是原 `OctoApiError`
- 进入时 signal 已 aborted → 不发请求
- **调用方未传 signal 时，fetch 仍带 `DEFAULT_TIMEOUT_MS` 的内部 deadline**（挂住的 fetch 会被中断）
- **调用方传了 signal 时，不叠默认 30s deadline** —— 用 `fetchBotEvents` 的 long-poll 场景锁死：`waitSeconds = 30` 时 40s 的超时不得被砍到 30s；但仍与 `POST_HARD_CEILING_MS`（60s）求交，锁死"裸 controller signal 也不会无界"这条不变量
- **deadline 每次尝试重建**：第 1 次尝试耗掉大部分 deadline 后，第 2 次尝试仍有完整预算
- 响应对象缺 `headers` 时不抛 `TypeError`，退回默认 `retryAfterMs`

**`src/heartbeat.test.ts`**
- 429 不增加失败计数、不触发任何 WS 操作、不写 status
- 非 429 连败达阈值 → 只打日志，仍不触发 WS 操作
- 一次成功后失败计数归零
- `isConnected() === false` → 跳过 POST（sender 未被调用）
- **单飞**：慢请求跨越多个 interval 时不并发第二拍
- **超时**：请求超过 `HEARTBEAT_TIMEOUT_MS` 被 abort，且不永久占住单飞位
- `stop()` abort 在途请求，且之后不再触发

**`src/connection-watchdog.test.ts`**
- `shouldReconnect()` 为真 → 调用 `reconnect()`；为假 → 不动
- `stop()` 后不再检查；重复 tick 不重复拉起（配合谓词）

**`src/reconnect-fixes.test.ts`（改造 + 补真实竞态）**

现有这几组都用局部变量自证、**不会自动 fail**，但明文记录了被本设计废弃的契约，必须改写而不是留着：
- `:288-334` "断开清心跳" / "连接重启心跳" → 改为心跳生命周期跟随账号
- `:383-406` "心跳失败后延迟重连" + 抖动 → 该契约整体消失（心跳不再触发重连），删除或改写为 watchdog 的退避
- `:410-432` "连接成功重置心跳失败计数" → 计数语义改为只统计非 429、且不再驱动重连

补真实 `WKSocket` 集成用例：
- `reconnectTimer` 触发后 `hasPendingReconnect()` 由 true 变 false（锁住前置修复 1）
- CONNECTING 期间 `isConnectingOrConnected()` 为真；**卡在 CONNECTING**（WS 永不 open）时 `CONNECT_DEADLINE_MS` 到点后 socket 自行 close 并进入重连
- **OPEN 但未 CONNACK** 时同样到点自愈（两个窗口都锁住，前置修复 2）
- `connectTimer` 的 stale-guard：旧 ws 的定时器到点时不得关闭新建的 ws
- 清除点覆盖：`onConnack` 三个 reasonCode 分支、close、`doConnect` 替换、`disconnect`、`disconnectAndWait`、协议级 `onDisconnect` —— 各自之后都不应残留定时器
- 谓词矩阵：refresh 进行中 / cooldown 已排队 / **cooldown 回调 await 执行中** / socket 定时器已排队 / 正在连接 / 已连接 / stop 竞态 —— 各自都不应触发 watchdog 重连
- **watchdog 占住 `reconnectInFlight` 期间 socket 退避定时器同时到点** → 不产生第二条连接、`rapidDisconnectCount` 不累加
- `await` 后 `stopped` 变真 → 不再 `connect()`

**`src/card-progress.test.ts`（扩充 + 必改）**
- ⚠️ **`:879-918` 与 `:2659-2681` 会真的挂**：两处 mock 的失败响应都是 `{ok:false, status, …}` 形状、**没有 `headers`**；postJson 读 `Retry-After` 会 `TypeError`。两件事都要做：`OctoApiError.from()` 容错读头（见 §2），以及给这些 mock 补 `headers`。
- ⚠️ `:879-918` 的 `it.each([429, 503])` 断言 `/sendMessage` 恰好 2 次 —— 429 与 503 的路径在本设计下已分岔（429 不重试且受冷却门约束、503 仍按原策略重试），必须按新语义拆开重写，不能沿用同一个 each。
- 新增：transient 帧遇 429 → 只发一次、`entry.skip` 保持 false
- 新增：429 后**没有新事件** → 窗口到期时仍把那一帧发出去（锁住 §3 的"暂缓不丢弃"）
- 新增：429 后**有新事件** → 窗口内一律不发，到期只发最新一帧（中间帧被合并）
- 新增：**冷却门** —— 429 之后在 `rateLimitedUntil` 窗口内持续产生新事件，期间**不再发出任何 transient edit**；窗口到期后只发**最新一帧**（中间帧被合并掉）
- 新增：**冷却门按 `apiUrl` 共享** —— 同 `apiUrl` 的另一个 session 在窗口内同样被拦；`https://x.test` 与 `https://x.test/` 落进同一个桶
- 新增：**单调更新** —— 窗口内又来一个 `retry_after` 更小的 429，已有到期时间**不被缩短**
- 新增：**到期唤醒** —— 冷却期内跳过后，即使**之后没有任何新事件**，到期时仍会把最后那一帧发出去（且只发一帧、不空轮询）
- 新增：**窗口延长时旧定时器不提前发** —— 排了到 T1 的定时器后又来一个把 deadline 推到 T2 的 429，T1 醒来时不发送、只重排到 T2
- 新增：**陈旧定时器不打扰新 entry** —— entry 被替换 / finalize / clear 后，其冷却定时器被取消，不会给新 entry 触发 flush
- 新增：**finalize / 终态帧绕过冷却门**，即使在窗口内也照发
- 新增：网络失败 / 5xx 仍按原策略重试（不回归）
- 新增：非 transient（finalize / 最终卡）遇 429 → 走 postJson 退避后成功

**`src/events-poll.test.ts`（扩充）**
- `/v1/bot/events` 遇 429 时 postJson **不睡不重试**，poller 走自己的错误指数退避
- long poll 场景下 429 不会把 `requestMs` 推过 `waitSeconds × HELD_FRACTION` 阈值、不会导致 0ms 立即重 poll
- `waitSeconds = 30` 时请求超时仍是 40s（内部 deadline 不得把它砍到 30s）

**回归**：`npm run type-check` + 全量 `npm test` + `npm run pack:check`

## 自限流：不做猜测式的，做遵守式的

要区分两件常被混为一谈的事：

**不做 —— 猜测式自限流**（固定速率的进程内令牌桶）。服务端桶是跨进程、跨客户端的 per-IP 共享桶，插件推不出正确额度；单 bot 自律也挡不住同 IP 其他流量把桶抽干；还会在服务端其实很闲时无谓降吞吐。

**做 —— 遵守式冷却门**（§3 的 `rateLimitedUntil`）。它的输入完全来自服务端响应里明确给出的 `Retry-After`，不含任何猜测，只是保证我们不在服务端说"1 秒后再来"的窗口里反复撞。这是本 issue 的核心诉求，不是额外的自我限速。

再评估猜测式方案的触发条件：等 §2 的 `scope` / `remaining` 日志在生产落地，若证据显示**同进程多 bot 是主要突发来源**，再考虑按 `apiUrl` 共享的轻量并发闸（带优先级：心跳与用户可见发送优先于进度帧）。

## 兼容性

- 无配置项变更，无 manifest / schema 变更；`heartbeatIntervalMs` 语义不变（默认 30s，`accounts.ts:33`）。
- `postJson` 新增第 6 个可选参数。已核实全部 13 个调用点（`api-fetch.ts:163,308,378,460,548,616,645,779,799,816,831,843,871`）均只传 5 个位置参数，测试文件无直接调用 —— 加第 6 个可选参数不冲突。
- `OctoApiError.message` 保持既有格式，`httpStatusFromApiFetchError` 双路径兼容（见 §1）。
- **行为变化 1**：`postJson` 从"调用方不传 signal 就无超时"变成"总有 `DEFAULT_TIMEOUT_MS` 内部 deadline"。这是修 bug，但确实是行为变化 —— 极慢的合法请求会被 30s 截断。
- **行为变化 2**：card-progress 的 429 不再本地重试、transient 帧也不在 flush 里退避，改为按 `apiUrl` 记冷却窗口、窗口内暂缓、到期发最新一帧（上限 5 分钟）。`channels status` 也看不到心跳故障（见 §4 的代价说明）。
- **行为变化 3**：心跳失败不再触发重连。这条契约在 `reconnect-fixes.test.ts:383-432` 有明文测试，需一并改写。

## 开放问题（需 caster 拍板）

1. **生产入口是否另有未纳入 `octo-deployment` 的 CLB / WAF / Ingress 限流规则？** 若有，"429 唯一来源是 per-IP 桶"的结论要放宽 —— 但不影响本设计的任何一条改动（插件侧的应对与 429 由谁发出无关）。
2. **是否接受"不做完整账号级重连协调器，只补最小的 `reconnectInFlight` + 建连 deadline"？** 取舍是：不重写 `channel.ts` 的整段连接管理，但补齐两个今天在代码里完全没有表示的状态 —— "重连序列正在执行中"与"建连未完成"。这两个状态缺失正是 watchdog 谓词失效和 socket 挂死的根源。完整协调器（把 socket 重连 / cooldown / token 刷新 / watchdog 收敛成一台状态机）留作后续独立重构。


## 未解的观测缺口

per-IP 桶是 500 rps / burst 1000，而心跳 30s 一次，连败 3 次意味着该出网 IP 在约 60 秒内几乎一直被抽干（≈ 持续 500 rps）。单 bot 量级远达不到：typing 5s 一次（`inbound.ts:2715`）、卡片 flush 去抖 800ms（`card-progress.ts:159`）、card action poller 仅在卡片交互场景懒启动（间隔 2s），峰值也就几 rps。

真正打满桶的是谁，光看代码定不了 —— 可能是那台主机上并发跑的 bot / 客户端共用一个出网 IP，也可能 prod 实际 rps 配置低于 kustomize base 的 500（`octo-deployment/kustomize/base/octo-server-env-config.yaml:10-11`），也可能是仓库外的入口规则。§2 把 `scope` / `remaining` 打进日志正是为了让下一次复现能直接回答。**这是本次改动的观测产出，不是它要解决的问题。**
