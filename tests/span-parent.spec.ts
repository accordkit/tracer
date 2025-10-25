import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { SpanEvent, TracerEvent } from '../src';

const isSpan = (e: TracerEvent | SpanEvent): e is SpanEvent => e.type === 'span';

describe('Span parent options', () => {
  it('accepts parent as SpanToken', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
    });

    const p = tracer.spanStart({ operation: 'A' });
    const c = tracer.spanStart({ operation: 'B', parent: p });
    await tracer.spanEnd(c);
    await tracer.spanEnd(p);

    const spans = writes.filter(isSpan);
    const child = spans.find((s) => s.operation === 'B')!;
    const parent = spans.find((s) => s.operation === 'A')!;
    expect(child.ctx.traceId).toBe(parent.ctx.traceId);
    expect(child.ctx.parentSpanId).toBe(parent.ctx.spanId);
  });

  it('accepts parent as {traceId, spanId}', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
    });

    const p = tracer.spanStart({ operation: 'A' });
    const c = tracer.spanStart({
      operation: 'B',
      parent: { traceId: p.ctx.traceId, spanId: p.ctx.spanId },
    });
    await tracer.spanEnd(c);
    await tracer.spanEnd(p);

    const spans = writes.filter(isSpan);
    const child = spans.find((s) => s.operation === 'B')!;
    const parent = spans.find((s) => s.operation === 'A')!;
    expect(child.ctx.traceId).toBe(parent.ctx.traceId);
    expect(child.ctx.parentSpanId).toBe(parent.ctx.spanId);
  });

  it('accepts parent as {ctx:{traceId, spanId}}', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const tracer = new Tracer({
      sink: {
        write: (_s, e) => {
          writes.push(e);
        },
      },
    });

    const p = tracer.spanStart({ operation: 'A' });
    const c = tracer.spanStart({
      operation: 'B',
      parent: { ctx: { traceId: p.ctx.traceId, spanId: p.ctx.spanId } },
    });
    await tracer.spanEnd(c);
    await tracer.spanEnd(p);

    const spans = writes.filter(isSpan);
    const child = spans.find((s) => s.operation === 'B')!;
    const parent = spans.find((s) => s.operation === 'A')!;
    expect(child.ctx.traceId).toBe(parent.ctx.traceId);
    expect(child.ctx.parentSpanId).toBe(parent.ctx.spanId);
  });
});
