/**
 * 展示卡构建器 —— 方案乙:agent / 进度卡用受控的 DisplayBlock 描述展示意图,构建器翻译成
 * Adaptive Cards 1.5 JSON,按服务端下放的能力清单(CardCaps)协商降级,统一脱敏(与 card-render
 * 同套 helper:URL 降级到 scheme://注册域、命中 secret shape 整块隐藏)。绝不产出会被服务端
 * 400 的结构,消费者无需自己判断白名单。
 *
 * 本轮支持的 block:heading / text / rich / facts / table / columns / group(高价值子集)。
 * collapsible 在 P1-c 引入(依赖 caps.actions 里 Action.ToggleVisibility);
 * copy 在 P1-j 引入(依赖 caps.actions 里 Action.CopyToClipboard,客户端本地动作,不回流)。
 * link 在 P1-k 引入(依赖 caps.actions 里 Action.OpenUrl;优先可见 ActionSet,不回流)。
 * image/gallery 后续轮次。
 *
 * 纯函数、无副作用、无 I/O —— hook 进度卡与 agent 展示卡工具共享这一层。
 */

import { cardSupports, isSensitive, reduceUrlsInText, REDUCE_INPUT_MAX, type CardCaps } from "./card-render.js";
import { cardFitsLimits } from "./card-limits.js";
import { CARD_VERSION } from "./types.js";

// ── DisplayBlock:展示意图 ──────────────────────────────────
/** 富文本行内片段(rich block 用)。 */
export interface RichSegment {
  text: string;
  bold?: boolean;
  subtle?: boolean;
  fontType?: "Default" | "Monospace";
  color?: "default" | "good" | "warning" | "attention" | "accent";
}

/** 一条键值(facts block 用)。 */
export interface Fact {
  label: string;
  value: string;
}

/** 表格列定义。 */
export interface TableColumn {
  /** Adaptive Cards TableColumnDefinition.width;当前 helper 暴露数字权重。 */
  width?: number;
}

/** 表格单元格。text 是简写;blocks 可放 text/rich/group 等展示块。 */
export type TableCell =
  | { text: string; blocks?: never }
  | { blocks: DisplayBlock[]; text?: never };

/** 表格行。 */
export interface TableRow {
  cells: TableCell[];
}

/** ColumnSet 单列。 */
export interface Column {
  blocks: DisplayBlock[];
}

/** Container 语义着色(group block 用)。 */
export type GroupStyle = "default" | "good" | "warning" | "attention" | "emphasis";

/**
 * 展示 block —— agent / 进度卡用它表达「想展示什么」,不直接写 AC element JSON。
 * 构建器负责翻译成受能力约束的 AC element,并在不支持时降级。
 */
export type DisplayBlock =
  | { type: "heading"; text: string; size?: "medium" | "large" }
  | { type: "text"; text: string }
  | { type: "rich"; segments: RichSegment[] }
  | { type: "facts"; items: Fact[] }
  | { type: "table"; rows: TableRow[]; columns?: TableColumn[]; firstRowAsHeader?: boolean }
  | { type: "columns"; columns: Column[] }
  | { type: "link"; text: string; url: string }
  | { type: "group"; style?: GroupStyle; blocks: DisplayBlock[] }
  | {
      type: "collapsible";
      summary: string;
      summarySegments?: RichSegment[];
      actionLabel?: string;
      expandLabel?: string;
      collapseLabel?: string;
      defaultVisible?: boolean;
      blocks: DisplayBlock[];
    }
  | { type: "copy"; label?: string; text: string };

export interface BuildDisplayCardOptions {
  /** 卡片标题(渲染成置顶的 Bolder TextBlock)。 */
  title?: string;
  blocks: DisplayBlock[];
  /** 服务端能力清单;缺省用 card-render 的保守 baseline。 */
  caps?: CardCaps;
  /**
   * 内容是否**可信/已脱敏**。默认 false(不可信 agent 输入 → sanitize 用最严 generic=true)。
   * 进度卡文案上游已逐 sink 脱敏 → 传 true(sanitize 用 generic=false,不再二次误删 git SHA 等)。
   */
  trusted?: boolean;
  /**
   * 超服务端限制丢块时的截断提示。默认中文,与其余卡面文案一致;进度卡等**整卡已英文化**的
   * 调用方覆盖它,避免同一张卡里中英混排。
   */
  dropMarker?: DropMarker;
}

/** dropped → 卡面文案 + plain 兜底文案(plain 略去括号里的原因,与正文行宽对齐)。 */
export type DropMarker = (dropped: number) => { text: string; plain: string };

const DEFAULT_DROP_MARKER: DropMarker = (dropped) => ({
  text: `… 省略 ${dropped} 项(超出服务端限制)`,
  plain: `… 省略 ${dropped} 项`,
});

/** 英文卡面用的截断提示(进度卡)。 */
export const EN_DROP_MARKER: DropMarker = (dropped) => ({
  text: `… ${dropped} more items dropped (server limit)`,
  plain: `… ${dropped} more items dropped`,
});

export interface BuildDisplayCardResult {
  card: Record<string, unknown>;
  plain: string;
}

