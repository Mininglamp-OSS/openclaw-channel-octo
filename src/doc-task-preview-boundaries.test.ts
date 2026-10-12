import { describe, expect, it, vi } from 'vitest';
import { publicToolContent, type DocTaskEvent } from './doc-task-events.js';
import { DocTaskTracker } from './doc-task-progress.js';

describe('uploaded preview boundaries', () => {
  it.each([
    { files: ['a.md', '/tmp/b.md'] },
    { matches: [{ file: 'README.md', line: 3 }, { file: '/srv/x.ts', line: 9 }] },
    { matches: [{ file: 'README.md', line: 3 }, { file: 'src/x.ts', line: 9 }] },
    { stdout: 'total 8 … README.md', cwd: '/srv/app' },
    { host: 'api.example.com', path: '/users/42' },
    { directoryPath: '/usr/local/share/project' },
  ])('preserves independent JSON paths in tool inputs and results: %j', async value => {
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_snapshot, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'paths', params: value });
    tracker.toolEnd({ toolCallId: 'paths', result: value });
    await tracker.finish({ finalDelivered: true });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ redacted: false, truncated: false });
      expect(JSON.parse(event.content)).toEqual(JSON.parse(JSON.stringify(value).normalize('NFKC')));
    }
  });

  it.each([
    { AKIAIOSFODNN: '7EXAMPLE' },
    { nested: { 'AKIAIOSF\u200bODNN': '7EXAMPLE' }, sibling: 'kept' },
    { 'admin:sup3rs3cr3tp4ss': '@db.internal.corp/prod', sibling: 'kept' },
  ])('withholds recognized credentials split across a key and its value: %j', async value => {
    const events: DocTaskEvent[] = [];
    const tracker = new DocTaskTracker(async (_snapshot, batch = []) => { events.push(...batch); });
    tracker.toolStart({ toolName: 'read', toolCallId: 'key-value', params: value });
    tracker.toolEnd({ toolCallId: 'key-value', result: value });
    await tracker.finish({ finalDelivered: true });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.redacted).toBe(true);
      expect(event.content).not.toMatch(/AKIAIOSF|7EXAMPLE|sup3rs3cr3tp4ss|db.internal.corp/);
    }
  });

  it('still hides a private host/path contained in one field', () => {
    expect(publicToolContent({ url: 'api.example.com/users/42' }).redacted).toBe(true);
  });

  it('bounds descriptor reads across a numeric tree, not just string characters', () => {
    const tree = Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => Array(100).fill(0)));
    const read = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    try {
      expect(publicToolContent(tree).truncated).toBe(true);
      expect(read.mock.calls.length).toBeLessThan(5000);
    } finally { read.mockRestore(); }
  });

  it('does not copy all descriptors before the per-record limit', () => {
    const wide = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [`field${i}`, i]));
    const all = vi.spyOn(Object, 'getOwnPropertyDescriptors');
    const read = vi.spyOn(Object, 'getOwnPropertyDescriptor');
    let result;
    let allCalls = 0, reads = 0;
    try {
      result = publicToolContent(wide);
      allCalls = all.mock.calls.length; reads = read.mock.calls.length;
    } finally { all.mockRestore(); read.mockRestore(); }
    expect(result.truncated).toBe(true);
    expect(allCalls).toBe(0);
    expect(reads).toBeLessThan(110);
  });

  it('charges raw property names to the aggregate character budget', () => {
    const value = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`${'name '.repeat(200)}${i}`, 'small']));
    const result = publicToolContent(value);
    expect(result).toMatchObject({ content: '[omitted: size limit]', truncated: true });
  });
});
