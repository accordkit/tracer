import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { TracerEvent, SpanEvent, TraceMiddleware } from '../src';

describe('Middleware behavior', () => {
  it('can drop only spans', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const dropSpans: TraceMiddleware = (e) => (e.type === 'span' ? null : e);
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
      middlewares: [dropSpans],
    });

    await tracer.message({ role: 'user', content: 'x' });
    const t = tracer.spanStart({ operation: 'op' });
    await tracer.spanEnd(t);

    expect(writes.find((e) => e.type === 'message')).toBeTruthy();
    expect(writes.find((e) => e.type === 'span')).toBeFalsy();
  });

  it('applies service/env/region tags from tracer options', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
      service: 'svc',
      env: 'dev',
      region: 'eu',
    });

    await tracer.message({ role: 'user', content: 'x' });
    const t = tracer.spanStart({ operation: 'op' });
    await tracer.spanEnd(t);

    for (const ev of writes) {
      expect(ev.service).toBe('svc');
      expect(ev.env).toBe('dev');
      expect(ev.region).toBe('eu');
    }
  });
});