// ── 文本清洗(与 card-render 的参数摘要/错误脱敏同套)────────
/**
 * 群卡片全员可见 → 与 summarizeToolParams/sanitizeErrorText 同套:
 *   1. 折叠空白;
 *   2. 内嵌 URL 降级为 `scheme://注册域`(丢子域/path/query/userinfo,杀 webhook/预签名/隧道
 *      场景里的密钥);
 *   3. 命中 secret 关键词/形状 → 返回 null(整个 block 不渲染,fail-closed)。
 *
 * `generic`:
 *   - `true`(默认,**不可信** agent 展示卡输入)—— 额外套用长 hex/高熵检测,最严;
 *   - `false`(**可信**、上游已逐 sink 脱敏的进度卡文案)—— 只走关键词 + 明确前缀,避免把
 *     git SHA / docker digest / 缓存哈希等正常内容二次误删(见 renderProgressCard 的 trusted)。
 * 返回 null 表示"敏感,不该展示";空串同 null(text-only block 无内容也不渲染)。
 */
function sanitize(text: string, generic = true): string | null {
  let s = text.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // 这个 sink **没有渲染上限** —— 与摘要(64)、错误(120)、debug 串(512)不同,一段长文本
  // 会整段渲染,所以界在这里的影响是直接可见的。曾经这里另有一道「截断前先在未截断原串上跑
  // isSensitive」的预检,用来挡住横跨切口被切成两半、守卫认不出的密钥。
  //
  // 那道预检**已经删掉**,因为界自己现在会用下面这同一个谓词检查它丢掉的那一段
  // (见 boundedForReduction)。不是"覆盖面严格更大" —— 被丢掉的那一段是预检所查范围的
  // **子集**,覆盖面是**挪了位置**:预检只装在这一个 sink 上,界覆盖全部十一个调用点。
  // 只有预检看得见的那些形状,归约本来就会把它们中和掉,实测没有可观察的损失。
  // 留着它还要付一笔与界无关的代价 —— 它查的是**整串**,于是
  //
  //     "https://hooks.slack.com/services/T../B../XXXX " + "word "×900
  //
  // 这种空白充裕、归约后完全安全的内容被整块丢掉(main 渲染 4517 字符)。
  const sensitiveHere = (t: string) => isSensitive(t, generic);
  s = reduceUrlsInText(s, sensitiveHere).replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (sensitiveHere(s)) return null;
  return s;
}

// ── 单 block → { elements, plainLines }─────────────────────
interface Rendered {
  elements: Record<string, unknown>[];
  plainLines: string[];
}

function adaptiveCard(body: Record<string, unknown>[]): Record<string, unknown> {
  return {
    type: "AdaptiveCard",
    version: CARD_VERSION,
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    body,
  };
}

/** Preserve complete rendered blocks while greedily fitting negotiated recursive limits. */
function fitRenderedGroups(
  groups: Rendered[],
  caps: CardCaps | undefined,
  dropMarker: DropMarker,
): { body: Record<string, unknown>[]; plainLines: string[] } {
  if (!caps?.maxNodes && !caps?.maxDepth && !caps?.maxPayloadBytes) {
    return {
      body: groups.flatMap((group) => group.elements),
      plainLines: groups.flatMap((group) => group.plainLines),
    };
  }

  const body: Record<string, unknown>[] = [];
  const plainLines: string[] = [];
  const accepted: Rendered[] = [];
  let dropped = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const nextBody = [...body, ...group.elements];
    const nextPlain = [...plainLines, ...group.plainLines];
    if (cardFitsLimits(adaptiveCard(nextBody), nextPlain.join("\n"), caps)) {
      accepted.push(group);
      body.push(...group.elements);
      plainLines.push(...group.plainLines);
      continue;
    }
    dropped = groups.length - i;
    break;
  }

  if (dropped > 0 && cardSupports(caps, "TextBlock")) {
    while (true) {
      const { text: markerText, plain: markerPlain } = dropMarker(dropped);
      const marker = textBlock(markerText);
      if (cardFitsLimits(adaptiveCard([...body, marker]), [...plainLines, markerPlain].join("\n"), caps)) {
        body.push(marker);
        plainLines.push(markerPlain);
        break;
      }
      const removed = accepted.pop();
      if (!removed) break;
      body.splice(body.length - removed.elements.length, removed.elements.length);
      plainLines.splice(plainLines.length - removed.plainLines.length, removed.plainLines.length);
      dropped++;
    }
  }

  // An impossibly small payload/depth budget may not fit even the marker. Empty output makes
  // the caller fail closed instead of sending a payload the server will reject.
  if (!cardFitsLimits(adaptiveCard(body), plainLines.join("\n"), caps)) {
    return { body: [], plainLines: [] };
  }
  return { body, plainLines };
}

const EMPTY: Rendered = { elements: [], plainLines: [] };

/**
 * 渲染上下文 —— collapsible 需要在整卡内生成唯一 id 用于 Action.ToggleVisibility 的
 * targetElements。用 counter 而非 Math.random(),便于测试且不引入非确定性。
 */
interface RenderCtx {
  caps?: CardCaps;
  uid: { n: number };
  /** 传给 sanitize 的 generic 档位:false=可信(进度卡),true=不可信(agent 展示卡,默认最严)。 */
  generic: boolean;
}

