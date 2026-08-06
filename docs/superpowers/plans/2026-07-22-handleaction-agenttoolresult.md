# Plan: handleAction 统一返回 AgentToolResult(#171)

## 背景 / 问题

`message` 工具发送**成功后**,工具卡片报 `Cannot read properties of undefined (reading 'reduce')`。与 DM 400(#170)是两个独立问题:不同层、不同根因、不同修复点。

环境:Octo 插件 `1.1.1`,现场 OpenClaw host `2026.7.1-2`,runtime = **Codex app-server**。

> **版本核验说明**:下述根因链是对本地 `node_modules/openclaw` 实际安装版本 **`2026.6.9`** 的 dist 逐行核对得出。`AgentToolResult` 契约与 `convertToolContents` 无守卫 reduce 的机制在这两个版本间保持一致的可能性很高,但**未在 `2026.7.1-2` 的构建产物上同版本核验**;最终端到端确认需在现场 host 版本 + Codex runtime 上做。

## 根因(已对 host `2026.6.9` 源码坐实)

Octo 的 `handleAction`(`src/channel.ts`)最终返回 `handleOctoMessageAction(...)` 产生的业务 JSON `MessageActionResult = { ok, data?, error? }`,**没有 `content` 字段**。

host core 消费链路(已核对本地 `node_modules/openclaw/dist`):

```
message 工具
  → dispatchChannelMessageAction → plugin.actions.handleAction(ctx)   // 直接透传插件返回,不补 content
  → message-action-runner: toolResult = handled(插件原样返回)
  → provider-capabilities: convertToolContents(result.content, ...)   // 直接取 result.content
  → convertToolContents: content.reduce(...)                          // 无 Array.isArray 守卫
  → result.content === undefined → undefined.reduce → 抛错
```

- 抛错点 `convertToolContents` 位于 **Codex dynamic tool-result** 路径(`DEFAULT_CODEX_DYNAMIC_TOOL_RESULT_MAX_CHARS`),故 Codex runtime 命中;非 Codex runtime 走不同 tool-result 转换路径,未必命中(未做对比测试,不下"非 Codex 一定安全"结论)。
- 插件自身的 `.reduce()` 调用点都有守卫;抛错的 `.reduce` 在 **host core 对插件不完整返回**上执行,与该机制一致。

### host 错误分类依据(决定 wrapper 形状)

核对 `isToolResultError` / `isCodexToolResultError`(host dist):二者都读 `result.details`——

- `details.ok === false` 或 `details.error` 存在 → 判为 error;
- `details.ok === true` → 判为 success;

因此只要把原始 `MessageActionResult` 原样放进 `details`,host 的成功/错误分类就自动正确,无需额外标记。`extractToolPayload` 也优先读 `result.details`,下游投递证据/日志取原始 payload 不受影响。

`AgentToolResult` 契约(host `types` d.ts):`content: (TextContent|ImageContent)[]` 必填、`details: T` 必填。`TextContent = { type:"text", text:string }`。

## 修复方案

**单一边界收口 + 只包正常 return**:在 `src/channel.ts` 的 `handleAction` 处,把两个**正常返回出口**(config-error + 委托结果)包成 AgentToolResult。**不加 try/catch**——见下方「为何不兜异常」。

新增 helper(channel.ts,导出以便单测):

```ts
export function toActionToolResult(payload: MessageActionResult): {
  content: { type: "text"; text: string }[];
  details: MessageActionResult;
} {
  // 紧凑 JSON:read/search/group-md 等大 payload(可含最多 ~50 条历史/成员列表/GROUP.md 全文)
  // 下,美化缩进会额外撑大 ~30% 体积、更早触发 Codex 动态 tool-result 的 16000 字符截断,
  // 且模型无需缩进即可解析。故不用 JSON.stringify(payload, null, 2)。
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: payload,
  };
}
```

`handleAction` 改为(仅示意改动点,accountId 解析等不变):

```ts
handleAction: async (ctx: any) => {
  // …(accountId 解析逻辑完全不变)…
  if (!account.config.botToken) {
    return toActionToolResult({ ok: false, error: "Octo botToken is not configured" });
  }
  // …(memberMap / uidToNameMap / groupMdCache 取值不变)…
  const result = await handleOctoMessageAction({ /* 参数不变 */ });
  return toActionToolResult(result);
},
```

覆盖:① config-error 分支;② 委托结果(含各 sub-handler 自身的成功/错误 return)。两类**返回值**全部为合法 AgentToolResult。

### 为何不兜异常(不加 try/catch)

核对 host `provider-capabilities-*.js`:工具执行整体被 host 的 `try/catch` 包裹。`handleAction` **抛异常**时,host 的 catch 会:

- `failedToolResult(errorMessage)` 生成 `contentItems:[{type:"inputText", text: errorMessage}]`(合法数组)+ `success:false` + `"error"` 终态;
- 触发 after-tool-call hook(带 `error`)、按 `didStartExecution`/`isReplaySafeToolCall` 计算 replay-safe 与 side-effect evidence。

即:**reduce 抛错只发生在返回值路径**(host 对 `result.content` 无守卫 reduce),**异常路径根本不命中**——异常由 host 干净处理成合法失败结果。若在 `handleAction` 自己 try/catch 把异常降级成普通 `{ok:false,error}` return:host 仍会对这个返回结果跑成功/失败分类与 side-effect 判定,但会**改变异常 hook 语义**(after-tool-call hook 的 error 路径不再触发),并**绕过 message 工具对失败自动幂等键的保留逻辑**(host 在 catch 分支保留 failed idempotency key 后再 rethrow;吞成 return 会让该路径失效)。故异常继续上抛交 host,不在插件层兜。

### 不改动的点

- Bot API 请求本身不变 → 与 #170 DM 400 修复正交,互不替代。
- `MessageActionResult` 类型不变(仍 `{ok,data?,error?}`),作为 `details` 载荷。
- accountId 纠正逻辑、参数透传保持原样。

### 设计权衡

- **为何在 channel.ts 收口而非 actions.ts 逐个 return 包装**:actions.ts 的 `handleOctoMessageAction` 及各 sub-handler 有 20+ return 点,逐个包装侵入大、易漏、且污染 `MessageActionResult` 契约(它是插件内部业务类型,不应背 host 的 AgentToolResult 形状)。channel.ts 的 `handleAction` 是插件↔host 的唯一 action 边界,收口最小且天然全覆盖(所有 return 值都从这两个出口出去)。
- **异常不在插件层兜**:见上「为何不兜异常」——host 已干净处理异常,自己 try/catch 反而改变失败语义。

## 回归测试(新建 src/handleaction-tool-result.test.ts,复用 multi-bot-isolation.test.ts 的 mock 范式)

TDD:先写断言(RED)→ 实现 → GREEN。复用 `vi.mock("./actions.js" / "./group-md.js" / "./api-fetch.js")` + `octoPlugin.actions.handleAction(ctx)` 免网络调用。以下**全部为必测项**:

1. **helper 单测** `toActionToolResult`:任意 `{ok:true,data}` / `{ok:false,error}` → `content` 为**数组**、每项 `{type:"text", text:string}`;`details` === 原 payload(保留 ok/data/error)。并模拟 host 无守卫聚合 `result.content.reduce((n,i)=>n+(i.type==="text"?i.text.length:0),0)` **不抛**。
2. **handleAction 成功分支**:mock `handleOctoMessageAction` 返回 `{ok:true,data:{messageId:"x"}}` → 返回 `content` 数组 + `details.ok===true` + `details.data` 保留。
3. **handleAction config-error 分支**:无 botToken 的 cfg → `content` 数组、`details.ok===false`、`details.error` 含 "botToken"。
4. **handleAction 未知 action 分支**:mock `handleOctoMessageAction` 返回 `{ok:false,error:"Unknown action: xxx"}` → 仍是合法 AgentToolResult、`details.ok===false`。
5. **错误分类回归**:对 wrapper 输出复刻 host `isToolResultError` 判定(读 `details.ok===false`/`details.error`)→ 错误 payload 判为 error、成功 payload(`details.ok===true`)判为 success,证明包装未把错误吞成成功、也没把成功误判失败。
6. **异常上抛(不吞)**:mock `handleOctoMessageAction` **throw** → 断言 `handleAction(ctx)` 的 promise **reject/抛出**(而非返回 `{ok:false}`),固化"异常交 host 处理"的契约,防止将来有人误加 try/catch。
7. **大 payload 紧凑序列化**:mock 返回带大 `data`(如 50 条历史)→ 断言 `content[0].text` 是紧凑 JSON(无 `\n  ` 缩进痕迹),避免回退到美化格式。

## 验证

- `npx vitest run`(全量)+ `npx tsc --noEmit` 干净。
- 本地 build → `npm pack` → `openclaw plugins install <tgz> --force` → 重启。
- 端到端只能在 **Codex runtime** 真实复现/证伪(明湖网关本地跑的是 claude 路径,`convertToolContents` 不命中);本地以**源码级 + 结构断言**为主,Codex 环境做最终确认(与 #171 已知约束一致)。

## DoD

- handleAction 两个**返回出口**(成功 / 配置错误 / 未知 action / sub-handler 各错误 return)均为合法 `AgentToolResult`(`content` 数组 + `details`);异常继续上抛交 host(不吞)。
- 新增回归测试覆盖上述 7 项(全必测),全绿;`tsc --noEmit` 干净。
- 无 provenance 痕迹(注释只留技术理由)。
- 单一职责 PR:只动 channel.ts 的 handleAction + helper + 对应测试;不碰 actions.ts 业务逻辑、不碰 #170 的 actions.ts 路由。

## Scope / 顺序

- 独立于 #170(不同文件 actions.ts vs channel.ts),基于最新 `origin/main` 开分支 `fix/octo-handleaction-agenttoolresult`。
- 走完整 Qflow:本 plan 过 codex 关 → 开发(TDD)→ cc-review ‖ codex-review 双审通过 → 本地包测试 → PR 合回 main。
