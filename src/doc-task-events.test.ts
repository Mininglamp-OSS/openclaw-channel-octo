import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { publicToolContent, toolResultContent, type DocTaskEvent } from './doc-task-events.js';
import { DocTaskTracker, type DocTaskProgress } from './doc-task-progress.js';

describe('public task details', () => {
  it.each([
    { part1: 'AKIAIOSFODNN', part2: '7EXAMPLE' },
    { prelude: 'ordinary '.repeat(600), part1: 'AKIAIOSFODNN', part2: '7EXAMPLE' },
    { user: 'admin:sup3rs3cr3tp4ss', host: '@db.internal.corp/prod' },
    ['admin:sup3rs3cr3tp4ss', '@db.internal.corp/prod'],
    { a: { user: 'admin:sup3rs3cr3tp4ss' }, b: { host: '@db.internal.corp/prod' } },
  ])('redacts credentials spanning JSON textual leaves: %j', async value => {
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_snapshot, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'json-split', params: value });
    tracker.toolEnd({ toolCallId: 'json-split', result: value });
    await tracker.finish({ finalDelivered: true });
    expect(events).toHaveLength(2);
    expect(events.every(event => event.content === '[redacted]' && event.redacted)).toBe(true);
  });
  it('withholds aggregate normalized text that exceeds the scan budget', () => {
    const expanded = '\ufdfa'.repeat(2000);
    expect(publicToolContent({ a: expanded }).redacted).toBe(false);
    expect(publicToolContent({ a: expanded, b: expanded })).toMatchObject({ content: '[omitted: size limit]', truncated: true });
  });
  it('keeps ordinary JSON structure while scanning bounded textual leaves', () => {
    const value = { first: '普通内容', second: 'visible prose', list: [7, false, null, 'next line'] };
    const result = publicToolContent(value);
    expect(JSON.parse(result.content)).toEqual(value);
    expect(result).toMatchObject({ redacted: false, truncated: false });
    expect(publicToolContent({ a: 'AKIAIOSFODNN' }).redacted).toBe(false);
    expect(publicToolContent({ b: '7EXAMPLE' }).redacted).toBe(false);
  });

  it.each([120, 121, 144])('marks shortened keys in uploaded tool input at %i characters', async length => {
    const key = 'descriptive field '.repeat(10).slice(0, length);
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_snapshot, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'key-length', params: { [key]: 'kept' } });
    await tracker.finish({ finalDelivered: true });
    expect(events[0]).toMatchObject({ type: 'tool_use', truncated: length > 120, redacted: false });
    expect(JSON.parse(events[0].content)).toEqual({ [key.slice(0, 120)]: 'kept' });
  });

  it.each(['pass\u0000word=abcd', 'api_\u0007key=abcd', 'sk-\u001b12345678901234567890', 'https:/\u007f/alice:pass@example.com/a'])(
    'redacts normalized credential bytes: %j', value => {
      expect(publicToolContent(value)).toMatchObject({ content: '[redacted]', redacted: true });
    },
  );
  it('accepts foreign-realm plain JSON and explicitly omits class and host objects', () => {
    const value = runInNewContext('({ command: "date", count: 0, nested: { values: [false, null] } })');
    const clean = publicToolContent(value);
    expect(JSON.parse(clean.content)).toEqual({ command: 'date', count: 0, nested: { values: [false, null] } });
    expect(clean.truncated).toBe(false);
    expect(JSON.parse(publicToolContent(runInNewContext('Object.assign(Object.create(null), { count: 0 })')).content)).toEqual({ count: 0 });
    for (const rejected of [new Date(), Buffer.from('data'), new Error('private'), new (class Host {})(),
      runInNewContext('new (class Host {})()'), runInNewContext('new Date()'), new Proxy({}, {})]) {
      expect(publicToolContent(rejected)).toMatchObject({ content: '[omitted: non-JSON value]', truncated: true });
    }
    const accessor = { get count() { throw new Error('must not execute'); } };
    expect(publicToolContent(accessor)).toMatchObject({ content: '{\n  "count": "[omitted: accessor]"\n}', truncated: true });
    expect(publicToolContent({ ['pass\u0000word']: 'abcd' })).toMatchObject({ redacted: true });
    expect(publicToolContent({ ['pass\u0000word']: 'abcd' }).content).not.toContain('abcd');
  });
  it('keeps JSON input and plain tool output while excluding secrets and media', () => {
    expect(publicToolContent({ command: 'sleep 6 && date', count: 0 }).content).toBe('{\n  "command": "sleep 6 && date",\n  "count": 0\n}');
    const secret = publicToolContent({ command: 'date', password: 'private', headers: { auth: 'private' }, nested: { x: 'Bearer private-token' } });
    expect(secret.redacted).toBe(true); expect(secret.content).not.toContain('private');
    expect(publicToolContent('https://alice:pass@example.com/a').redacted).toBe(true);
    const output = toolResultContent({ content: [{ type: 'image', data: 'private' }, { type: 'text', text: 'Thursday' }] });
    expect(output.detail).toMatchObject({ content: 'Thursday', truncated: true });
    expect(publicToolContent('sk-12345678901234567890').content).toBe('[redacted]');
  });
  it('marks long content and bounded traversal without leaking a split secret', () => {
    expect(publicToolContent('a '.repeat(3000))).toMatchObject({ truncated: true });
    const result = publicToolContent('a '.repeat(2040) + 'Bearer private');
    expect(result).toMatchObject({ redacted: true, content: '[redacted]' });
    expect(publicToolContent('a'.repeat(100000))).toMatchObject({ truncated: true });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(publicToolContent(cycle).truncated).toBe(true);
  });
  it.each([
    'sk-abcdefghijklmnopqrst', 'glpat-abcdefghijklmnopqrst',
    'https://alice:pass@example.com/a', 'a1'.repeat(32),
    '-----BEGIN PRIVATE KEY-----', 'sk-\u0000abcdefghijklmnopqrst',
    'https:/\u007f/alice:pass@example.com/a',
  ])('redacts credential names in uploaded input and output: %j', async rawKey => {
    const params = { [rawKey]: 'private-value', sibling: 'kept' };
    const result = runInNewContext('JSON.parse(json)', { json: JSON.stringify({ nested: params }) });
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'key', params });
    tracker.toolEnd({ toolCallId: 'key', result });
    await tracker.finish({ finalDelivered: true });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.redacted).toBe(true);
      expect(event.content).not.toContain(rawKey.replace(/[\u0000\u007f]/g, ''));
      expect(event.content).not.toContain('private-value');
      expect(event.content).toContain('"[redacted key]": "[redacted]"');
      expect(event.content).toContain('"sibling": "kept"');
    }
  });
  it.each([
    'alice:hunter2@db.example.com:5432/mydb',
    'alice:p/a@s@s@localhost:5432/db',
    'alice:hunter2@[::1]:5432/db',
    'alice:hunter2@数据库:5432/db',
    'example.com/private-webhook',
  ])('redacts schemeless private URLs in uploaded keys, values, results and errors: %s', async secret => {
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'dsn', params: { [secret]: 'hidden-value', value: secret, sibling: 'kept' } });
    tracker.toolEnd({ toolCallId: 'dsn', result: { text: secret }, error: new Error(secret) });
    await tracker.finish({ finalDelivered: false });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.redacted).toBe(true);
      expect(event.content).not.toContain(secret);
      expect(event.content).not.toContain('hidden-value');
    }
    expect(events[0].content).toContain('"sibling": "kept"');
    expect(events[0].content).toContain('"value": "[redacted]"');
  });
  it('never executes proxy traps or getters anywhere on the uploaded tool path', async () => {
    const accessed = vi.fn(() => 'accessor-leak');
    const trap = vi.fn(() => 'proxy-leak');
    const proxy = (target: object) => new Proxy(target, {
      get(target, key, receiver) { trap(); return Reflect.get(target, key, receiver); },
      getPrototypeOf(target) { trap(); return Reflect.getPrototypeOf(target); },
      ownKeys(target) { trap(); return Reflect.ownKeys(target); },
    });
    const indexed: unknown[] = [];
    Object.defineProperty(indexed, 0, { enumerable: true, get: accessed });
    indexed.push({ type: 'text', text: 'safe sibling' });
    const fixtures = [
      proxy({ text: 'proxy-text-leak' }),
      new (class Result { output = 'class-output-leak'; })(),
      { get text() { return accessed(); } },
      { get output() { return accessed(); } },
      { get content() { accessed(); return []; } },
      { text: 'safe sibling', get details() { accessed(); return {}; } },
      { text: 'safe sibling', details: { get exitCode() { accessed(); return 2; } } },
      { text: 'safe sibling', get isError() { accessed(); return true; } },
      { content: proxy([{ type: 'text', text: 'proxy-array-leak' }]) },
      { content: [proxy({ type: 'text', text: 'proxy-block-leak' })] },
      { content: [new (class Block { type = 'text'; text = 'class-block-leak'; })()] },
      { content: [{ get type() { accessed(); return 'text'; }, text: 'safe sibling' }] },
      { content: [{ type: 'text', get text() { return accessed(); } }] },
      { content: indexed },
      { nested: { get value() { return accessed(); } } },
    ];
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
    try {
      for (let i = 0; i < fixtures.length; i++) {
        tracker.toolStart({ toolName: 'read', toolCallId: String(i), params: fixtures[i] });
        tracker.toolEnd({ toolCallId: String(i), result: fixtures[i] });
      }
    } finally { await tracker.finish({ finalDelivered: true }); }
    expect(accessed).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(events).toHaveLength(fixtures.length * 2);
    for (const event of events) {
      expect(event.truncated).toBe(true);
      expect(event.content).not.toContain('-leak');
    }
    expect(events[27].content).toContain('safe sibling');
  });
  it('does not read Error message accessors or proxy errors when uploading failures', async () => {
    const accessed = vi.fn(() => 'message-leak');
    const error = new Error('unused');
    Object.defineProperty(error, 'message', { get: accessed });
    const proxyError = new Proxy(new Error('proxy-error-leak'), { get: accessed, getPrototypeOf() { accessed(); return Error.prototype; } });
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
    try {
      for (const [i, failure] of [error, proxyError].entries()) {
        tracker.toolStart({ toolName: 'read', toolCallId: String(i) });
        tracker.toolEnd({ toolCallId: String(i), error: failure });
      }
    } finally { await tracker.finish({ finalDelivered: false }); }
    expect(accessed).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'error')).toHaveLength(2);
    for (const event of events.filter(e => e.type === 'error')) {
      expect(event).toMatchObject({ truncated: true, failed: true });
      expect(event.content).not.toContain('-leak');
    }
  });
  it('preserves foreign JSON, text blocks and exit status while ignoring non-enumerable fields', async () => {
    const params = runInNewContext('({ command: "date", values: [false, null, 0], sibling: "kept" })');
    Object.defineProperty(params, 'internalNote', { value: 'hidden-note-leak', enumerable: false });
    const result = runInNewContext('({ content: [{ type: "text", text: "ordinary output" }], details: { exitCode: 2 } })');
    Object.defineProperty(result, 'internalNote', { value: 'hidden-note-leak', enumerable: false });
    const fallback = Object.defineProperty({ sibling: 'kept' }, 'internalNote', { value: 'hidden-note-leak', enumerable: false });
    const events: DocTaskEvent[] = [], snapshots: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async (snapshot, batch = []) => { events.push(...batch); snapshots.push(snapshot); });
    for (const [i, output] of [result, fallback, { text: 'fine', exitCode: 0 }, { output: 'failed', isError: true }].entries()) {
      tracker.toolStart({ toolName: 'read', toolCallId: String(i), params });
      tracker.toolEnd({ toolCallId: String(i), result: output });
    }
    await tracker.finish({ finalDelivered: true });
    expect(JSON.parse(events[0].content)).toEqual({ command: 'date', values: [false, null, 0], sibling: 'kept' });
    expect(events[1]).toMatchObject({ content: 'ordinary output', truncated: false, redacted: false, failed: true });
    expect(JSON.parse(events[3].content)).toEqual({ sibling: 'kept' });
    expect(events[5]).toMatchObject({ content: 'fine', failed: false });
    expect(events[7]).toMatchObject({ content: 'failed', failed: true });
    expect(snapshots.at(-1)?.steps).toMatchObject([
      { state: 'failed', exitCode: 2 }, { state: 'finished' }, { state: 'finished', exitCode: 0 }, { state: 'failed' },
    ]);
    expect(JSON.stringify(events)).not.toContain('hidden-note-leak');
  });
  it('keeps safe failure metadata when display content exceeds its budget', async () => {
    const events: DocTaskEvent[] = [], snapshots: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async (snapshot, batch = []) => { events.push(...batch); snapshots.push(snapshot); });
    const manyFields = Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['field' + i, i]));
    for (const [i, result] of [
      { output: 'x'.repeat(100000), details: { exitCode: 2 } },
      { ...manyFields, isError: true },
    ].entries()) {
      tracker.toolStart({ toolName: 'exec', toolCallId: String(i) });
      tracker.toolEnd({ toolCallId: String(i), result });
    }
    await tracker.finish({ finalDelivered: true });
    expect(snapshots.at(-1)?.steps).toMatchObject([{ state: 'failed', exitCode: 2 }, { state: 'failed' }]);
    for (const event of events.filter(e => e.type === 'tool_result')) expect(event).toMatchObject({ truncated: true, failed: true });
  });
  it.each(['root', 'details', 'meta', 'metadata', 'summary'])('reads own exit-status aliases in %s', async container => {
    const snapshots: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async p => { snapshots.push(p); });
    for (const field of ['exitCode', 'exit_code', 'code']) {
      const metadata = { [field]: 2 };
      const result = container === 'root' ? metadata : { [container]: metadata };
      tracker.toolStart({ toolName: 'exec', toolCallId: field });
      tracker.toolEnd({ toolCallId: field, result: runInNewContext('JSON.parse(json)', { json: JSON.stringify(result) }) });
    }
    await tracker.finish({ finalDelivered: true });
    expect(snapshots.at(-1)?.steps).toMatchObject(Array.from({ length: 3 }, () => ({ state: 'failed', exitCode: 2 })));
  });
  it('keeps generic business codes out of exit status and skips unsafe metadata', async () => {
    const accessed = vi.fn(() => 2);
    const proxy = new Proxy({ exit_code: 2 }, { get: accessed, getPrototypeOf() { accessed(); return Object.prototype; } });
    const snapshots: DocTaskProgress[] = [];
    const tracker = new DocTaskTracker(async p => { snapshots.push(p); });
    const results = [
      { code: 200, summary: { code: 200 } },
      { details: { get exit_code() { return accessed(); } }, meta: { exitCode: 2 } },
      { metadata: proxy, summary: { exit_code: 3 } },
      { meta: { isError: true } },
    ];
    for (const [i, result] of results.entries()) {
      tracker.toolStart({ toolName: 'read', toolCallId: String(i) });
      tracker.toolEnd({ toolCallId: String(i), result });
    }
    await tracker.finish({ finalDelivered: true });
    expect(snapshots.at(-1)?.steps).toMatchObject([{ state: 'finished' }, { state: 'failed', exitCode: 2 }, { state: 'failed', exitCode: 3 }, { state: 'failed' }]);
    expect(snapshots.at(-1)?.steps[0].exitCode).toBeUndefined();
    expect(accessed).not.toHaveBeenCalled();
  });
  it.each([
    ['AKIA', 'IOSVODSTI1234567'], ['sk-', 'abcdefghijklmnopqrst'],
    ['ghp_', 'abcdefghijklmnopqrst'], ['glpat-', 'abcdefghijklmnopqrst'],
    ['xoxb-', '1234567890abcdef'], ['pass', 'word=plain-value'],
  ])('redacts credentials assembled across individually clean text blocks: %s', async (prefix, tail) => {
    expect(publicToolContent(prefix).redacted).toBe(false);
    expect(publicToolContent(tail).redacted).toBe(false);
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'split' });
    tracker.toolEnd({ toolCallId: 'split', result: { content: [
      { type: 'text', text: prefix }, { type: 'text', text: tail },
    ] } });
    await tracker.finish({ finalDelivered: true });
    expect(events[1]).toMatchObject({ type: 'tool_result', content: '[redacted]', redacted: true });
  });
  it('preserves display newlines in ordinary multi-block results', () => {
    expect(toolResultContent({ content: [
      { type: 'text', text: 'First line' }, { type: 'text', text: '第二行' },
    ] }).detail).toEqual({ content: 'First line\n第二行', truncated: false, redacted: false });
  });
  it('pairs concurrent same-name tools, retries immutable events and flushes all final batches', async () => {
    const accepted: DocTaskEvent[] = [], snapshots: DocTaskProgress[] = [];
    let rejected = false;
    const tracker = new DocTaskTracker(async (progress, events = []) => {
      snapshots.push(progress);
      if (events.length && !rejected) { rejected = true; throw new Error('temporary'); }
      accepted.push(...structuredClone(events));
    });
    for (let i = 0; i < 12; i++) tracker.toolStart({ toolName: 'exec', toolCallId: String(i), params: { command: 'echo ' + i } });
    for (let i = 11; i >= 0; i--) tracker.toolEnd({ toolCallId: String(i), result: { content: [{ type: 'text', text: 'result ' + i }] } });
    await tracker.finish({ finalDelivered: true });
    expect(accepted).toHaveLength(24);
    expect(accepted.map(e => e.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(accepted[0]).toMatchObject({ stepId: 'call-1', type: 'tool_use' });
    expect(accepted[12]).toMatchObject({ stepId: 'call-12', type: 'tool_result', content: 'result 11' });
    expect(snapshots.at(-1)).toMatchObject({ eventCount: 24, phase: 'ended' });
    expect(snapshots.every(p => !JSON.stringify(p).includes('echo'))).toBe(true);
  });
  it('records readable failures without Error stacks, and bounds total event storage', async () => {
    const events: DocTaskEvent[] = []; let last: DocTaskProgress | undefined;
    const tracker = new DocTaskTracker(async (p, batch = []) => { last = p; events.push(...batch); });
    tracker.toolStart({ toolName: 'exec', toolCallId: 'failed', params: { command: 'exit 2' } });
    tracker.toolEnd({ toolCallId: 'failed', result: { text: 'failed', exitCode: 2 }, error: new Error('command failed') });
    for (let i = 0; i < 1010; i++) tracker.toolStart({ toolName: 'exec', toolCallId: String(i) });
    await tracker.finish({ finalDelivered: true });
    expect(events[2]).toMatchObject({ type: 'error', content: 'command failed', failed: true });
    expect(events).toHaveLength(1000);
    expect(last).toMatchObject({ eventCount: 1000, detailsTruncated: true });
  });
});
