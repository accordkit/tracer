import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { BrowserSink } from '../src/core/sinks/browserSink';

import type { TracerEvent } from '../src';

function ev(sessionId = 's1', i = 0): TracerEvent {
  return {
    sessionId,
    ts: new Date(1_000 + i).toISOString(),
    level: 'info',
    type: 'message',
    role: 'user',
    ctx: { traceId: 't1', spanId: `sp${i}` },
    content: `event ${i}`,
  };
}

describe('BrowserSink (core, no IDB)', () => {
  let fetchCalls: Array<{ url: string; body: string; headers: HeadersInit; keepalive?: boolean }>;
  let schedule: Array<(resolve: (v: any) => void, reject: (e: any) => void) => void>;
  let beaconCalls: Array<{ url: string | URL; data: Blob | BodyInit | null | undefined }>;
  let onDrop: Array<string[]>;

  let navigatorMock: Partial<Navigator> & {
    sendBeacon: (url: string | URL, data: Blob | BodyInit | null | undefined) => boolean;
  };

  const setSendBeacon = (impl: typeof navigatorMock.sendBeacon) => {
    navigatorMock.sendBeacon = impl;
  };

  beforeEach(() => {
    navigatorMock = { sendBeacon: () => true };
    vi.stubGlobal('navigator', navigatorMock);
    vi.useRealTimers();
    fetchCalls = [];
    schedule = [];
    beaconCalls = [];
    onDrop = [];

    // Stub fetch (fallback path)
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const body = String(init?.body ?? '');
        const headers = init?.headers ?? {};
        const keepalive = (init as any)?.keepalive;
        fetchCalls.push({ url, body, headers, keepalive });

        if (schedule.length === 0) {
          return Promise.resolve(new Response('', { status: 200 }));
        }
        return new Promise((resolve, reject) => {
          const handler = schedule.shift()!;
          handler(resolve, reject);
        });
      }),
    );

    // Stub sendBeacon; default = true (success)
    setSendBeacon((url, data) => {
      beaconCalls.push({ url, data });
      return true;
    });

    // Minimal DOM hooks
    // @ts-expect-error
    global.document = {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    // @ts-expect-error
    global.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error
    delete global.window;
    // @ts-expect-error
    delete global.document;
    // @ts-expect-error
    delete global.navigator;
  });

  it('buffered: uses sendBeacon for small payload (<= beaconMaxBytes)', async () => {
    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      beaconMaxBytes: 64 * 1024,
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));
    await sink.flush();

    expect(beaconCalls.length).toBe(1);
    expect(fetchCalls.length).toBe(0);
    const beaconData = beaconCalls[0]?.data;
    const text =
      beaconData && typeof (beaconData as Blob).text === 'function'
        ? await (beaconData as Blob).text()
        : String(beaconData ?? '');
    expect(text.trim().split('\n').length).toBe(2);

    await sink.close();
  });

  it('buffered: falls back to fetch when payload > beaconMaxBytes', async () => {
    // Make small max so we force fetch fallback
    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      beaconMaxBytes: 32, // tiny
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));
    await sink.flush();

    expect(beaconCalls.length).toBe(0);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].keepalive).toBe(true);
    await sink.close();
  });

  it('buffered: sendBeacon returns false -> fallback to fetch', async () => {
    // Force beacon failure
    const beaconFail = (url: string, data: Blob) => {
      beaconCalls.push({ url, data });
      return false;
    };

    global.navigator.sendBeacon = beaconFail;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', ev('s1', 1));
    await sink.flush();

    expect(beaconCalls.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
    await sink.close();
  });

  it('immediate: sends per write; on fetch failure calls onDropBatch', async () => {
    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'immediate',
      onDropBatch: (lines) => onDrop.push(lines),
    });

    // Force beacon to false so we go to fetch
    global.navigator.sendBeacon = (url: string, data: Blob) => {
      beaconCalls.push({ url, data });
      return false;
    };
    // First fetch reject, second succeed
    schedule.push((_, reject) => reject(new Error('net fail')));
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    await sink.write('s1', ev('s1', 1)); // returns Promise<void>
    await sink.write('s1', ev('s1', 2));

    expect(onDrop.length).toBe(1); // first dropped
    expect(fetchCalls.length).toBe(2);
    await sink.close();
  });

  it('no overlapping flushes: two concurrent flush() resolve; single drain', async () => {
    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));

    // Hold first delivery so both flush() overlap
    let firstResolve!: (v: any) => void;
    schedule.push((resolve) => {
      firstResolve = resolve;
    });
    // force fetch path to observe single POST (beacon false)
    global.navigator.sendBeacon = () => false;

    const p1 = sink.flush();
    const p2 = sink.flush();

    expect(p1).toBeInstanceOf(Promise);
    expect(p2).toBeInstanceOf(Promise);
    expect(fetchCalls.length).toBe(1); // first issued

    firstResolve(new Response('', { status: 200 }));
    await Promise.all([p1, p2]);

    expect(fetchCalls.length).toBe(1);
    await sink.close();
  });

  it('auto-flush on full: write() returns a Promise only when over capacity', async () => {
    // force fetch path for determinism
    global.navigator.sendBeacon = () => false;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      maxBuffer: 2,
      batchSize: 100,
      flushIntervalMs: 60_000,
      overflowPolicy: 'auto-flush',
    });

    const r1 = sink.write('s1', ev('s1', 1));
    const r2 = sink.write('s1', ev('s1', 2));
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    const r3 = sink.write('s1', ev('s1', 3));
    expect(r3).toBeInstanceOf(Promise);

    await r3;
    expect(fetchCalls.length).toBe(1);
    await sink.close();
  });

  it('drop-oldest policy discards oldest item when over capacity', async () => {
    global.navigator.sendBeacon = () => false;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      maxBuffer: 2,
      batchSize: 100,
      flushIntervalMs: 60_000,
      overflowPolicy: 'drop-oldest',
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));
    sink.write('s1', ev('s1', 3)); // drops #1

    await sink.flush();
    const lines = fetchCalls[0].body.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe(JSON.stringify(ev('s1', 2)));
    expect(lines[1]).toBe(JSON.stringify(ev('s1', 3)));
    await sink.close();
  });

  it('error policy throws when writing over capacity', () => {
    const sink = new BrowserSink({
      delivery: 'buffered',
      maxBuffer: 1,
      overflowPolicy: 'error',
      flushIntervalMs: 60_000,
    });
    sink.write('s1', ev('s1', 1));
    expect(() => sink.write('s1', ev('s1', 2))).toThrowError(/buffer full/i);
  });

  it('flush requested during in-flight flush triggers second pass', async () => {
    // Force fetch path
    global.navigator.sendBeacon = () => false;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      batchSize: 1,
      flushIntervalMs: 60_000,
    });

    let firstResolve!: (v: any) => void;
    schedule.push((resolve) => {
      firstResolve = resolve;
    });
    schedule.push((resolve) => resolve(new Response('', { status: 200 })));

    sink.write('s1', ev('s1', 1));
    const p = sink.flush();

    await Promise.resolve();
    expect(fetchCalls.length).toBe(1);

    // write during in-flight -> should schedule second pass
    sink.write('s1', ev('s1', 2));

    firstResolve(new Response('', { status: 200 }));
    await p;

    expect(fetchCalls.length).toBe(2);
    expect(fetchCalls[1].body).toBe(JSON.stringify(ev('s1', 2)) + '\n');
    await sink.close();
  });

  it('periodic flush triggers automatically', async () => {
    vi.useFakeTimers();
    // Force fetch path

    global.navigator.sendBeacon = () => false;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      flushIntervalMs: 10,
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));

    await vi.advanceTimersByTimeAsync(15);
    expect(fetchCalls.length).toBe(1);

    vi.useRealTimers();
    await sink.close();
  });

  it('close(): drains buffer and prevents further writes', async () => {
    global.navigator.sendBeacon = () => false;

    const sink = new BrowserSink({
      endpoint: 'https://trabzon.test/ingest',
      delivery: 'buffered',
      flushIntervalMs: 60_000,
    });

    sink.write('s1', ev('s1', 1));
    sink.write('s1', ev('s1', 2));
    await sink.close();

    // drained
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].body.trim().split('\n').length).toBe(2);

    // write after close: no-op
    sink.write('s1', ev('s1', 3));
    await sink.flush();
    expect(fetchCalls.length).toBe(1);
  });
});
