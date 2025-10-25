import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { HttpSink } from '../src/core/sinks/httpSink';

import type { MessageEvent } from '../src/core/types';

function event(i: number): MessageEvent {
  return {
    ts: new Date(0 + i).toISOString(),
    sessionId: 's3',
    level: 'info',
    type: 'message',
    role: 'user',
    content: 'hi ' + i,
    ctx: { traceId: 'tr3', spanId: 'sp' + i },
  };
}

describe('HttpSink', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('batches events and posts on threshold', async () => {
    const sink = new HttpSink({ endpoint: 'https://example.test/ingest', batchSize: 2 });
    await sink.write('s3', event(1));
    expect((globalThis as any).fetch).not.toHaveBeenCalled();
    await sink.write('s3', event(2));
    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis as any).fetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.sessionId).toBe('s3');
    expect(body.events.length).toBe(2);
  });
});

describe('HttpSink buffered', () => {
  beforeEach(() => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('batches by batchSize and posts once', async () => {
    const sink = new HttpSink({
      endpoint: 'https://example.test/ingest',
      batchSize: 3,
      flushIntervalMs: 10000,
    });

    await sink.write('s-http', event(1));
    await sink.write('s-http', event(2));
    await sink.write('s-http', event(3)); // triggers flush

    // Advance timers and wait for promises to resolve
    await vi.advanceTimersByTimeAsync(20);

    expect((globalThis as any).fetch).toHaveBeenCalledTimes(1);
    const call = (globalThis as any).fetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.events.length).toBe(3);
  });

  it('retries on 5xx and then drops on exhaustion', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    (globalThis as any).fetch = mock;

    const onDrop = vi.fn();
    const sink = new HttpSink({
      endpoint: 'https://example.test/ingest',
      batchSize: 1,
      flushIntervalMs: 10000,
      retry: { retries: 2, baseMs: 10, maxMs: 20, jitter: false },
      onDrop,
    });

    await sink.write('s-http', event(42));

    // Advance timers incrementally to handle retries
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20); // Advance past retry delay
    }

    expect(onDrop).toHaveBeenCalledWith('retry_exhausted', 1);
    expect(mock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries with exponential-ish delays then succeeds', async () => {
    // Fail twice, succeed on 3rd
    const mock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    (globalThis as any).fetch = mock;

    const onDrop = vi.fn();
    const sink = new HttpSink({
      region: 'eu',
      flushIntervalMs: 1,
      retry: { retries: 2, baseMs: 100, maxMs: 1000, jitter: false },
      onDrop,
    });

    await sink.write('s-http', event(42));

    // Advance timers incrementally to handle retries
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(200); // Advance past retry delay
    }

    expect(onDrop).not.toHaveBeenCalled();
    expect(mock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});