function nextId(ctx: RenderCtx, prefix: string): string {
  return `octo_disp_${prefix}_${ctx.uid.n++}`;
}

function textBlock(text: string, opts?: { bold?: boolean; size?: "medium" | "large" }): Record<string, unknown> {
  return {
    type: "TextBlock",
    text,
    wrap: true,
    ...(opts?.bold ? { weight: "Bolder" } : {}),
    ...(opts?.size ? { size: opts.size === "medium" ? "Medium" : "Large" } : {}),
  };
}

function openUrlAction(title: string, url: string): Record<string, unknown> {
  return {
    type: "Action.OpenUrl",
    title,
    url,
  };
}

function renderHeading(text: string, size: "medium" | "large" | undefined, ctx: RenderCtx): Rendered {
  const clean = sanitize(text, ctx.generic);
  if (!clean) return EMPTY;
  return { elements: [textBlock(clean, { bold: true, size })], plainLines: [clean] };
}

function renderText(text: string, ctx: RenderCtx): Rendered {
  const clean = sanitize(text, ctx.generic);
  if (!clean) return EMPTY;
  return { elements: [textBlock(clean)], plainLines: [clean] };
}

function sanitizeUrlForAction(url: string, ctx: RenderCtx): string | null {
  const clean = sanitize(url, ctx.generic);
  if (!clean) return null;
  try {
    const u = new URL(clean);
    return u.protocol === "http:" || u.protocol === "https:" ? clean : null;
  } catch {
    return null;
  }
}

function renderLink(text: string, url: string, ctx: RenderCtx): Rendered {
  const cleanText = sanitize(text, ctx.generic);
  const cleanUrl = sanitizeUrlForAction(url, ctx);
  if (!cleanText || !cleanUrl) return EMPTY;
  if (cardSupports(ctx.caps, "ActionSet") && cardSupports(ctx.caps, "Action.OpenUrl")) {
    return {
      elements: [
        {
          type: "ActionSet",
          actions: [openUrlAction(cleanText, cleanUrl)],
        },
      ],
      plainLines: [`${cleanText}：${cleanUrl}`],
    };
  }
  if (cardSupports(ctx.caps, "Action.OpenUrl")) {
    const el = textBlock(cleanText);
    // selectAction 只承载本地/导航类动作。Submit 必须是回流交互卡路径,这里永不生成。
    el.selectAction = openUrlAction(cleanText, cleanUrl);
    return { elements: [el], plainLines: [`${cleanText}：${cleanUrl}`] };
  }
  return { elements: [textBlock(`${cleanText}：${cleanUrl}`)], plainLines: [`${cleanText}：${cleanUrl}`] };
}

function renderRich(segments: RichSegment[], ctx: RenderCtx): Rendered {
  const joined = segments.map((s) => s.text).join("");
  // clean 走完整 sanitize:对**整段 joined** 做 URL 降级(能抓到跨 segment 拆开的 URL)+ secret 检查。
  const clean = sanitize(joined, ctx.generic);
  if (!clean) return EMPTY;
  // 关键(F1 修复):仅当 joined 里**没有任何可降级 URL** 时,才保留逐段 TextRun 的富样式 ——
  // 否则某个 segment(或跨段拆开)的 URL 会以原文进 TextRun,而 plain 已降级 → card ⊋ plain 泄露。
  // 含 URL 时降级为单个 TextBlock(用已降级的 clean),card 与 plain 一致、绝不多出密钥。
  // 这里**不传谓词**,因为传了也没用:`reduceUrlsInText(joined, P) === joined` 的结果与 P 无关。
  // joined ≤ 4000 时界原样返回,与 P 无关;> 4000 时界要么返回 ""、要么返回一个 ≤4000 的前缀,
  // 两者都不可能等于 joined。曾经这里传了一个谓词并配了段注释说"两次调用的界必须一致",那个
  // 约束根本约束不到任何东西 —— 留着只会让下一个读者以为它在起作用。
  const noReducibleUrl = reduceUrlsInText(joined) === joined;
  if (noReducibleUrl && cardSupports(ctx.caps, "RichTextBlock")) {
    return {
      elements: [
        {
          type: "RichTextBlock",
          inlines: segments.map((s) => ({
            type: "TextRun",
            text: s.text,
            ...(s.bold ? { weight: "Bolder" } : {}),
            ...(s.subtle ? { isSubtle: true } : {}),
            ...(s.fontType ? { fontType: s.fontType } : {}),
            ...(s.color && s.color !== "default" ? { color: s.color } : {}),
          })),
        },
      ],
      plainLines: [clean],
    };
  }
  // 降级:段拼成单个 TextBlock(已 URL 降级;顺带解决 ColumnSet plain 分行:一行完整而非按列拆行)。
  return { elements: [textBlock(clean)], plainLines: [clean] };
}

function renderTableCell(cell: TableCell, ctx: RenderCtx): Rendered {
  if (Array.isArray(cell.blocks)) return renderBlocks(cell.blocks, ctx);
  return typeof cell.text === "string" ? renderText(cell.text, ctx) : EMPTY;
}

