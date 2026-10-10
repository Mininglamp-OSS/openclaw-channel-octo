import { containsPrivateSchemelessUrl, isSensitive } from './card-render.js';
import { types } from 'node:util';

// Preview policy: discard Unicode controls, format/default-ignorable codepoints
// and line/paragraph separators; preserve TAB/LF/CR for ordinary layout. NFKC
// folds compatibility forms (e.g. full-width credential names). Remove invisible
// composition barriers before normalizing, then detect on these exact bytes.
const nonDisplayCodePoints = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/gu;
const normalizeText = (value: string): string => value.replace(nonDisplayCodePoints, '').normalize('NFKC');
const isPrivateText = (text: string): boolean => isSensitive(text, true) || containsPrivateSchemelessUrl(text) || /-----BEGIN [^\r\n]{0,64}PRIVATE KEY|:\/\/[^\s/]*@/i.test(text);
const objectConstructorSource = Function.prototype.toString.call(Object);
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (types.isProxy(prototype) || Object.getPrototypeOf(prototype) !== null) return false;
  // Foreign-realm Object.prototype has a different identity, but the same
  // native Object constructor. Class instances and host prototypes fail here.
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  return typeof constructor === 'function' && Function.prototype.toString.call(constructor) === objectConstructorSource;
}

export interface DocTaskEvent {
  seq: number; stepId: string; tool: string; type: 'tool_use' | 'tool_result' | 'error';
  content: string; at: number; truncated: boolean; redacted: boolean; failed: boolean;
}
export type PublicToolContent = Pick<DocTaskEvent, 'content' | 'truncated' | 'redacted'>;
type CleanValue = { value: unknown; truncated: boolean; redacted: boolean };

/** Copy only own enumerable data without invoking source accessors or methods. */
function scrubToolValue(value: unknown): CleanValue {
  let truncated = false, redacted = false, budget = 65536;
  const seen = new WeakSet<object>();
  const scrub = (v: unknown, depth = 0): unknown => {
    if (typeof v === 'string') {
      budget -= v.length;
      if (v.length > 65536 || budget < 0) { truncated = true; return '[omitted: size limit]'; }
      const text = normalizeText(v);
      if (isPrivateText(text)) { redacted = true; return '[redacted]'; }
      return text;
    }
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (!v || typeof v !== 'object') return undefined;
    if (types.isProxy(v)) { truncated = true; return '[omitted: non-JSON value]'; }
    if (depth >= 6 || seen.has(v) || budget < 0) { truncated = true; return '[omitted]'; }
    seen.add(v);
    const read = (descriptor: PropertyDescriptor | undefined): unknown => {
      if (!descriptor) return undefined;
      if (!('value' in descriptor)) { truncated = true; return '[omitted: accessor]'; }
      return scrub(descriptor.value, depth + 1);
    };
    if (Array.isArray(v)) {
      // slice/map on the source would execute indexed getters or subclass hooks.
      const length = Object.getOwnPropertyDescriptor(v, 'length')!.value as number;
      if (length > 100) truncated = true;
      return Array.from({ length: Math.min(length, 100) }, (_, i) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
        return descriptor?.enumerable ? read(descriptor) : undefined;
      });
    }
    if (!isPlainRecord(v)) { truncated = true; return '[omitted: non-JSON value]'; }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(v)).filter(([, descriptor]) => descriptor.enumerable);
    if (entries.length > 100) truncated = true;
    return Object.fromEntries(entries.slice(0, 100).map(([rawKey, descriptor]) => {
      const key = normalizeText(rawKey);
      if (isPrivateText(key) || /^(env|headers|cookie|set-cookie)$/i.test(key)) {
        redacted = true; return ['[redacted key]', '[redacted]'];
      }
      if (key.length > 120) truncated = true;
      return [key.slice(0, 120), read(descriptor)];
    }));
  };
  try { return { value: scrub(value), truncated, redacted }; }
  catch { return { value: '[omitted: unreadable value]', truncated: true, redacted }; }
}

/** Only traverses the plain-data copy, never the source objects. Structural
 * separators must not hide credentials split across adjacent textual values. */
function joinedPreviewText(value: unknown): string | undefined {
  const parts: string[] = [];
  let length = 0;
  const visit = (v: unknown): void => {
    if (length > 65536) return;
    if (typeof v === 'string') { length += v.length; if (length <= 65536) parts.push(v); }
    else if (v && typeof v === 'object') {
      for (const child of Object.values(v)) { visit(child); if (length > 65536) break; }
    }
  };
  visit(value);
  return length > 65536 ? undefined : parts.join('');
}

function formatContent(clean: CleanValue, fragments: unknown = clean.value): PublicToolContent {
  let { value, truncated, redacted } = clean;
  const joined = joinedPreviewText(fragments);
  // Scan both semantic concatenation and display text before any display cut.
  // The aggregate bound also covers normalization expansion and omission markers.
  if (joined === undefined || (typeof value === 'string' && value.length > 65536)) {
    value = '[omitted: size limit]'; truncated = true;
  } else if (isPrivateText(joined) || (typeof value === 'string' && value !== joined && isPrivateText(value))) {
    value = '[redacted]'; redacted = true;
  }
  let content = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (content.length > 4096) { content = content.slice(0, 4096); truncated = true; }
  return { content, truncated, redacted };
}

/** Reduce before upload. Never serialize host objects, binary/media blocks, or error stacks. */
export function publicToolContent(value: unknown): PublicToolContent {
  return formatContent(scrubToolValue(value));
}

// Metadata must survive display size/depth limits, but use the same source
// guards. Reading exitCode from the original result with ?. would run getters.
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || types.isProxy(value) || !isPlainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && 'value' in descriptor ? descriptor.value : undefined;
}

export function toolResultContent(result: unknown, toolName?: string): { detail: PublicToolContent; isError: boolean; exitCode?: number } {
  const clean = scrubToolValue(result);
  let textFragments: string[] | undefined;
  // Only descriptor-backed primitive metadata may influence the step status.
  const r = clean.value && typeof clean.value === 'object' && !Array.isArray(clean.value)
    ? clean.value as Record<string, unknown> : undefined;
  // Match the card sink's containers/spellings without reading accessors. A
  // generic `code` is a process exit only for command tools, not e.g. HTTP 200.
  const records = [result, ...['details', 'meta', 'metadata', 'summary'].map(key => ownData(result, key))];
  const keys = ['exitCode', 'exit_code', ...(['exec', 'bash', 'shell', 'process'].includes(toolName ?? '') ? ['code'] : [])];
  let exitCode: number | undefined;
  for (const record of records) {
    for (const key of keys) {
      const value = ownData(record, key);
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647) { exitCode = value; break; }
    }
    if (exitCode !== undefined) break;
  }
  const isError = records.some(record => ownData(record, 'isError') === true);
  if (Array.isArray(r?.content)) {
    const text: string[] = [];
    for (const block of r.content) {
      if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      else clean.truncated = true;
    }
    textFragments = text;
    clean.value = text.join('\n');
  } else if (typeof r?.text === 'string') clean.value = r.text;
  else if (typeof r?.output === 'string') clean.value = r.output;
  return { detail: formatContent(clean, textFragments ?? clean.value), isError, exitCode };
}

export function publicToolError(error: unknown): PublicToolContent {
  if (error && typeof error === 'object' && !types.isProxy(error) && types.isNativeError(error)) {
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    if (message && 'value' in message && typeof message.value === 'string') return publicToolContent(message.value);
  }
  return publicToolContent(error);
}
