import { describe, it, expect } from 'vitest';

import { Tracer } from '../src';

import type { TracerEvent, SpanEvent, BufferedSink, Sink } from '../src';

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

describe('Sink behavior', () => {
  it('flush/close idempotency', async () => {
    const sink = new FakeBufferedSink();
    const tracer = new Tracer({ sink });
    await tracer.message({ role: 'user', content: 'x' });
    await tracer.flush();
    await tracer.flush();
    await tracer.close();
    await tracer.close();
    expect(sink.flushed).toBeGreaterThanOrEqual(1);
    expect(sink.closed).toBeGreaterThanOrEqual(1);
  });

  it('immediate sink works and flush/close are no-ops', async () => {
    const writes: Array<TracerEvent | SpanEvent> = [];
    const immediate: Sink = {
      write: (_s, e) => {
        writes.push(e);
      },
    };
    const tracer = new Tracer({ sink: immediate });
    await tracer.message({ role: 'user', content: 'x' });
    await tracer.flush();
    await tracer.close();
    expect(writes.length).toBe(1);
  });
});