function renderTableColumns(columns: TableColumn[] | undefined, columnCount: number): Array<{ width: number }> {
  return Array.from({ length: columnCount }, (_, i) => {
    const width = columns?.[i]?.width;
    return { width: typeof width === "number" && Number.isFinite(width) && width > 0 ? width : 1 };
  });
}

function renderTable(
  rows: TableRow[],
  columns: TableColumn[] | undefined,
  firstRowAsHeader: boolean | undefined,
  ctx: RenderCtx,
): Rendered {
  const renderedRows: Array<{ cells: Rendered[]; plainLine: string }> = [];
  for (const row of rows) {
    const cells = row.cells
      .map((c) => renderTableCell(c, ctx))
      .filter((c) => c.elements.length > 0);
    if (cells.length > 0) {
      renderedRows.push({
        cells,
        plainLine: cells.map((cell) => cell.plainLines.join("；")).filter(Boolean).join(" | "),
      });
    }
  }
  if (renderedRows.length === 0) return EMPTY;

  const plainLines = renderedRows.map((row) => row.plainLine);
  if (cardSupports(ctx.caps, "Table")) {
    const columnCount = Math.max(columns?.length ?? 0, ...renderedRows.map((row) => row.cells.length));
    return {
      elements: [
        {
          type: "Table",
          firstRowAsHeader: firstRowAsHeader !== false,
          columns: renderTableColumns(columns, columnCount),
          rows: renderedRows.map((row) => ({
            type: "TableRow",
            cells: row.cells.map((cell) => ({
              type: "TableCell",
              items: cell.elements,
            })),
          })),
        },
      ],
      plainLines,
    };
  }

  return {
    elements: plainLines.map((line) => textBlock(line)),
    plainLines,
  };
}

function renderColumns(columns: Column[], ctx: RenderCtx): Rendered {
  const renderedColumns = columns
    .map((col) => renderBlocks(col.blocks, ctx))
    .filter((col) => col.elements.length > 0);
  if (renderedColumns.length === 0) return EMPTY;

  const plainLines = [renderedColumns.map((col) => col.plainLines.join("；")).filter(Boolean).join(" | ")];
  if (cardSupports(ctx.caps, "ColumnSet")) {
    return {
      elements: [
        {
          type: "ColumnSet",
          columns: renderedColumns.map((col) => ({
            type: "Column",
            width: "stretch",
            items: col.elements,
          })),
        },
      ],
      plainLines,
    };
  }

  return {
    elements: [textBlock(plainLines[0])],
    plainLines,
  };
}

function renderFacts(items: Fact[], ctx: RenderCtx): Rendered {
  // 每条键值独立过 sanitize:label 或 value 命中 secret → 该条隐藏,不影响其它条(细粒度)。
  const cleaned: Array<{ label: string; value: string }> = [];
  for (const f of items) {
    const label = sanitize(f.label, ctx.generic);
    const value = sanitize(f.value, ctx.generic);
    if (!label || !value) continue;
    cleaned.push({ label, value });
  }
  if (cleaned.length === 0) return EMPTY;
  const plainLines = cleaned.map((f) => `${f.label}：${f.value}`);
  if (cardSupports(ctx.caps, "FactSet")) {
    return {
      elements: [
        {
          type: "FactSet",
          facts: cleaned.map((f) => ({ title: f.label, value: f.value })),
        },
      ],
      plainLines,
    };
  }
  // 降级:每条键值一行 TextBlock。
  return {
    elements: cleaned.map((f) => textBlock(`${f.label}：${f.value}`)),
    plainLines,
  };
}

function renderGroup(
  style: GroupStyle | undefined,
  blocks: DisplayBlock[],
  ctx: RenderCtx,
): Rendered {
  const inner = renderBlocks(blocks, ctx);
  if (inner.elements.length === 0) return EMPTY;
  if (cardSupports(ctx.caps, "Container")) {
    return {
      elements: [
        {
          type: "Container",
          ...(style && style !== "default" ? { style } : {}),
          items: inner.elements,
        },
      ],
      plainLines: inner.plainLines,
    };
  }
  // 降级:平铺子 block(不丢内容,只丢着色/分组视觉)。
  return inner;
}

/**
 * 折叠/展开 —— 升级条件齐备(forward-compat,任一未 advertise 就降级平铺):
 *   1. `caps.elements` 含 `Container` —— 用来包 hidden 内容 + `isVisible:false`;
 *   2. `caps.elements` 含 `ColumnSet` —— 摘要左列 + 右侧按钮列;
 *   3. `caps.elements` 含 `ActionSet` —— 触发器容器,避免部分前端对 TextBlock.selectAction
 *      的 ToggleVisibility 支持不完整;
 *   4. `caps.actions` 含 `Action.ToggleVisibility` —— 具体动作被服务端接受(旧部署无该 advertise
 *      → 保守 fail-closed,避免乐观发出被 400)。
 *
 * summary 是永远可见的摘要,右侧 Column 放两个 ActionSet 互相切换可见性,避免单按钮文案无法
 * 从"展开"自动变"收起"。inner 可默认隐藏或展开。降级形态 = summary 当 heading + inner
 * 全部展开在下方(视觉上等同"已展开",信息不丢)。
 *
 * 若 summary 被脱敏或空 / inner 全被脱敏或空,整个 collapsible 不渲染 —— 避免展开后是空块。
 */
