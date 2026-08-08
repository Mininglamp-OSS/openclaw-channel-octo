import { cardFitsLimits } from "./card-limits.js";
import {
  boundedForReduction,
  cardSupports,
  cutOnWhitespace,
  isDefinitelyBlankWithinReductionBound,
  isSensitive,
  reduceUrlsInText,
  REDUCE_INPUT_MAX,
  type CardCaps,
} from "./card-render.js";
import { CARD_INTERACTIVE_PROFILE } from "./types.js";

export interface CardButtonSpec {
  id: string;
  label: string;
  data?: Record<string, unknown>;
  style?: "positive" | "destructive";
}

export interface CardInputSpec {
  id: string;
  kind?: "text" | "number" | "date" | "time" | "toggle" | "choice";
  label?: string;
  placeholder?: string;
  choices?: Array<{ title: string; value: string }>;
}

export interface CardSectionBlockSpec {
  type: "section";
  title?: string;
  text?: string;
  facts?: Array<{ title: string; value: string }>;
}

export interface CardOptionsBlockSpec {
  type: "options";
  id: string;
  label?: string;
  options: Array<{ title: string; value: string }>;
}

export type InteractiveCardBlockSpec = CardSectionBlockSpec | CardOptionsBlockSpec;

export interface InteractiveCardSpec {
  title: string;
  text?: string;
  blocks?: InteractiveCardBlockSpec[];
  buttons: CardButtonSpec[];
  inputs?: CardInputSpec[];
}

export interface BuiltInteractiveCard {
  ok: true;
  card: Record<string, unknown>;
  plain: string;
  title: string;
  actionLabels: Record<string, string>;
  inputIds: string[];
}

type BuildFailure = { ok: false; error: string };

const MAX_BUTTONS = 6;
const MAX_INPUTS = 5;
const MAX_BLOCKS = 20;
const MAX_OPTIONS = 128;
const MAX_FACTS = 50;
const MAX_TITLE = 200;
const MAX_TEXT = 2_000;
const MAX_LABEL = 64;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SECRET_KEY = /token|secret|password|passwd|pwd|authorization|bearer|api[_-]?key|client[_-]?secret/i;

const INPUT_TYPES: Record<NonNullable<CardInputSpec["kind"]>, string> = {
  text: "Input.Text",
  number: "Input.Number",
  date: "Input.Date",
  time: "Input.Time",
  toggle: "Input.Toggle",
  choice: "Input.ChoiceSet",
};

function failure(error: string): BuildFailure {
  return { ok: false, error };
}

/**
 * 清洗一段作者提供的文本。返回 null 表示不可用;`reason` 说明**为什么**不可用 ——
 * 归约在自己的 `max` 截断之前跑,所以一个超长且不含空白的标题会被界整段拒掉,而调用方原本
 * 一律报「含敏感信息」,把作者指向了错误的方向。
 */
function cleanTextWithReason(value: unknown, max: number): { text: string } | { reason: string } {
  if (typeof value !== "string") return { reason: "must be a string" };
  const reduced = reduceUrlsInText(value).trim();
  if (!reduced) {
    if (isDefinitelyBlankWithinReductionBound(value)) return { reason: "is required" };
    // **归约返回空有多个原因,不能把它们全冒充成同一个具体原因。** 上一版把「不是空白」一律
    // 报成长度问题,5 个字符的 `a://:` 被告知「over 4000 characters」;后来又把 poison、
    // residual default-deny 和 URL 解析失败全报成 URL 问题。能从同一 authority 确定的两类先问:
    if (value.length > REDUCE_INPUT_MAX) {
      // 1. 超长且前 4000 字符里切不出空白 —— 界整段拒掉,确实是长度问题。
      if (cutOnWhitespace(value, REDUCE_INPUT_MAX) === null) {
        return {
          reason: `is too long to sanitize (over ${REDUCE_INPUT_MAX} characters with no whitespace to break on)`,
        };
      }
      // 2. 切得出空白,但切口之后那一段敏感 —— 这是内容问题,不是长度问题。
      if (boundedForReduction(value) === null) return { reason: "must not contain sensitive data" };
    }
    // 3. 界放行而归约仍清空:可能是 URL 解析失败,也可能是 poison / residual default-deny。
    // reduceUrlsInText 的公开契约没有暴露更细原因;与其复制三套规则,给出中性且真实的说明。
    return { reason: "was withheld by sanitization" };
  }
  if (isSensitive(reduced, true)) return { reason: "must not contain sensitive data" };
  return { text: reduced.length > max ? `${reduced.slice(0, max)}…` : reduced };
}

function cleanText(value: unknown, max: number): string | null {
  const r = cleanTextWithReason(value, max);
  return "text" in r ? r.text : null;
}

