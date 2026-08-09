/* eslint-disable */
// @ts-nocheck
/**
 * **`def63bb` 的 `src/card-action-status.ts` 冻结快照。这个文件不是产品代码，永远不要改它。**
 *
 * 它存在的唯一理由:差分 runner(card-render.parity.test.ts)要能**执行** merge-base 的实现,
 * 而不是把 merge-base 的行为**手抄**成期望值。这条分支上，手抄的护栏已经失效过两次 ——
 * 第八轮的一次性脚本报「0 回归」而实际有 120 条，第九轮的 PARITY 语料组 8 行手写字面量而
 * 第十轮的四类回归全部通过。两次的成因相同:挑行的人有多少盲点，护栏就有多少盲点。
 * 基准可以被执行，这个性质才断掉。
 *
 * 来源:`git show def63bb:src/card-action-status.ts`。
 * 除本段头注释与 `@ts-nocheck` 外,与原文的差异**只有一行 import 说明符**(指向同目录的 card-render 快照，而不是仓库当前的实现)。落地时已用 809 个输入 × 5 个 sink 与真实 def63bb 工作树逐组比对，0 差异。
 *
 * `@ts-nocheck` 是给「将来有人把 exclude 去掉」留的:旧代码未必过得了今天的类型设置,
 * 而那时候的正确反应是恢复 exclude,不是去改这个快照。
 * 本文件不进 tsc(见 tsconfig.json 的 exclude):它是旧代码的快照，不该被今天的类型设置约束，
 * 也不该被编译进 dist 发出去。真的坏了 vitest 会在加载时直接报错。
 * 内容哈希钉在 card-render.parity.test.ts 里 —— 改动一个字节，那条断言就变红。
 */
import { reduceUrlsInText } from "./card-render.def63bb.js";

export type CardActionStatus = "processing" | "completed" | "error";

/**
 * Neutralize an untrusted string before it is echoed into a bot-authored card `TextBlock`.
 *
 * A `TextBlock` renders a markdown subset (links, emphasis, code), so a submitted input value —
 * or a user-set operator display name — could otherwise inject an active hyperlink that looks
 * bot-authored (an integrity / spoofing gap: a group member could make the bot echo a phishing
 * link as its own). Reduce URLs the same way authored content does (`card-author.ts` →
 * `reduceUrlsInText`), then backslash-escape the inline markdown control chars (CommonMark) so
 * no link / code / emphasis span can form. Authored strings (input labels, resolved choice
 * titles, the action label) are already sanitized at authoring time and are not routed here.
 */
function neutralizeEcho(value: string): string {
  return reduceUrlsInText(value).replace(/[\\`*_~\[\]<]/g, "\\$&");
}

interface StatusParams {
  card: Record<string, unknown>;
  plain: string;
  inputs?: Record<string, string>;
  operator: string;
  actionLabel: string;
  status: CardActionStatus;
  errorText?: string;
  /**
   * Recoverable error: keep the authored inputs (editable) and `Action.Submit` buttons so the
   * user can actually act on the "please retry" hint on the same card. Terminal states
   * (`completed`, dead-lettered errors) leave this unset and get the frozen, action-stripped card.
   */
  preserveControls?: boolean;
}

function freezeInput(
  element: Record<string, unknown>,
  inputs: Record<string, string>,
  selections: string[],
  selectedChoices: string[],
): Record<string, unknown> | null {
  const id = typeof element.id === "string" ? element.id : "";
  if (!id || !Object.hasOwn(inputs, id)) return null;
  const rawValue = inputs[id];
  // The submitted value is attacker-controlled; neutralize it before it is echoed into a
  // TextBlock. A ChoiceSet value that resolves to an authored choice title is replaced by that
  // (already-sanitized) title below, so only free-form / unrecognized submissions carry escapes.
  let displayValue = neutralizeEcho(rawValue);
  if (element.type === "Input.ChoiceSet" && Array.isArray(element.choices)) {
    const selected = element.choices.find((choice) => (
      choice && typeof choice === "object" && (choice as { value?: unknown }).value === rawValue
    )) as { title?: unknown } | undefined;
    if (typeof selected?.title === "string") displayValue = selected.title;
    selectedChoices.push(displayValue);
  }
  const label = typeof element.label === "string" && element.label.trim() ? element.label.trim() : id;
  const text = `${label}：${displayValue}`;
  selections.push(text);
  return { type: "TextBlock", text, wrap: true, spacing: "Small" };
}

function freezeElement(
  element: Record<string, unknown>,
  inputs: Record<string, string>,
  selections: string[],
  selectedChoices: string[],
): Record<string, unknown> | null {
  if (typeof element.type === "string" && element.type.startsWith("Input.")) {
    return freezeInput(element, inputs, selections, selectedChoices);
  }
  const frozen: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(element)) {
    if (Array.isArray(value)) {
      frozen[key] = value.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [item];
        const child = freezeElement(item as Record<string, unknown>, inputs, selections, selectedChoices);
        return child ? [child] : [];
      });
    } else {
      frozen[key] = value;
    }
  }
  return frozen;
}

/** Preserve the authored card body, freeze submitted inputs, remove actions, and append status. */
export function renderCardActionStatus(params: StatusParams): { card: Record<string, unknown>; plain: string } {
  if (params.preserveControls) {
    // Recoverable error: leave the interactive card intact (inputs editable, Action.Submit kept)
    // and only append the error line, so a resubmit is physically reachable from the same card.
    // errorText is bot-authored constant text today, but neutralize it too so this path can never
    // echo an active link even if a future caller derives it from submitted content.
    const statusLine = `⚠️ ${neutralizeEcho(params.errorText ?? "处理失败")}`;
    const sourceBody = Array.isArray(params.card.body) ? params.card.body : [];
    const body = [
      ...sourceBody,
      { type: "TextBlock", text: statusLine, wrap: true, spacing: "Medium", separator: true },
    ];
    const basePlain = params.plain.trim();
    const plain = [...(basePlain ? [basePlain] : []), statusLine].join("\n");
    return { card: { ...params.card, body }, plain };
  }

  const selections: string[] = [];
  const selectedChoices: string[] = [];
  const inputs = params.inputs ?? {};
  const sourceBody = Array.isArray(params.card.body) ? params.card.body : [];
  const body = sourceBody.flatMap((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) return [];
    const frozen = freezeElement(element as Record<string, unknown>, inputs, selections, selectedChoices);
    return frozen ? [frozen] : [];
  });
  const selectedLabel = selectedChoices.length > 0 ? selectedChoices.join(" / ") : params.actionLabel;
  // operator is a user-set display name (uid→name); neutralize it before it lands in a TextBlock.
  // selectedLabel is built from already-neutralized submitted values or authored titles/labels.
  const operator = neutralizeEcho(params.operator);
  const statusLine = params.status === "processing"
    ? `⏳ ${operator} 正在处理「${params.actionLabel}」`
    : params.status === "completed"
      ? `✅ ${operator} 已选择「${selectedLabel}」`
      : `⚠️ ${neutralizeEcho(params.errorText ?? "处理失败")}`;
  body.push({ type: "TextBlock", text: statusLine, wrap: true, spacing: "Medium", separator: true });

  const { actions: _actions, ...cardWithoutActions } = params.card;
  const basePlain = params.plain
    .split("\n")
    .filter((line) => !line.startsWith("可选操作："))
    .join("\n")
    .trim();
  const plain = [...(basePlain ? [basePlain] : []), ...selections, statusLine].join("\n");
  return {
    card: { ...cardWithoutActions, body },
    plain,
  };
}
