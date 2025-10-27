import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { HttpSink } from '../src/core/sinks/httpSink';
type TracerEvent = any;

function event(sessionId = 's1', i = 0): TracerEvent {
  return { sessionId, i, type: 'event', ts: 1_000 + i };
}

describe('HttpSink', () => {
  let schedule: Array<(resolve: (v: any) => void, reject: (e: any) => void) => void>;
  let fetchCalls: Array<{ url: string; body: string; headers: any }>;
  let onDropBatches: Array<string[]>;

  beforeEach(() => {
    vi.useRealTimers();
    fetchCalls = [];
    schedule = [];
    onDropBatches = [];

    // Stub global fetch with a controllable queue.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: any) => {
        fetchCalls.push({ url, body: String(init?.body ?? ''), headers: init?.headers });

        if (schedule.length === 0) {
          return Promise.resolve({ ok: true, status: 200 } as any);
        }
        return new Promise((resolve, reject) => {
          const handler = schedule.shift()!;
          handler(resolve, reject);
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('buffers then flushes: sends JSONL joined with newline and awaited', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      flushIntervalMs: 60_000, // keep timer idle
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));
    sink.write('s2', event('s2', 3));

    await sink.flush();

    expect(fetchCalls.length).toBe(2); // s1 chunk + s2 chunk in interleaved drain
    const bodies = fetchCalls.map((c) => c.body.trim());
    expect(bodies).toContain(
      JSON.stringify(event('s1', 1)) + '\n' + JSON.stringify(event('s1', 2)),
    );
    expect(bodies).toContain(JSON.stringify(event('s2', 3)));
    await sink.close();
  });

  it('chunks by batchSize and preserves order; awaits batch1 before batch2', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 2,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));
    sink.write('s1', event('s1', 3)); // second batch

    let firstResolve!: (v: any) => void;

    // Hold the first POST until we say so
    schedule.push((resolve) => {
      firstResolve = resolve; // don't resolve yet
    });

    // Second POST should only fire after the first resolves
    schedule.push((resolve) => resolve({ ok: true, status: 200 } as any));

    const flushP = sink.flush();

    // allow first fetch to be issued
    await Promise.resolve();
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body).toBe(
      JSON.stringify(event('s1', 1)) + '\n' + JSON.stringify(event('s1', 2)) + '\n',
    );
    expect(fetchCalls[1]).toBeUndefined();

    // release the first POST
    firstResolve({ ok: true, status: 200 } as any);

    await flushP;

    // verify the second POST happened after the first resolved
    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].body).toBe(JSON.stringify(event('s1', 3)) + '\n');
  });

  it('auto-flush on full: write() returns a Promise only when over capacity', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      maxBuffer: 2,
      overflowPolicy: 'auto-flush',
      flushIntervalMs: 60_000,
    });

    const r1 = sink.write('s1', event('s1', 1));
    const r2 = sink.write('s1', event('s1', 2));
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    const r3 = sink.write('s1', event('s1', 3));
    expect(r3).toBeInstanceOf(Promise);

    await r3;
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body).toBe(
      JSON.stringify(event('s1', 1)) +
        '\n' +
        JSON.stringify(event('s1', 2)) +
        '\n' +
        JSON.stringify(event('s1', 3)) +
        '\n',
    );
    await sink.close();
  });

  it('drop-oldest: removes the oldest when over capacity', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      maxBuffer: 2,
      overflowPolicy: 'drop-oldest',
      flushIntervalMs: 60_000,
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));
    sink.write('s1', event('s1', 3)); // drops 1

    await sink.flush();

    expect(fetchCalls.length).toBe(1);
    const lines = fetchCalls[0].body.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(JSON.stringify(event('s1', 2)));
    expect(lines[1]).toBe(JSON.stringify(event('s1', 3)));
    await sink.close();
  });

  it('error policy: throws when writing over capacity', () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      maxBuffer: 1,
      overflowPolicy: 'error',
      flushIntervalMs: 60_000,
    });

    sink.write('s1', event('s1', 1));
    expect(() => sink.write('s1', event('s1', 2))).toThrowError(/buffer full/i);
  });

  it('retry per batch on non-OK HTTP, then succeed', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 2,
      retry: { retries: 3, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => onDropBatches.push(lines),
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    // Program: first attempt -> 500, second attempt -> 200
    schedule.push((reject) => {
      reject({ ok: false, status: 500 } as any);
    });
    schedule.push((resolve) => resolve({ ok: true, status: 200 } as any));

    const flushP = sink.flush();

    await flushP;

    expect(fetchCalls.length).toBe(2);
    expect(onDropBatches.length).toBe(0); // eventually succeeded
    await sink.close();
  });

  it('retry per batch on thrown network error, then drop only that batch and continue', async () => {
    // Use fake timers because backoff uses setTimeout
    vi.useFakeTimers();

    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      // 2 retries => 3 total attempts for the first batch
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => onDropBatches.push(lines),
    });

    // First batch (s1:1) should fail 3 times (initial + 2 retries), then be dropped.
    // Second batch (s1:2) should succeed.
    schedule.push((_, reject) => reject(new Error('net fail 1'))); // attempt 1
    schedule.push((_, reject) => reject(new Error('net fail 2'))); // attempt 2
    schedule.push((_, reject) => reject(new Error('net fail 3'))); // attempt 3 (exhaust)
    schedule.push((resolve) => resolve({ ok: true, status: 200 } as any)); // second batch

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    const flushP = sink.flush();

    // Let the first attempt run and fail, then advance timers for the two backoffs.
    // With baseMs=1, maxMs=2, jitter=false and exponential (1ms then 2ms), advancing 10ms covers both.
    await vi.advanceTimersByTimeAsync(10);

    await flushP;

    // 4 fetch calls total: 3 failed attempts for batch #1 + 1 success for batch #2
    expect(fetchCalls.length).toBe(4);

    // First batch dropped
    expect(onDropBatches.length).toBe(1);
    const droppedBody = onDropBatches[0].join('\n') + '\n';
    expect(droppedBody).toBe(JSON.stringify(event('s1', 1)) + '\n');

    // Second batch delivered
    const lastCallBody = fetchCalls[3].body;
    expect(lastCallBody).toBe(JSON.stringify(event('s1', 2)) + '\n');

    vi.useRealTimers();
    await sink.close();
  });

  it('no overlapping flushes: concurrent calls resolve together and a single drain occurs', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    // Seed two events that will be sent in a single POST
    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    // Hold the first POST so both flush() calls overlap
    let firstResolve!: (v: any) => void;
    schedule.push((resolve) => {
      firstResolve = resolve;
    });

    const p1 = sink.flush();
    const p2 = sink.flush();

    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);

    // Let the first POST actually resolve
    firstResolve({ ok: true, status: 200 } as any);

    // Both should complete successfully
    await Promise.all([p1, p2]);

    // And only one POST should have occurred (single drain)
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.trim().split('\n').length).toBe(2);

    await sink.close();
  });

  it('periodic flush triggers automatically', async () => {
    vi.useFakeTimers();
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      flushIntervalMs: 10,
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    await vi.advanceTimersByTimeAsync(15);
    expect(fetchCalls.length).toBe(1);

    vi.useRealTimers();
    await sink.close();
  });

  it('close(): drains buffer and prevents further writes', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));
    await sink.close();

    // Two events should have been delivered in one POST
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.trim().split('\n').length).toBe(2);

    // After close: writes are no-ops
    sink.write('s1', event('s1', 3));
    await sink.flush();
    expect(fetchCalls.length).toBe(1);
  });

  it('flush requested during in-flight flush leads to second drain pass', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      flushIntervalMs: 60_000,
    });

    let firstResolve!: (v: any) => void;
    schedule.push((resolve) => {
      firstResolve = resolve; /* hold */
    });
    schedule.push((resolve) => resolve({ ok: true, status: 200 } as any));

    // Seed first batch and start flush
    sink.write('s1', event('s1', 1));
    const flushP = sink.flush();

    // Ensure first POST issued
    await Promise.resolve();
    expect(fetchCalls.length).toBe(1);

    // While first is in-flight, enqueue another event (this must set flushRequested)
    sink.write('s1', event('s1', 2));

    // Release first POST
    firstResolve({ ok: true, status: 200 } as any);

    // Now flush should do a second pass and send the second POST
    await flushP;

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].body).toBe(JSON.stringify(event('s1', 2)) + '\n');

    await sink.close();
  });
});

