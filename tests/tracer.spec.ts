import { describe, it, expect, vi } from 'vitest';

import { Tracer } from '../src';

import type { MessageEvent, TracerEvent, Sink, TraceMiddleware } from '../src';

const isMessage = (e: TracerEvent): e is MessageEvent => e.type === 'message';

describe('Tracer basics', () => {
  it('emits a normalized message event', async () => {
    const write = vi.fn();
    const tracer = new Tracer({ sink: { write } satisfies Sink });
    await tracer.message({ role: 'user', content: 'hello' });
    expect(write).toHaveBeenCalledTimes(1);
    const ev = write.mock.calls[0][1] as TracerEvent;
    expect(isMessage(ev)).toBe(true);
    expect(ev.sessionId).toBeTruthy();
    expect(ev.ts).toBeTruthy();
    expect(ev.ctx.traceId).toBeTruthy();
    expect(ev.ctx.spanId).toBeTruthy();
    expect(ev.level).toBe('info');
  });

  it('runs middlewares sequentially and allows drops', async () => {
    const write = vi.fn();
    const mw: TraceMiddleware[] = [
      (event) => ({ ...event, level: 'error' }),
      (event) => {
        if (isMessage(event)) event.content = 'transformed';
        return event;
      },
    ];
    const tracer = new Tracer({ sink: { write } satisfies Sink, middlewares: mw });
    await tracer.message({ role: 'user', content: 'orig' });
    expect(write).toHaveBeenCalledTimes(1);
    const ev = write.mock.calls[0][1] as TracerEvent;
    expect(isMessage(ev)).toBe(true);
    expect(ev.level).toBe('error');
    expect((ev as MessageEvent).content).toBe('transformed');
  });

  it('supports a drop middleware', async () => {
    const write = vi.fn();
    const tracer = new Tracer({ sink: { write } satisfies Sink, middlewares: [() => null] });
    await tracer.message({ role: 'user', content: 'x' });
    expect(write).not.toHaveBeenCalled();
  });
});
