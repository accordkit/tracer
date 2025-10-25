import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { TracerEvent, SpanEvent, Sink } from '../src';

describe('Flood smoke test', () => {
  it('handles many events without throwing', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      } satisfies Sink,
    });

    for (let i = 0; i < 100; i++) {
      await tracer.message({ role: 'user', content: 'm' + i });
      const t = tracer.spanStart({ operation: 'op' + i });
      await tracer.spanEnd(t);
    }

    expect(writes.length).toBeGreaterThanOrEqual(200); // 100 messages + 100 spans
  });
});
