# 推理思考文案:区分四种状态

## 背景

进度卡的思考行现在把**四种完全不同的情况**显示成同一句 `Thinking through…`(或直接漏出宿主的英文诊断句),运维无法自查。

容器内实测(OpenClaw 2026.6.9,真实群会话 `b01fcd9b…`)拿到的证据:

| 现象 | 出处 |
|---|---|
| 真实思考文本 | 供应商返回的推理摘要/思维链 |
| `Native reasoning was produced; no summary text was returned.` | **OpenClaw core** 的占位句(`embedded-agent-utils-VZ4fvDJQ.js`),被我们原样渲染到群可见卡片 |
| `Thinking through…` | 本仓 `FALLBACK_THOUGHT` |

宿主的判定逻辑(`extractAssistantThinking`):

```js
if (record.type === "thinking" && typeof record.thinking === "string") {
  const thinking = record.thinking.trim();
  if (thinking) return thinking;                                    // 有文本
  if (record.thinkingSignature?.trim())
    return "Native reasoning was produced; no summary text was returned.";  // 签名有、文本空
}
return "";                                                          // 无 thinking block
```

同一个会话的 7 个 thinking block **全部带 `thinkingSignature`**,其中 3 个有文本(387 / 463 / 478 字符)、4 个文本长度为 0。

**这与模型无关,取决于返回内容的形状。** 换模型只改变各状态的出现频率:

- Anthropic extended thinking 返回**原始思维链**(非摘要),状态「有文本」是常态;`redacted_thinking` 落入「签名有、文本空」。
- OpenAI Responses 的 `summary` 被 OpenClaw 写死为 `"auto"`(`reasoningSummary` 在 dist 中只被读、从未被赋值),因此摘要只在宿主认为「有足够内容可总结」时出现。
- 把推理丢掉的路由(如 `gpt-5.6-sol` 配成 `openai-completions`)则完全没有 thinking block。

### 为什么现在更要修

`sanitizeReasoningThought` 用 `isSensitive(normalized, true)` —— 第二个参数开启通用高熵/长 hex 检测,**命中即整段抹掉并落到 `FALLBACK_THOUGHT`**。摘要通常干净,而 Anthropic 的原始思维链里出现路径、命令、token 形状字符串的概率高得多。所以迁到 Claude 系模型后,「被守卫抹掉」会从边角情况变成常态,而它和「压根没推理」在卡片上**完全同一句**——正是这次排查所遇到的困境。

## 目标

思考行让读者能区分:**有内容 / 有推理但拿不到内容 / 内容被我方脱敏拦下 / 压根没推理**。

## 非目标

- **不**放宽 `sanitizeReasoningThought` 的脱敏强度。群卡对全员可见,守卫命中即隐藏这条底线不动。
- **不**渲染宿主的诊断散文。用户面文案由本仓掌握。
- **不**改 `MAX_REASONING_CAPTURE` / `THOUGHT_MAX` 等既有上限。

## 设计

`FALLBACK_THOUGHT` 目前有**六个**触发点,语义各不相同,却共用一句文案:

| # | 触发点 | 真实含义 |
|---|---|---|
| 1 | `sanitizeReasoningThought`:`!text` | 有思考步骤,但没抓到任何推理文本 |
| 2 | 同上:命中 `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>` | 宿主内部上下文,刻意不展示 |
| 3 | 同上:URL 归约后为空 | 整段都是被降级掉的 URL |
| 4 | 同上:`isSensitive` 命中 | **被我方脱敏拦下** |
| 5 | `phasesFromSteps:272` | 工具步骤前面没有任何 `__thinking__` 步骤(结构性,非推理状态) |
| 6 | `phasesFromSteps:277` | 压根没有任何步骤 |

再加上「文本等于宿主占位句」这一路(它不走 `FALLBACK_THOUGHT`,而是被原样渲染),读者看到的东西无法反推出实际发生了什么。

思考行按状态取值:

| 状态 | 判定 | 显示 |
|---|---|---|
| 有内容 | 清洗后非空 | 原文(现状不变) |
| 有推理、无内容 | 文本等于宿主占位句(签名有、文本空) | `Reasoned without a visible summary` |
| 被守卫拦下 | 触发点 2 / 3 / 4 | `Reasoning hidden — matched a redaction rule` |
| 无推理内容 | 触发点 1 | 空串 → 不渲染思考行,只留耗时行 |
| 结构性无思考步骤 | 触发点 5 / 6 | 空串 → 不渲染思考行 |

「被守卫拦下」是唯一能让人自查的信号 —— 看到它就知道该去查脱敏规则,而不是怀疑模型或路由。它的措辞刻意指向**规则**而非内容:守卫是 fail-safe 的,命中不代表真有凭据(长 hex、git SHA、高熵串都会误伤),所以不能暗示被隐藏内容的性质。

### 改动点

1. **`src/reasoning-process.ts`** —— `sanitizeReasoningThought` 现在把触发点 1–4 都返回同一个 `FALLBACK_THOUGHT`,改为返回可区分的结果(枚举或带原因的结构),由调用方决定文案。`cachedThought` 缓存的是清洗结果,需跟着改。
2. **`src/reasoning-process.ts`** —— `phasesFromSteps` 在「不显示思考行」的状态下不再塞文案。注意两个既有约束:
   - `buildReasoningProcessWireData` 已经**过滤掉所有 `actions.length === 0` 的 phase**,所以触发点 6 那条兜底对 wire data 本就无效(它塞的 phase 没有 action,照样被滤掉、照样返回 null 推迟首帧)。改动不要误以为那条兜底在保证首帧。
   - 有 action 的 phase 必须保留,只是其思考行可能为空 —— 别把 phase 本身删掉。
3. **文案常量** —— A / B 两句进本仓常量,不散落。


### 已知脆弱点

识别「有推理、无内容」**只能靠匹配 OpenClaw 那句硬编码英文**。OpenClaw 升级改字即静默失效,退回今天的混淆状态,而我方测试用的是自己的常量、不会因此变红。

处理方式:常量处注释写明出处文件与验证过的 OpenClaw 版本(2026.6.9),并标注「升级 OpenClaw 后需复核」。**这个脆弱性无法在本仓消除。**

更稳的解法在上游:让 OpenClaw 在事件里带结构化标记(如 `reasoningRedacted: true`)而非一句英文散文。已记入给上游的反馈项。

## 验证

- 单测覆盖四种状态各自的输出,并逐条做**反向验证**(还原实现须使对应断言变红)。
- 容器内真实路径复验:同一个群会话能同时产出「有内容」与「有推理无内容」两种 phase,是天然的对照样本。
- 不依赖 E2E 作为唯一证据源 —— 伴生插件直接 import dist 并自行调用 `handleInboundMessage`,绕过整条真实入站链路。

## 实现结果

`FALLBACK_THOUGHT` 已删除 —— 六个触发点分流到三种去处(原文 / `redacted` / 空串),没有剩余用途。

`sanitizeReasoningThought` 保留为返回展示字符串的薄封装,分类逻辑在新的 `resolveReasoningThought`,返回 `{ kind, text }`。

实现中被测试纠正的一处错误假设:**「整段只是一个 URL」并不会落到 `redacted`**。可解析的 URL 被归约成注册域(`https://example.com`)后非空,分类是 `text`;只有**无法解析**的 URI(如 `ftp://:::/`)才会被整段抹除后归为 `redacted`。测试按实际行为断言了两者。