function sanitizeData(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    const reduced = reduceUrlsInText(value).trim();
    return isSensitive(reduced, true) ? "[redacted]" : reduced.slice(0, 512);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeData(item, "", depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[childKey] = sanitizeData(childValue, childKey, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function buildInteractiveCard(
  spec: InteractiveCardSpec,
  caps?: CardCaps,
): BuiltInteractiveCard | BuildFailure {
  const titleResult = cleanTextWithReason(spec.title, MAX_TITLE);
  if (!("text" in titleResult)) return failure(`title ${titleResult.reason}`);
  const title = titleResult.text;
  if (caps && !cardSupports(caps, "TextBlock")) return failure("TextBlock is not supported");
  if (caps && !cardSupports(caps, "Action.Submit")) return failure("Action.Submit is not supported");

  if (!Array.isArray(spec.buttons) || spec.buttons.length === 0) {
    return failure("at least one button is required");
  }
  if (spec.buttons.length > MAX_BUTTONS) return failure(`too many buttons (max ${MAX_BUTTONS})`);

  const actionIds = new Set<string>();
  const actions: Record<string, unknown>[] = [];
  const actionLabels: Record<string, string> = {};
  for (const button of spec.buttons) {
    const id = typeof button.id === "string" ? button.id.trim() : "";
    const label = cleanText(button.label, MAX_LABEL);
    if (!ID_PATTERN.test(id)) return failure("button id must be 1-64 safe characters");
    if (!label) return failure(`button ${id} requires a safe label`);
    if (actionIds.has(id)) return failure(`duplicate button id: ${id}`);
    actionIds.add(id);
    const action: Record<string, unknown> = { type: "Action.Submit", id, title: label };
    if (button.data && typeof button.data === "object") action.data = sanitizeData(button.data);
    if (button.style === "positive" || button.style === "destructive") action.style = button.style;
    actions.push(action);
    actionLabels[id] = label;
  }

  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
  ];
  const plainLines = [title];
  const text = spec.text ? cleanText(spec.text, MAX_TEXT) : null;
  if (spec.text && !text) return failure("text contains sensitive or invalid content");
  if (text) {
    body.push({ type: "TextBlock", text, wrap: true, spacing: "Small" });
    plainLines.push(text);
  }

  const inputIds = new Set<string>();
  const inputNodes: Record<string, unknown>[] = [];
  const blocks = spec.blocks ?? [];
  if (!Array.isArray(blocks)) return failure("blocks must be an array");
  if (blocks.length > MAX_BLOCKS) return failure(`too many blocks (max ${MAX_BLOCKS})`);
  for (const block of blocks) {
    if (!block || typeof block !== "object") return failure("block must be an object");
    if (block.type === "section") {
      const sectionTitle = block.title === undefined ? null : cleanText(block.title, MAX_TITLE);
      const sectionText = block.text === undefined ? null : cleanText(block.text, MAX_TEXT);
      if (block.title !== undefined && !sectionTitle) return failure("section has an invalid title");
      if (block.text !== undefined && !sectionText) return failure("section has invalid text");
      const facts = block.facts ?? [];
      if (!Array.isArray(facts)) return failure("section facts must be an array");
      if (facts.length > MAX_FACTS) return failure(`too many section facts (max ${MAX_FACTS})`);
      const cleanFacts: Array<{ title: string; value: string }> = [];
      for (const fact of facts) {
        const factTitle = cleanText(fact?.title, MAX_LABEL);
        const factValue = cleanText(fact?.value, MAX_TEXT);
        if (!factTitle || !factValue) return failure("section contains invalid facts");
        cleanFacts.push({ title: factTitle, value: factValue });
      }
      if (!sectionTitle && !sectionText && cleanFacts.length === 0) {
        return failure("section must contain title, text, or facts");
      }
      const items: Record<string, unknown>[] = [];
      if (sectionTitle) {
        items.push({ type: "TextBlock", text: sectionTitle, weight: "Bolder", wrap: true });
        plainLines.push(sectionTitle);
      }
      if (sectionText) {
        items.push({ type: "TextBlock", text: sectionText, wrap: true, spacing: "Small" });
        plainLines.push(sectionText);
      }
      if (cleanFacts.length > 0) {
        if (cardSupports(caps, "FactSet")) {
          items.push({ type: "FactSet", facts: cleanFacts });
        } else {
          items.push(...cleanFacts.map((fact) => ({
            type: "TextBlock",
            text: `${fact.title}：${fact.value}`,
            wrap: true,
            spacing: "Small",
          })));
        }
        plainLines.push(...cleanFacts.map((fact) => `${fact.title}：${fact.value}`));
      }
      if (cardSupports(caps, "Container")) body.push({ type: "Container", items, spacing: "Medium" });
      else body.push(...items);
      continue;
    }
    if (block.type === "options") {
      const id = typeof block.id === "string" ? block.id.trim() : "";
      if (!ID_PATTERN.test(id)) return failure("options id must be 1-64 safe characters");
      if (inputIds.has(id)) return failure(`duplicate input id: ${id}`);
      if (caps && !cardSupports(caps, "Input.ChoiceSet")) return failure("Input.ChoiceSet is not supported");
      if (!Array.isArray(block.options) || block.options.length === 0) {
        return failure(`options block ${id} requires options`);
      }
      if (block.options.length > MAX_OPTIONS) {
        return failure(`options block ${id} has too many options (max ${MAX_OPTIONS})`);
      }
      const choices: Array<{ title: string; value: string }> = [];
      for (const option of block.options) {
        const optionTitle = cleanText(option?.title, MAX_LABEL);
        const optionValue = cleanText(option?.value, MAX_LABEL);
        if (!optionTitle || !optionValue) return failure(`options block ${id} contains invalid options`);
        choices.push({ title: optionTitle, value: optionValue });
      }
      const label = block.label === undefined ? null : cleanText(block.label, MAX_LABEL);
      if (block.label !== undefined && !label) return failure(`options block ${id} has an invalid label`);
      inputIds.add(id);
      const node: Record<string, unknown> = {
        type: "Input.ChoiceSet",
        id,
        style: "expanded",
        choices,
        ...(label ? { label } : {}),
      };
      body.push(node);
      inputNodes.push(node);
      plainLines.push(`[${label ?? id}] 可选值：${choices.map((choice) => choice.title).join(" / ")}`);
      continue;
    }
    return failure(`unsupported block type: ${String((block as { type?: unknown }).type)}`);
  }

  const inputs = spec.inputs ?? [];
  if (!Array.isArray(inputs)) return failure("inputs must be an array");
  if (inputs.length + inputIds.size > MAX_INPUTS) return failure(`too many inputs (max ${MAX_INPUTS})`);
  for (const input of inputs) {
    const id = typeof input.id === "string" ? input.id.trim() : "";
    if (!ID_PATTERN.test(id)) return failure("input id must be 1-64 safe characters");
    if (inputIds.has(id)) return failure(`duplicate input id: ${id}`);
    inputIds.add(id);
    const kind = input.kind ?? "text";
    const type = INPUT_TYPES[kind];
    if (!type) return failure(`unsupported input kind: ${String(kind)}`);
    if (caps && !cardSupports(caps, type)) return failure(`${type} is not supported`);

    const node: Record<string, unknown> = { type, id };
    if (input.label) {
      const label = cleanText(input.label, MAX_LABEL);
      if (!label) return failure(`input ${id} has an invalid label`);
      node.label = label;
    }
    if (kind === "choice") {
      if (!Array.isArray(input.choices) || input.choices.length === 0) {
        return failure(`choice input ${id} requires choices`);
      }
      if (input.choices.length > MAX_OPTIONS) {
        return failure(`choice input ${id} has too many choices (max ${MAX_OPTIONS})`);
      }
      const choices: Array<{ title: string; value: string }> = [];
      for (const choice of input.choices) {
        const choiceTitle = cleanText(choice.title, MAX_LABEL);
        const choiceValue = cleanText(choice.value, MAX_LABEL);
        if (!choiceTitle || !choiceValue) return failure(`choice input ${id} contains invalid choices`);
        choices.push({ title: choiceTitle, value: choiceValue });
      }
      node.choices = choices;
    } else if (input.placeholder) {
      const placeholder = cleanText(input.placeholder, MAX_LABEL);
      if (!placeholder) return failure(`input ${id} has an invalid placeholder`);
      node.placeholder = placeholder;
    }
    if (kind === "text" && caps?.maxInputTextBytes) {
      // Adaptive Cards maxLength counts characters; divide by four for a conservative UTF-8 cap.
      node.maxLength = Math.max(1, Math.floor(caps.maxInputTextBytes / 4));
    }
    inputNodes.push(node);
    body.push(node);
    const inputLabel = String(node.label ?? id);
    if (kind === "choice") {
      const choiceLabels = (node.choices as Array<{ title: string }>).map((choice) => choice.title);
      plainLines.push(`[${inputLabel}] 可选值：${choiceLabels.join(" / ")}`);
    } else {
      plainLines.push(`[${inputLabel}]`);
    }
  }

  if (
    caps?.maxInputsBytes &&
    new TextEncoder().encode(JSON.stringify(inputNodes)).byteLength > caps.maxInputsBytes
  ) {
    return failure("input definitions exceed max_inputs_bytes");
  }
  plainLines.push(`可选操作：${Object.values(actionLabels).join(" / ")}`);

  const card: Record<string, unknown> = {
    type: "AdaptiveCard",
    version: "1.5",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
    actions,
  };
  const plain = plainLines.join("\n");
  if (!cardFitsLimits(card, plain, caps, CARD_INTERACTIVE_PROFILE)) {
    return failure("interactive card exceeds negotiated limits");
  }
  return { ok: true, card, plain, title, actionLabels, inputIds: [...inputIds] };
}
