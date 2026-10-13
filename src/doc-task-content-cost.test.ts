import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { containsPrivateSchemelessUrl } from './card-render.js';
import { publicToolContent } from './doc-task-events.js';

describe('uploaded preview scan budgets', () => {
  it.each([4000, 16000, 65536])('bounds dot-dense scanning at %i characters', size => {
    const value = 'a.'.repeat(size / 2);
    const started = performance.now();
    expect(containsPrivateSchemelessUrl(value)).toBe(false);
    const result = publicToolContent(value);
    // A generous absolute bound, not a comparison against a loaded peer process.
    // Old 64K upload + matcher takes seconds; bounded scans take milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.redacted).toBe(false);
    expect(result.truncated).toBe(size > 4096);
  }, 30_000);
  it.each(['/', ':@'])('withholds oversized candidates even without a complete match: %s', suffix => {
    expect(containsPrivateSchemelessUrl('.'.repeat(4000) + suffix)).toBe(true);
    expect(publicToolContent('.'.repeat(65530) + suffix)).toMatchObject({ content: '[redacted]', redacted: true });
  });
  it('withholds long URL candidates, including credentials beyond the scan boundary', () => {
    const value = 'a.'.repeat(3000) + ':private-value@localhost';
    expect(publicToolContent(value)).toMatchObject({ content: '[redacted]', redacted: true });
    const object = publicToolContent({ [value]: 'hidden', sibling: 'kept' });
    expect(object.content).not.toContain('hidden');
    expect(object.content).toContain('kept');
    expect(publicToolContent('normal '.repeat(9000))).toMatchObject({ redacted: false, truncated: true });
  });
});
