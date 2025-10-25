/* eslint-env browser */
import type { TracerEvent } from '../types';
import type { BufferedSink } from './types';

export type BrowserDeliveryMode = 'immediate' | 'buffered';

export interface BrowserSinkOptions {
  /** Storage key prefix used in immediate mode (default: 'accordkit'). */
  storageKeyPrefix?: string;
  /** Delivery behavior: per-event localStorage write or buffered with periodic flush. */
  delivery?: BrowserDeliveryMode;
  /** Batch size threshold for buffered mode. */
  batchSize?: number;
  /** Flush interval in ms for buffered mode. */
  flushIntervalMs?: number;
  /** Optional HTTP endpoint; buffered flush will POST (sendBeacon if available). */
  endpoint?: string;
  /** Max events kept in memory before dropping oldest in buffered mode. */
  maxBuffer?: number;
}

/**
 * Browser sink that either appends JSON lines to localStorage (immediate)
 * or buffers events in-memory and flushes periodically / on demand.
 *
 * When `endpoint` is provided in buffered mode, flush attempts to deliver
 * via `navigator.sendBeacon` (preferred) or `fetch` as a fallback.
 */
export class BrowserSink implements BufferedSink {
  private storageKeyPrefix: string;
  private delivery: BrowserDeliveryMode;
  private batchSize: number;
  private flushIntervalMs: number;
  private endpoint?: string;
  private maxBuffer: number;

  private queue: Array<{ sessionId: string; e: TracerEvent }> = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: BrowserSinkOptions = {}) {
    this.storageKeyPrefix = opts.storageKeyPrefix ?? 'accordkit';
    this.delivery = opts.delivery ?? 'immediate';
    this.batchSize = Math.max(1, opts.batchSize ?? 20);
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1000);
    this.endpoint = opts.endpoint;
    this.maxBuffer = Math.max(this.batchSize, opts.maxBuffer ?? 2000);

    if (this.delivery === 'buffered') {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      // @ts-ignore
      this.timer?.unref?.(); // no-op in browsers; helpful in SSR tests
      // Best-effort flush on pagehide
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('pagehide', () => {
          void this.flush();
        });
        window.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') void this.flush();
        });
      }
    }
  }

  /** @inheritdoc */
  write(sessionId: string, e: TracerEvent): void {
    if (this.delivery === 'immediate') {
      const k = `${this.storageKeyPrefix}:${sessionId}`;
      const prev = localStorage.getItem(k) || '';
      localStorage.setItem(k, prev + (prev ? '\n' : '') + JSON.stringify(e));
      return;
    }

    // buffered
    this.queue.push({ sessionId, e });
    if (this.queue.length > this.maxBuffer) {
      // drop oldest
      this.queue.splice(0, this.queue.length - this.maxBuffer);
    }
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /** Flush buffered events (no-op in immediate mode). */
  async flush(): Promise<void> {
    if (this.delivery !== 'buffered') return;
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.batchSize);
    const payload = JSON.stringify({
      sessionId: batch[batch.length - 1]?.sessionId,
      events: batch.map((x) => x.e),
    });

    // If no endpoint, persist to localStorage as a single line per event.
    if (!this.endpoint) {
      for (const item of batch) {
        const k = `${this.storageKeyPrefix}:${item.sessionId}`;
        const prev = localStorage.getItem(k) || '';
        localStorage.setItem(k, prev + (prev ? '\n' : '') + JSON.stringify(item.e));
      }
      return;
    }

    // Try sendBeacon first
    try {
      if (
        typeof navigator !== 'undefined' &&
        typeof (
          navigator as unknown as { sendBeacon?: (url: string, data?: BodyInit | null) => boolean }
        ).sendBeacon === 'function'
      ) {
        const nav = navigator as Navigator & {
          sendBeacon?: (url: string, data?: BodyInit | null) => boolean;
        };
        const ok = nav.sendBeacon(this.endpoint as string, payload);
        if (ok) return;
        // If sendBeacon returns false, fall through to fetch
      }
    } catch {
      // ignore and try fetch
    }

    // Fallback to fetch (fire-and-forget)
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        keepalive: true,
      });
    } catch {
      // best-effort: swallow errors
    }
  }

  /** Clear timer and flush remaining buffered events. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
