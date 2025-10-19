import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { Tracer } from '../src/tracer';

import type {
  MessageEvent,
  Sink,
  TracerEvent,
  BufferedSink,
  TraceMiddleware,
} from '@accordkit/core';

// Type guard helper
const isMessage = (e: TracerEvent): e is MessageEvent => e.type === 'message';

class MemorySink implements Sink {
  public events: TracerEvent[] = [];

  write(_sessionId: string, e: TracerEvent) {
    this.events.push(e);
  }
}

class BufferedMemorySink implements BufferedSink {
  public events: TracerEvent[] = [];
  public flushCalls = 0;
  public closeCalls = 0;

  async write(_sessionId: string, e: TracerEvent) {
    this.events.push(e);
  }

  async flush() {
    this.flushCalls += 1;
  }

  async close() {
    this.closeCalls += 1;
  }
}

describe('Tracer', () => {
  let sink: MemorySink;

  beforeEach(() => {
    sink = new MemorySink();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456);
  });

  afterEach(() => {
    vi.useRealTimers();
    (Math.random as any).mockRestore?.();
  });

  it('emits a message event with defaults', async () => {
    const tracer = new Tracer({
      sink,
      service: 'svc',
      env: 'dev',
      region: 'eu',
    });

    await tracer.message({
      type: 'message',
      role: 'user',
      content: 'hello',
      ctx: { traceId: 'tr', spanId: 'sp' },
    } as any);

    expect(sink.events.length).toBe(1);

    const e = sink.events[0];
    if (!isMessage(e)) throw new Error('expected message event');

    expect(e.type).toBe('message');
    expect(e.role).toBe('user');
    expect(e.content).toBe('hello');
    expect(e.service).toBe('svc');
    expect(e.env).toBe('dev');
    expect(e.region).toBe('eu');
    expect(e.level).toBe('info');
    expect(e.sessionId).toBe(tracer.sessionId);
    expect(e.ctx.traceId.startsWith('tr')).toBe(true);
    expect(e.ctx.spanId.startsWith('sp')).toBe(true);
  });

  it('honors provided ctx and default level override for messages', async () => {
    const ctx = { traceId: 't', spanId: 's', parentSpanId: 'p' };
    const tracer = new Tracer({
      sink,
      defaultLevel: 'warn',
      sessionId: 'custom-session',
    });

    await tracer.message({
      role: 'assistant',
      content: 'ok',
      ctx,
    } as any);

    expect(sink.events.length).toBe(1);

    const e = sink.events[0];
    if (!isMessage(e)) throw new Error('expected message event');

    expect(e.level).toBe('warn');
    expect(e.sessionId).toBe('custom-session');
    expect(e.ctx).toBe(ctx);
  });

  it('runs middlewares sequentially and allows drops', async () => {
    const write = vi.fn();
    const mw: TraceMiddleware[] = [
      (event) => ({ ...event, level: 'error' }),
      async (event) => {
        (event as MessageEvent).content = 'transformed';
        return event;
      },
    ];
    const tracer = new Tracer({
      sink: { write } satisfies Sink,
      middlewares: mw,
    });

    await tracer.message({
      role: 'user',
      content: 'raw',
    } as any);

    expect(write).toHaveBeenCalledTimes(1);

    const [, event] = write.mock.calls[0];
    const msg = event as MessageEvent;

    expect(msg.level).toBe('error');
    expect(msg.content).toBe('transformed');

    const dropper = vi.fn().mockResolvedValue(null);
    const tracerDropping = new Tracer({
      sink: { write },
      middlewares: [dropper],
    });

    await tracerDropping.message({
      role: 'user',
      content: 'ignored',
    } as any);

    expect(dropper).toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('emits tool call, result, and usage events', async () => {
    const tracer = new Tracer({ sink });

    await tracer.toolCall({
      tool: 'weather',
      input: { city: 'AMS' },
    } as any);

    await tracer.toolResult({
      tool: 'weather',
      output: { temp: 12 },
      ok: true,
      latencyMs: 12,
    } as any);

    await tracer.usage({
      inputTokens: 10,
      outputTokens: 2,
      cost: 0.01,
    } as any);

    expect(sink.events.length).toBe(3);
    expect(sink.events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'usage']);
    expect((sink.events[1] as any).ok).toBe(true);
    expect((sink.events[1] as any).output.temp).toBe(12);
    expect((sink.events[2] as any).inputTokens).toBe(10);
  });

  it('emits span with computed duration', async () => {
    const tracer = new Tracer({ sink });
    const token = tracer.spanStart({ operation: 'db.query' });

    vi.advanceTimersByTime(42);

    await tracer.spanEnd(token);

    expect(sink.events.length).toBe(1);

    const span = sink.events[0] as any;
    expect(span.type).toBe('span');
    expect(span.operation).toBe('db.query');
    expect(span.durationMs).toBe(42);
    expect(span.status).toBe('ok');
    expect(typeof span.ts).toBe('string');
    expect(span.sessionId).toBe(tracer.sessionId);
    expect(span.level).toBeDefined();
  });

  it('merges span attributes and propagates ctx', async () => {
    const tracer = new Tracer({ sink });
    const token = tracer.spanStart({
      operation: 'call',
      attrs: { a: 1 },
    });

    vi.advanceTimersByTime(10);

    await tracer.spanEnd(token, { status: 'error', attrs: { b: 2 } });

    const span = sink.events[0] as any;
    expect(span.status).toBe('error');
    expect(span.attrs).toEqual({ a: 1, b: 2 });
    expect(span.ctx).toBe(token.ctx);
  });

  it('links child spans to parent span ids', () => {
    const tracer = new Tracer({ sink });
    const parent = tracer.spanStart({ operation: 'parent' });
    const child = tracer.spanStart({ operation: 'child', parentSpanId: parent.ctx.spanId });

    expect(child.ctx.parentSpanId).toBe(parent.ctx.spanId);
    expect(child.ctx.traceId).toMatch(/^tr_/);
    expect(child.ctx.spanId).toMatch(/^sp_/);
  });

  it('flushes buffered sinks and closes gracefully', async () => {
    const sinkWithClose = new BufferedMemorySink();
    const tracer = new Tracer({ sink: sinkWithClose });

    await tracer.flush();
    expect(sinkWithClose.flushCalls).toBe(1);

    await tracer.close();
    expect(sinkWithClose.closeCalls).toBe(1);

    const flushMock = vi.fn(async () => {});
    const sinkWithFlushOnly: BufferedSink = {
      write: vi.fn(),
      flush: flushMock,
    };
    const tracerFlushOnly = new Tracer({ sink: sinkWithFlushOnly });

    await tracerFlushOnly.close();
    expect(flushMock).toHaveBeenCalledTimes(1);
  });
});