function renderCollapsible(summary: string, blocks: DisplayBlock[], ctx: RenderCtx): Rendered {
  return renderCollapsibleWithSummary(summary, undefined, undefined, undefined, undefined, false, blocks, ctx);
}

function renderCollapsibleWithActionLabel(
  summary: string,
  actionLabel: string | undefined,
  blocks: DisplayBlock[],
  ctx: RenderCtx,
): Rendered {
  return renderCollapsibleWithSummary(summary, undefined, actionLabel, undefined, undefined, false, blocks, ctx);
}

function renderCollapsibleWithSummary(
  summary: string,
  summarySegments: RichSegment[] | undefined,
  actionLabel: string | undefined,
  expandLabel: string | undefined,
  collapseLabel: string | undefined,
  defaultVisible: boolean | undefined,
  blocks: DisplayBlock[],
  ctx: RenderCtx,
): Rendered {
  const rawSummary = summarySegments ? summarySegments.map((s) => s.text).join("") : summary;
  const cleanSummary = sanitize(rawSummary, ctx.generic);
  if (!cleanSummary) return EMPTY;
  const rawExpandLabel = expandLabel ?? (actionLabel && actionLabel !== cleanSummary ? actionLabel : "展开");
  const cleanExpandLabel = sanitize(rawExpandLabel, ctx.generic) ?? "展开";
  const cleanCollapseLabel = sanitize(collapseLabel ?? "收起", ctx.generic) ?? "收起";
  const inner = renderBlocks(blocks, ctx);
  if (inner.elements.length === 0) return EMPTY;
  const summaryElements = summarySegments
    ? renderRich(summarySegments, ctx).elements
    : [textBlock(cleanSummary, { bold: true })];
  if (summaryElements.length === 0) return EMPTY;

  const canToggle =
    cardSupports(ctx.caps, "Container") &&
    cardSupports(ctx.caps, "ColumnSet") &&
    cardSupports(ctx.caps, "ActionSet") &&
    cardSupports(ctx.caps, "Action.ToggleVisibility");

  if (canToggle) {
    const detailId = nextId(ctx, "clp");
    const expandId = nextId(ctx, "btn_expand");
    const collapseId = nextId(ctx, "btn_collapse");
    const startVisible = defaultVisible === true;
    return {
      elements: [
        {
          type: "ColumnSet",
          columns: [
            {
              type: "Column",
              width: "stretch",
              items: summaryElements,
            },
            {
              type: "Column",
              width: "auto",
              items: [
                {
                  type: "ActionSet",
                  id: collapseId,
                  isVisible: startVisible,
                  actions: [
                    {
                      type: "Action.ToggleVisibility",
                      title: cleanCollapseLabel,
                      targetElements: [
                        { elementId: detailId, isVisible: false },
                        { elementId: collapseId, isVisible: false },
                        { elementId: expandId, isVisible: true },
                      ],
                    },
                  ],
                },
                {
                  type: "ActionSet",
                  id: expandId,
                  isVisible: !startVisible,
                  actions: [
                    {
                      type: "Action.ToggleVisibility",
                      title: cleanExpandLabel,
                      targetElements: [
                        { elementId: detailId, isVisible: true },
                        { elementId: collapseId, isVisible: true },
                        { elementId: expandId, isVisible: false },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "Container",
          id: detailId,
          isVisible: startVisible,
          items: inner.elements,
        },
      ],
      // plain 全展开,与折叠视觉无关。服务端 Finalize 会权威重算 plain。
      plainLines: [cleanSummary, ...inner.plainLines],
    };
  }

  // 降级:summary 当 heading + inner 全部展开在下方(零回归展开态)。
  return {
    elements: [...summaryElements, ...inner.elements],
    plainLines: [cleanSummary, ...inner.plainLines],
  };
}

const COPY_TEXT_MAX_BYTES = 4096;
const COPY_LABEL_DEFAULT = "复制";

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Action.CopyToClipboard 是客户端本地动作,不触发 bot callback。text 仍是群卡 JSON 的一部分,
 * 所以与普通正文同样脱敏,并按服务端/客户端约定限制为 UTF-8 4KiB。
 */
function renderCopy(label: string | undefined, text: string, ctx: RenderCtx): Rendered {
  const canCopy = cardSupports(ctx.caps, "Action.CopyToClipboard") && cardSupports(ctx.caps, "ActionSet");
  // 长度判定必须跑在**原始 text** 上,不能跑在 sanitize 的输出上 —— sanitize 里的
  // reduceUrlsInText 会把超长输入截掉,而这里的契约是字节数。ASCII 下 4000 字符恒 ≤ 4096 字节,
  // 所以下面那条 utf8Bytes 判定再也不会触发:20000 字符会安静地变成 4000 字符塞进复制按钮。
  // 复制按钮是读者会直接粘出去用的 sink,给残值比给提示糟得多。
  //
  // 两条上限的**理由不同,所以提示语也不同**。上一版把两者合并成一句"超过 4KiB",而
  // 4050 个 ASCII 字符就是 4050 字节 —— 合法地在契约内,却被告知超了字节限制,下一个人去查
  // 字节数会什么也查不到。
  //
  // **判定的位置和措辞是两件事。** 字符判定必须留在 sanitize 之前(它挡的就是 sanitize 的截断),
  // 但措辞取决于这条路径**有没有**复制按钮 —— 不支持 Action.CopyToClipboard 的客户端走的是普通
  // TextBlock,告诉它"未渲染复制按钮"是句没有指涉的话。下面那条字节判定按同一条规则摆:它只约束
  // 复制按钮,所以整个判定都在回退之后。上一版把这条放在回退之前,违反了本文件自己写下、也自己
  // 断言过的那条不变量 —— 而断言之所以是绿的,是因为它那个用例走的是字节路径,压根没碰到这里。
  if (text.length > REDUCE_INPUT_MAX) {
    const msg = canCopy
      ? `复制内容超过 ${REDUCE_INPUT_MAX} 字符，无法安全脱敏，未渲染复制按钮`
      : `内容超过 ${REDUCE_INPUT_MAX} 字符，无法安全脱敏，未渲染`;
    return { elements: [textBlock(msg)], plainLines: [msg] };
  }
  const cleanText = sanitize(text, ctx.generic);
  if (!cleanText) return EMPTY;
  const cleanLabel = sanitize(label ?? COPY_LABEL_DEFAULT, ctx.generic) ?? COPY_LABEL_DEFAULT;
  if (!canCopy) {
    return {
      elements: [textBlock(cleanText)],
      plainLines: [cleanText],
    };
  }
  // 字节上限只约束**复制按钮**,所以判定留在 cardSupports 回退之后。放到回退之前会让不支持
  // Action.CopyToClipboard 的客户端也收到"未渲染复制按钮" —— 那条路径走的是普通 TextBlock,
  // 本来就没有复制按钮,也从来没有字节限制。
  if (utf8Bytes(cleanText) > COPY_TEXT_MAX_BYTES) {
    const msg = "复制内容超过 4KiB，未渲染复制按钮";
    return {
      elements: [textBlock(msg)],
      plainLines: [msg],
    };
  }
  return {
    elements: [
      {
        type: "ActionSet",
        actions: [
          {
            type: "Action.CopyToClipboard",
            title: cleanLabel,
            text: cleanText,
          },
        ],
      },
    ],
    plainLines: [cleanText],
  };
}

function renderBlock(block: DisplayBlock, ctx: RenderCtx): Rendered {
  switch (block.type) {
    case "heading":
      return renderHeading(block.text, block.size, ctx);
    case "text":
      return renderText(block.text, ctx);
    case "rich":
      return renderRich(block.segments, ctx);
    case "facts":
      return renderFacts(block.items, ctx);
    case "table":
      return renderTable(block.rows, block.columns, block.firstRowAsHeader, ctx);
    case "columns":
      return renderColumns(block.columns, ctx);
    case "link":
      return renderLink(block.text, block.url, ctx);
    case "group":
      return renderGroup(block.style, block.blocks, ctx);
    case "collapsible":
      return renderCollapsibleWithSummary(
        block.summary,
        block.summarySegments,
        block.actionLabel,
        block.expandLabel,
        block.collapseLabel,
        block.defaultVisible,
        block.blocks,
        ctx,
      );
    case "copy":
      return renderCopy(block.label, block.text, ctx);
  }
}

function renderBlocks(blocks: DisplayBlock[], ctx: RenderCtx): Rendered {
  const elements: Record<string, unknown>[] = [];
  const plainLines: string[] = [];
  for (const b of blocks) {
    const r = renderBlock(b, ctx);
    elements.push(...r.elements);
    plainLines.push(...r.plainLines);
  }
  return { elements, plainLines };
}

/**
 * 构建展示卡。返回 `{ card, plain }`:card = AC 1.5 JSON(按 caps 协商降级、逐 block 脱敏),
 * plain = 纯文本兜底(与布局无关,服务端 Finalize 会权威重算)。
 */
export function buildDisplayCard(opts: BuildDisplayCardOptions): BuildDisplayCardResult {
  const { title, blocks, caps, trusted, dropMarker = DEFAULT_DROP_MARKER } = opts;
  // Every currently supported block either is TextBlock or degrades through TextBlock.
  // An explicitly advertised capability set without TextBlock has no safe output shape.
  if (caps?.elements !== undefined && !cardSupports(caps, "TextBlock")) {
    return { card: adaptiveCard([]), plain: "" };
  }
  const ctx: RenderCtx = { caps, uid: { n: 0 }, generic: !trusted };
  const groups: Rendered[] = [];
  let cleanTitle = "";

  if (title) {
    cleanTitle = sanitize(title, ctx.generic) ?? "";
    if (cleanTitle) {
      groups.push({ elements: [textBlock(cleanTitle, { bold: true })], plainLines: [cleanTitle] });
    }
  }

  const renderedGroups = blocks.map((block) => renderBlock(block, ctx));
  const firstRendered = renderedGroups.find((group) => group.elements.length > 0 || group.plainLines.length > 0);
  // Agent 常同时传 title + 首个同名 heading。展示面只保留一个标题,plain 同步去重。
  if (
    cleanTitle &&
    firstRendered?.plainLines[0] === cleanTitle &&
    firstRendered.elements[0]?.type === "TextBlock" &&
    firstRendered.elements[0]?.text === cleanTitle
  ) {
    firstRendered.elements.shift();
    firstRendered.plainLines.shift();
  }
  groups.push(...renderedGroups.filter((group) => group.elements.length > 0 || group.plainLines.length > 0));
  const { body, plainLines } = fitRenderedGroups(groups, caps, dropMarker);
  const card = adaptiveCard(body);
  return { card, plain: plainLines.join("\n") };
}

// ── 不可信输入验证 ────────────────────────────────────────────
/**
 * 白名单校验 agent / 外部输入的 DisplayBlock —— 每 block:
 *   - `type` 在支持集内(heading/text/rich/facts/table/columns/link/group/collapsible/copy);
 *   - 关键字段类型正确(text 是 string;facts.items 是 [{label,value}];rich.segments 是 [{text}];
 *     table 支持 columns[].width 与 cell.text/cell.blocks;columns/group/collapsible 递归校验;heading.size 若给则限于 medium/large;
 *     rich.fontType 限 Default/Monospace;collapsible labels/defaultVisible/copy.label 可选)。
 * 任何字段类型错的整块**静默丢弃**(不 fail 整个构建),避免 agent 单个字段错就完全无回复。
 * 内容脱敏由 buildDisplayCard/sanitize 兜底,此处只做结构校验。
 */
/**
 * 不可信输入的结构上限 —— 防止深嵌套(RangeError 栈溢出)/超大数组(node 爆炸 → 服务端 400),
 * 与服务端 limits(max_depth≈16 / max_nodes)对齐的保守本地预检。超限静默截断,不 fail 整卡。
 */
const MAX_BLOCK_DEPTH = 12; // group/collapsible 嵌套深度
const MAX_TOTAL_BLOCKS = 200; // 整棵树累计 block 数(近似 node 上限)

export function validateDisplayBlocks(input: unknown): DisplayBlock[] {
  return validateBlockList(input, MAX_BLOCK_DEPTH, { count: 0 });
}

/** 带深度/总数预算的递归校验。深度耗尽 → 该层丢弃;总数耗尽 → 停止收集。 */
function validateBlockList(
  input: unknown,
  depth: number,
  budget: { count: number },
): DisplayBlock[] {
  if (!Array.isArray(input) || depth <= 0) return [];
  const out: DisplayBlock[] = [];
  for (const raw of input) {
    if (budget.count >= MAX_TOTAL_BLOCKS) break;
    budget.count++;
    const b = validateOneBlock(raw, depth, budget);
    if (b) out.push(b);
  }
  return out;
}

const HEADING_SIZES = new Set(["medium", "large"]);
const GROUP_STYLES = new Set(["default", "good", "warning", "attention", "emphasis"]);
const RICH_COLORS = new Set(["default", "good", "warning", "attention", "accent"]);
const FONT_TYPES = new Set(["Default", "Monospace"]);

function validateOneBlock(raw: unknown, depth: number, budget: { count: number }): DisplayBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "heading": {
      if (typeof r.text !== "string") return null;
      const size = r.size;
      const validSize = typeof size === "string" && HEADING_SIZES.has(size)
        ? size as "medium" | "large"
        : undefined;
      return validSize ? { type: "heading", text: r.text, size: validSize } : { type: "heading", text: r.text };
    }
    case "text": {
      if (typeof r.text !== "string") return null;
      return { type: "text", text: r.text };
    }
    case "rich": {
      if (!Array.isArray(r.segments)) return null;
      const segs: RichSegment[] = [];
      for (const s of r.segments) {
        if (!s || typeof s !== "object") continue;
        const seg = s as Record<string, unknown>;
        if (typeof seg.text !== "string") continue;
        const color = seg.color;
        if (color !== undefined && (typeof color !== "string" || !RICH_COLORS.has(color))) continue;
        const fontType = seg.fontType;
        if (fontType !== undefined && (typeof fontType !== "string" || !FONT_TYPES.has(fontType))) continue;
        segs.push({
          text: seg.text,
          ...(seg.bold === true ? { bold: true } : {}),
          ...(seg.subtle === true ? { subtle: true } : {}),
          ...(typeof fontType === "string" ? { fontType: fontType as RichSegment["fontType"] } : {}),
          ...(typeof color === "string" ? { color: color as RichSegment["color"] } : {}),
        });
      }
      if (segs.length === 0) return null;
      return { type: "rich", segments: segs };
    }
    case "facts": {
      if (!Array.isArray(r.items)) return null;
      const items: Fact[] = [];
      for (const it of r.items) {
        // facts.items 也计入总节点预算 —— 服务端按 fact 递归计 node,一个 facts 块可膨胀成
        // 上千节点撞 max_nodes(400)。这里连同 block 一起受 MAX_TOTAL_BLOCKS 约束,超预算即停止收集。
        if (budget.count >= MAX_TOTAL_BLOCKS) break;
        if (!it || typeof it !== "object") continue;
        const f = it as Record<string, unknown>;
        if (typeof f.label !== "string" || typeof f.value !== "string") continue;
        budget.count++;
        items.push({ label: f.label, value: f.value });
      }
      if (items.length === 0) return null;
      return { type: "facts", items };
    }
    case "table": {
      if (!Array.isArray(r.rows)) return null;
      let columns: TableColumn[] | undefined;
      if (Array.isArray(r.columns)) {
        columns = [];
        for (const col of r.columns) {
          if (!col || typeof col !== "object") continue;
          const width = (col as Record<string, unknown>).width;
          columns.push({
            ...(typeof width === "number" && Number.isFinite(width) && width > 0 ? { width } : {}),
          });
        }
        if (columns.length === 0) columns = undefined;
      }
      const rows: TableRow[] = [];
      for (const row of r.rows) {
        if (budget.count >= MAX_TOTAL_BLOCKS) break;
        if (!row || typeof row !== "object") continue;
        const rr = row as Record<string, unknown>;
        if (!Array.isArray(rr.cells)) continue;
        const cells: TableCell[] = [];
        for (const cell of rr.cells) {
          if (budget.count >= MAX_TOTAL_BLOCKS) break;
          if (!cell || typeof cell !== "object") continue;
          const cc = cell as Record<string, unknown>;
          if (Array.isArray(cc.blocks)) {
            const inner = validateBlockList(cc.blocks, depth - 1, budget);
            if (inner.length === 0) continue;
            budget.count++;
            cells.push({ blocks: inner });
            continue;
          }
          if (typeof cc.text === "string") {
            budget.count++;
            cells.push({ text: cc.text });
          }
        }
        if (cells.length > 0) {
          budget.count++;
          rows.push({ cells });
        }
      }
      if (rows.length === 0) return null;
      return {
        type: "table",
        rows,
        ...(columns ? { columns } : {}),
        ...(r.firstRowAsHeader === false ? { firstRowAsHeader: false } : {}),
      };
    }
    case "columns": {
      if (!Array.isArray(r.columns)) return null;
      const columns: Column[] = [];
      for (const col of r.columns) {
        if (budget.count >= MAX_TOTAL_BLOCKS) break;
        if (!col || typeof col !== "object") continue;
        const cc = col as Record<string, unknown>;
        const inner = validateBlockList(cc.blocks, depth - 1, budget);
        if (inner.length === 0) continue;
        budget.count++;
        columns.push({ blocks: inner });
      }
      if (columns.length === 0) return null;
      return { type: "columns", columns };
    }
    case "link": {
      if (typeof r.text !== "string" || typeof r.url !== "string") return null;
      return { type: "link", text: r.text, url: r.url };
    }
    case "group": {
      const inner = validateBlockList(r.blocks, depth - 1, budget);
      if (inner.length === 0) return null;
      const style = r.style;
      const validStyle = typeof style === "string" && GROUP_STYLES.has(style)
        ? style as GroupStyle
        : undefined;
      return validStyle
        ? { type: "group", style: validStyle, blocks: inner }
        : { type: "group", blocks: inner };
    }
    case "collapsible": {
      if (typeof r.summary !== "string") return null;
      const actionLabel = r.actionLabel;
      if (actionLabel !== undefined && typeof actionLabel !== "string") return null;
      const expandLabel = r.expandLabel;
      if (expandLabel !== undefined && typeof expandLabel !== "string") return null;
      const collapseLabel = r.collapseLabel;
      if (collapseLabel !== undefined && typeof collapseLabel !== "string") return null;
      let summarySegments: RichSegment[] | undefined;
      if (Array.isArray(r.summarySegments)) {
        summarySegments = [];
        for (const s of r.summarySegments) {
          if (!s || typeof s !== "object") continue;
          const seg = s as Record<string, unknown>;
          if (typeof seg.text !== "string") continue;
          const color = seg.color;
          if (color !== undefined && (typeof color !== "string" || !RICH_COLORS.has(color))) continue;
          const fontType = seg.fontType;
          if (fontType !== undefined && (typeof fontType !== "string" || !FONT_TYPES.has(fontType))) continue;
          summarySegments.push({
            text: seg.text,
            ...(seg.bold === true ? { bold: true } : {}),
            ...(seg.subtle === true ? { subtle: true } : {}),
            ...(typeof fontType === "string" ? { fontType: fontType as RichSegment["fontType"] } : {}),
            ...(typeof color === "string" ? { color: color as RichSegment["color"] } : {}),
          });
        }
        if (summarySegments.length === 0) summarySegments = undefined;
      }
      const inner = validateBlockList(r.blocks, depth - 1, budget);
      if (inner.length === 0) return null;
      return {
        type: "collapsible",
        summary: r.summary,
        summarySegments,
        ...(typeof actionLabel === "string" ? { actionLabel } : {}),
        ...(typeof expandLabel === "string" ? { expandLabel } : {}),
        ...(typeof collapseLabel === "string" ? { collapseLabel } : {}),
        ...(r.defaultVisible === true ? { defaultVisible: true } : {}),
        blocks: inner,
      };
    }
    case "copy": {
      if (typeof r.text !== "string") return null;
      const label = r.label;
      if (label !== undefined && typeof label !== "string") return null;
      return typeof label === "string"
        ? { type: "copy", label, text: r.text }
        : { type: "copy", text: r.text };
    }
    default:
      return null;
  }
}
