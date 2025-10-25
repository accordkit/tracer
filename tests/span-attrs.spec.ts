import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { SpanEvent, TracerEvent } from '../src';

const isSpan = (e: TracerEvent | SpanEvent): e is SpanEvent => e.type === 'span';

describe('Span attribute merge & status', () => {
  it('merges attrs with end overriding start', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
    });

    const t = tracer.spanStart({ operation: 'op', attrs: { a: 1, keep: true } });
    await tracer.spanEnd(t, { attrs: { a: 2, b: 3 } });

    const span = writes.find(isSpan) as SpanEvent;
    expect(span.attrs?.a).toBe(2);
    expect(span.attrs?.b).toBe(3);
    expect(span.attrs?.keep).toBe(true);
  });

  it('captures status=error when provided', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
    });

    const t = tracer.spanStart({ operation: 'op' });
    await tracer.spanEnd(t, { status: 'error' });
    const span = writes.find(isSpan) as SpanEvent;
    expect(span.status).toBe('error');
  });
});