describe('HttpSink: retry policy extensions', () => {
  let fetchCalls: Array<{ url: string; body: string; headers: HeadersInit }>;
  let schedule: Array<(resolve: (v: any) => void, reject: (e: any) => void) => void>;

  beforeEach(() => {
    vi.useRealTimers();
    fetchCalls = [];
    schedule = [];

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        const headers = init?.headers ?? {};
        console.log('fetch called');
        fetchCalls.push({ url, body, headers });

        if (schedule.length === 0) {
          // default: immediate 200 OK
          return Promise.resolve(new Response('', { status: 200 }));
        }
        return new Promise((resolve, reject) => {
          const handler = schedule.shift()!;
          handler(resolve, reject);
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('respects Retry-After in seconds for 429', async () => {
    vi.useFakeTimers();

    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 2,
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
    });

    // First attempt returns 429 with Retry-After: 2 seconds
    schedule.push((resolve) => {
      const headers = new Headers({ 'Retry-After': '2' });
      resolve(new Response('', { status: 429, headers }));
    });
    // Second attempt succeeds
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    const flushP = sink.flush();

    // Should wait ~2000ms per Retry-After before retrying
    expect(fetchCalls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchCalls.length).toBe(1); // not retried yet
    await vi.advanceTimersByTimeAsync(2);
    await flushP;

    expect(fetchCalls.length).toBe(2); // retried once, succeeded
    vi.useRealTimers();
    await sink.close();
  });

  it('respects Retry-After in HTTP-date for 503', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 2, baseMs: 1, maxMs: 5, jitter: false },
      flushIntervalMs: 60_000,
    });

    const futureMs = 2000; // 2.2 seconds in future
    const date = new Date(Date.now() + futureMs).toUTCString();

    schedule.push((resolve) => {
      const headers = new Headers({ 'Retry-After': date });
      resolve(new Response('', { status: 503, headers }));
    });
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));

    const p = sink.flush();
    expect(fetchCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(futureMs - 100);
    expect(fetchCalls.length).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    await p;

    expect(fetchCalls.length).toBe(2);
    vi.useRealTimers();
    await sink.close();
  });

  it('one-shot 413 downshift splits batch once and sends halves', async () => {
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 4, // single batch with 4 lines
      retry: { retries: 1, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
    });

    // First call returns 413 (payload too large)
    schedule.push((resolve) => resolve(new Response('', { status: 413 })));
    // Next two calls (halves) succeed
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));
    sink.write('s1', event('s1', 3));
    sink.write('s1', event('s1', 4));

    await sink.flush();

    // Expect 3 posts: 1 failed (413) then 2 sub-batches
    expect(fetchCalls.length).toBe(3);
    // sub-batches are halves (2 lines each)
    const bodies = fetchCalls.map((c) => c.body.trim());
    expect(bodies[1].split('\n').length).toBe(2);
    expect(bodies[2].split('\n').length).toBe(2);
    await sink.close();
  });

  it('413 on a single-item batch drops it (no infinite retry)', async () => {
    const dropped: Array<string[]> = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => dropped.push(lines),
    });

    // Only one item; 413 should drop it
    schedule.push((resolve) => resolve(new Response('', { status: 413 })));

    sink.write('s1', event('s1', 1));
    await sink.flush();

    expect(fetchCalls.length).toBe(1);
    expect(dropped.length).toBe(1);
    expect(dropped[0].length).toBe(1);
    await sink.close();
  });

  it('idempotency key header is set per attempt', async () => {
    const seenKeys: string[] = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      idempotencyKey: (_lines, attempt) => `req-${attempt}`, // attempt starts at 1
    });

    // First attempt fails (500), second succeeds
    schedule.push((resolve) => resolve(new Response('', { status: 500 })));
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));
    await sink.flush();

    // Capture keys from the two calls
    for (const call of fetchCalls) {
      const h = new Headers(call.headers as HeadersInit);
      seenKeys.push(h.get('Idempotency-Key') || '');
    }
    expect(seenKeys).toEqual(['req-1', 'req-2']);
    await sink.close();
  });

  it('non-retryable 400: no retry; onDropBatch called once', async () => {
    const dropped: Array<string[]> = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 5, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => dropped.push(lines),
    });

    schedule.push((resolve) => resolve(new Response('', { status: 400 })));

    sink.write('s1', event('s1', 1));
    await sink.flush();

    expect(fetchCalls.length).toBe(1);
    expect(dropped.length).toBe(1);
    await sink.close();
  });

  it('non-retryable 409 by default: drop without retry', async () => {
    const dropped: Array<string[]> = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 5, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => dropped.push(lines),
    });

    schedule.push((resolve) => resolve(new Response('', { status: 409 })));

    sink.write('s1', event('s1', 1));
    await sink.flush();

    expect(fetchCalls.length).toBe(1);
    expect(dropped.length).toBe(1);
    await sink.close();
  });

  it('retry on 500 then succeed (no drop)', async () => {
    const dropped: Array<string[]> = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => dropped.push(lines),
    });

    schedule.push((resolve) => resolve(new Response('', { status: 500 })));
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));
    await sink.flush();

    expect(fetchCalls.length).toBe(2);
    expect(dropped.length).toBe(0);
    await sink.close();
  });

  it('network error: retry up to cap, then drop only that batch and continue', async () => {
    vi.useFakeTimers();

    const dropped: Array<string[]> = [];
    const sink = new HttpSink({
      endpoint: 'https://trabzon.test/ingest',
      batchSize: 1,
      retry: { retries: 2, baseMs: 1, maxMs: 2, jitter: false },
      flushIntervalMs: 60_000,
      onDropBatch: (lines) => dropped.push(lines),
    });

    // First batch: three attempts (initial + 2 retries) all reject -> dropped
    schedule.push((_, reject) => reject(new Error('net fail 1')));
    schedule.push((_, reject) => reject(new Error('net fail 2')));
    schedule.push((_, reject) => reject(new Error('net fail 3')));
    // Second batch: success
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', event('s1', 1));
    sink.write('s1', event('s1', 2));

    const p = sink.flush();
    await vi.advanceTimersByTimeAsync(10); // advance enough to cover backoffs
    await p;

    expect(fetchCalls.length).toBe(4);
    expect(dropped.length).toBe(1);
    expect(fetchCalls[3].body).toBe(JSON.stringify(event('s1', 2)) + '\n');

    vi.useRealTimers();
    await sink.close();
  });
});
