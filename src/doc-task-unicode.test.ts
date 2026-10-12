import { describe, expect, it } from 'vitest';
import { publicToolContent, type DocTaskEvent } from './doc-task-events.js';
import { DocTaskTracker } from './doc-task-progress.js';

// Explicit corpus, independent of the implementation's Unicode property regex.
// Unicode 17: Cc (except TAB/LF/CR), Cf, Default_Ignorable_Code_Point, Zl and Zp.
const omittedRanges = [
  [0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x34f, 0x34f],
  [0x600, 0x605], [0x61c, 0x61c], [0x6dd, 0x6dd], [0x70f, 0x70f], [0x890, 0x891], [0x8e2, 0x8e2],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xfff0, 0xfffb], [0x110bd, 0x110bd], [0x110cd, 0x110cd], [0x13430, 0x1343f],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff],
] as const;
const omitted = omittedRanges.flatMap(([start, end]) => Array.from({ length: end - start + 1 }, (_, i) => start + i));

async function upload(params: unknown, result: unknown): Promise<DocTaskEvent[]> {
  const events: DocTaskEvent[] = [];
  const tracker = new DocTaskTracker(async (_, batch = []) => { events.push(...batch); });
  tracker.toolStart({ toolName: 'read', toolCallId: 'unicode', params });
  tracker.toolEnd({ toolCallId: 'unicode', result });
  await tracker.finish({ finalDelivered: true });
  return events;
}

describe('task detail Unicode policy', () => {
  it.each([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad, 0x34f])(
    'redacts invisible U+%s in uploaded values and credential names', async cp => {
      const ch = String.fromCodePoint(cp);
      const events = await upload({ ['pass' + ch + 'word']: 'hunter2', sibling: 'kept' },
        { content: [{ type: 'text', text: 'sk-' + ch + 'abcdefghijklmnop' }] });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ redacted: true, truncated: false });
      expect(JSON.parse(events[0].content)).toEqual({ '[redacted key]': '[redacted]', sibling: 'kept' });
      expect(events[1]).toMatchObject({ redacted: true, content: '[redacted]' });
    },
  );

  it('removes the full enumerated control and invisible corpus from otherwise ordinary text', () => {
    expect(omitted).toHaveLength(4270);
    for (const cp of omitted) {
      expect(publicToolContent('a' + String.fromCodePoint(cp) + 'b'), 'U+' + cp.toString(16))
        .toEqual({ content: 'ab', redacted: false, truncated: false });
    }
  });

  it('redacts generated keyword and prefix splits across every policy codepoint in uploaded batches', async () => {
    const shapes = ['password', 'api_key', 'sk-abcdefghijklmnop', 'glpat-abcdefghijklmnop'];
    let checked = 0;
    // Each chunk stays below the 1000-event cap; each call finishes before step eviction.
    for (let start = 0; start < omitted.length; start += 50) {
      const uploaded: DocTaskEvent[] = [];
      const tracker = new DocTaskTracker(async (_, batch = []) => { uploaded.push(...batch); });
      for (const cp of omitted.slice(start, start + 50)) {
        for (const [i, shape] of shapes.entries()) {
          // Deterministic varying interior position, plus interleaving every boundary.
          const split = 1 + ((cp * 31 + i * 17) % (shape.length - 1));
          const ch = String.fromCodePoint(cp);
          const value = shape.slice(0, split) + ch + shape.slice(split);
          const key = [...shape].join(ch);
          const id = cp + '-' + i;
          tracker.toolStart({ toolName: 'read', toolCallId: id, params: value + '=hunter2' });
          tracker.toolEnd({ toolCallId: id, result: { nested: { [key]: 'hunter2', sibling: 'kept' } } });
        }
      }
      await tracker.finish({ finalDelivered: true });
      expect(uploaded).toHaveLength(Math.min(50, omitted.length - start) * shapes.length * 2);
      for (const event of uploaded) {
        expect(event.redacted, 'event ' + event.stepId).toBe(true);
        expect(event.content).not.toContain('hunter2');
        if (event.type === 'tool_result') {
          expect(JSON.parse(event.content)).toEqual({ nested: { '[redacted key]': '[redacted]', sibling: 'kept' } });
        } else expect(event.content).toBe('[redacted]');
        checked++;
      }
    }
    expect(checked).toBe(34160);
  });

  it('normalizes compatibility characters before detection while preserving ordinary readable text', async () => {
    const events = await upload({ 'ｐａｓｓｗｏｒｄ': 'hunter2', sibling: 'kept' }, { output: 'ｓｋ－abcdefghijklmnop' });
    expect(JSON.parse(events[0].content)).toEqual({ '[redacted key]': '[redacted]', sibling: 'kept' });
    expect(events[1]).toMatchObject({ content: '[redacted]', redacted: true });
    for (const text of ['中文段落\n第二行\t缩进\r\n结束', 'Résumé — Привет — مرحبا', '报告已更新 😀']) {
      expect(publicToolContent(text)).toEqual({ content: text, truncated: false, redacted: false });
    }
    expect(publicToolContent('cafe\u034f\u0301 Ａ①')).toEqual({ content: 'café A1', truncated: false, redacted: false });
  });
});
