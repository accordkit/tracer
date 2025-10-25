import { describe, it, expect, beforeEach, vi } from 'vitest';

import { BrowserSink } from '../src/core/sinks/browserSink';

import type { MessageEvent } from '../src/core/types';

// simple localStorage shim
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
};

// navigator.sendBeacon mock
if (typeof (globalThis as any).navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon: vi.fn().mockReturnValue(true) },
    configurable: true,
    writable: true,
  });
} else {
  // navigator exists — try to set sendBeacon, fall back to defineProperty if read-only
  try {
    (globalThis as any).navigator.sendBeacon = vi.fn().mockReturnValue(true);
  } catch {
    Object.defineProperty((globalThis as any).navigator, 'sendBeacon', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    });
  }
}

function event(i: number | null = null): MessageEvent {
  return {
    ts: new Date(0 + (i ?? 0)).toISOString(),
    sessionId: 's2',
    level: 'info',
    type: 'message',
    role: 'user',
    content: i ? 'hi ' + i : 'hi',
    ctx: { traceId: 'tr2', spanId: 'sp2' },
  };
}

describe('BrowserSink', () => {
  beforeEach(() => {
    store.clear();
  });

  it('appends JSON lines to localStorage key', () => {
    const sink = new BrowserSink();
    sink.write('s2', event());
    sink.write('s2', event());
    const k = 'accordkit:s2';
    const raw = (globalThis as any).localStorage.getItem(k);
    expect(raw?.split('\n').length).toBe(2);
  });
});

describe('BrowserSink buffered', () => {
  beforeEach(() => {
    store.clear();
    (navigator.sendBeacon as any).mockClear();
    vi.useFakeTimers();
  });

  it('buffers and flushes to localStorage when no endpoint', async () => {
    const sink = new BrowserSink({
      delivery: 'buffered',
      batchSize: 2,
      flushIntervalMs: 10,
      storageKeyPrefix: 'ak',
    });
    sink.write('s-b', event(1));
    sink.write('s-b', event(2)); // triggers flush

    await vi.advanceTimersByTimeAsync(20);

    const raw = (globalThis as any).localStorage.getItem('ak:s-b');
    expect(raw?.split('\n').length).toBe(2);
  });

  it('uses sendBeacon when endpoint is provided', async () => {
    const sink = new BrowserSink({
      delivery: 'buffered',
      batchSize: 2,
      flushIntervalMs: 10,
      endpoint: '/ingest',
    });
    sink.write('s-b', event(1));
    sink.write('s-b', event(2)); // triggers flush

    await vi.advanceTimersByTimeAsync(20);

    expect((navigator.sendBeacon as any).mock.calls.length).toBeGreaterThan(0);
  });
});
