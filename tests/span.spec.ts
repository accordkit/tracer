import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { TracerEvent, SpanEvent, BufferedSink, Sink, TraceMiddleware } from '../src';

class FakeBufferedSink implements BufferedSink {
  public writes: Array<TracerEvent | SpanEvent> = [];
  public flushed = 0;
  public closed = 0;
  write(_sessionId: string, e: TracerEvent | SpanEvent) {
    this.writes.push(e);
  }
  async flush() {
    this.flushed += 1;
  }
  async close() {
    this.closed += 1;
  }
}

const isSpan = (e: TracerEvent | SpanEvent): e is SpanEvent => e.type === 'span';

describe('Span lifecycle', () => {
  it('propagates parent/child and sets durationMs > 0', async () => {
    const sink = new FakeBufferedSink();
    const tracer = new Tracer({ sink });

    const parent = tracer.spanStart({ operation: 'request', service: 'api', env: 'test' });
    await new Promise((r) => setTimeout(r, 5));
    const child = tracer.spanStart({ operation: 'db.query', parent });
    await new Promise((r) => setTimeout(r, 5));
    await tracer.spanEnd(child, { status: 'ok', attrs: { rows: 1 } });
    await tracer.spanEnd(parent, { status: 'ok' });

    const spans = sink.writes.filter(isSpan);
    expect(spans.length).toBe(2);
    const childSpan = spans.find((s) => s.operation === 'db.query')!;
    const parentSpan = spans.find((s) => s.operation === 'request')!;

    expect(childSpan.ctx.parentSpanId).toBeTruthy();
    expect(childSpan.ctx.traceId).toBe(parentSpan.ctx.traceId);
    expect(childSpan.durationMs).toBeGreaterThan(0);
    expect(parentSpan.durationMs).toBeGreaterThan(0);
  });

  it('middleware runs on both TracerEvent and SpanEvent', async () => {
    const sink = new FakeBufferedSink();
    const tagMw: TraceMiddleware = (e) => ({ ...e, env: 'mw-test' });
    const tracer = new Tracer({ sink, middlewares: [tagMw] });

    await tracer.message({ role: 'user', content: 'x' });
    const t = tracer.spanStart({ operation: 'op' });
    await tracer.spanEnd(t);

    const msg = sink.writes.find((e) => e.type === 'message') as TracerEvent;
    const span = sink.writes.find((e) => e.type === 'span') as SpanEvent;
    expect(msg.env).toBe('mw-test');
    expect(span.env).toBe('mw-test');
  });

  it('flush()/close() proxy when sink is buffered; no-op otherwise', async () => {
    const sink = new FakeBufferedSink();
    const tracer = new Tracer({ sink });
    await tracer.message({ role: 'user', content: 'x' });
    await tracer.flush();
    await tracer.close();
    expect(sink.flushed).toBeGreaterThanOrEqual(1);
    expect(sink.closed).toBeGreaterThanOrEqual(1);

    const writes: Array<TracerEvent | SpanEvent> = [];
    const immediate: Sink = {
      write: (_s, e) => {
        writes.push(e);
      },
    };
    const tracer2 = new Tracer({ sink: immediate });
    await tracer2.message({ role: 'user', content: 'y' });
    await expect(tracer2.flush()).resolves.toBeUndefined();
    await expect(tracer2.close()).resolves.toBeUndefined();
    expect(writes.length).toBe(1);
  });
});
