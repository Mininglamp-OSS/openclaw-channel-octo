# 放行 App Bot token 绑定

## 背景

Octo 有两类 bot token,前缀不同,server 端鉴权与能力也不同:

| 前缀 | 类型 | 私聊 | 群聊写 | Thread | OBO |
|---|---|---|---|---|---|
| `bf_*` | User Bot(BotFather `/newbot`) | ✅ | ✅ | ✅ | ✅ |
| `app_*` | App Bot(Admin 后台「应用 Bot」) | ✅ | ❌ | ❌ | ❌ |

App Bot 的能力限制由 **server 强制**(`octo-server/modules/bot_api/`:`auth.go` 按前缀分流到不同鉴权路径,`send.go` / `threads.go` / `groups.go` 对 `BotKindApp` 显式拒绝群/thread/OBO 操作)。私聊(DM)对 App Bot 是放行的。

当前插件 CLI 在两处把 token 前缀硬校验成必须 `bf_`:

- `src/channel.ts:554`(交互式 wizard `finalize` 的 `validate`)
- `src/channel.ts:585`(非交互式 `octoSetupAdapter.validateInput`)

导致用户拿 Admin 后台 App Bot 的 `app_` token 走 `openclaw channels add` 时被 CLI 直接拒,报 `Bot token must start with 'bf_'` —— 用户连绑定都做不了,即使他只想要一个**私聊场景**的 Agent(App Bot 的私聊能力对此完全够用)。

## 目标

放行 `app_` token 通过 CLI 绑定。绑定成功后,这个 bot 的能力边界(私聊可用、群/thread 不可用)**完全由 server 决定**,插件不复制 server 的权限逻辑。

## 非目标

- **不**在插件侧感知 bot 类型、不为 App Bot 做群场景降级分支 —— 那是 server 的职责,在插件里抄一份权限判断会造成双写、易漂移。
- **不**改 server 解除 App Bot 的 DM-only 限制 —— 那是产品/安全决策,不在本次范围。
- **不**改 Admin 后台连接指南(包名过时、对 App Bot 误推 Agent 指南)—— 归 admin 侧,本次只解决「CLI 拒绝绑定」这一插件侧问题。

## 设计

把两处校验从「必须 `bf_`」放宽为「**`bf_` 或 `app_`,且长度 > 13**」,其余仍拒(挡掉空串、半截字符串、误粘的 API key 如 `uk_...` 等明显错误输入)。报错文案相应更新,并提示两种合法前缀及各自来源。

### 改动点

1. **`src/channel.ts:554-556`**(交互式 wizard `validate`)
   - 校验:`if (!(v.startsWith("bf_") || v.startsWith("app_")) || v.length <= 13)`
   - 文案:说明 `bf_`(BotFather `/newbot` 建的 User Bot,全功能)/ `app_`(Admin 后台 App Bot,仅私聊)两种均可。

2. **`src/channel.ts:585-587`**(非交互式 `validateInput`)
   - 校验:同上,前缀集合从 `{bf_}` 扩为 `{bf_, app_}`。
   - 文案:同步更新。

3. **文案点**(纯展示,去掉「只有 bf_」的暗示,改为前缀无关或并列):
   - `src/channel.ts:524` `"Octo: needs bot token (bf_*)"` → 去掉 `(bf_*)` 限定,如 `"Octo: needs bot token"`。
   - `src/channel.ts:548` `message: "Bot token (bf_*)"` → `"Bot token (bf_* or app_*)"`。
   - `src/channel.ts:549` `placeholder: "bf_..."` → 保持 `bf_...`(User Bot 是推荐的全功能形态,占位符给主路径即可)或 `bf_... / app_...`。占位符选择在实现时定,不影响校验。

### 不改

- `src/api-fetch.ts:928`、`src/thread-binding-adapter.ts:114` 的 `bf_...` 是说明性注释,描述 token 一般形态,非校验,保留。
- token 一律以 `Bearer <token>` 发给 server,鉴权与能力判断在 server,本次不动。

## 测试

`src/channel.test.ts`(或就近测试文件)新增/调整:

- `app_` 前缀且长度 > 13 的 token → `validateInput` 返回 `undefined`(放行)。
- `bf_` 前缀仍放行(回归保护)。
- 非法输入仍拒:空串、`app_`/`bf_` 但长度 ≤ 13、其他前缀(如 `uk_xxx`)、非字符串。
- 交互式 wizard 的 `validate` 同等覆盖(`app_` 放行、短串/错前缀拒)。

## 影响面 / 风险

- 用户若把 App Bot 拉进群并 @它,server 会返回 `app_bot_dm_only` 类错误;这是 server 既有行为,且是正确的能力反馈,不属于本次回归。插件如实透传 server 报错即可。
- 不引入 child_process、不新增依赖、不动发布链路。
