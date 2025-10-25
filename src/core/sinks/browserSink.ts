/* eslint-env browser */
import type { TracerEvent } from '../types';
import type { BufferedSink } from './types';

/**
 * Defines the delivery strategy for events in the browser.
 * - `immediate`: Events are written to `localStorage` as they are received.
 * - `buffered`: Events are collected in an in-memory queue and flushed periodically.
 */
export type BrowserDeliveryMode = 'immediate' | 'buffered';

/**
 * Configuration options for the `BrowserSink`.
 */
export interface BrowserSinkOptions {
  /**
   * A prefix for the key used when storing events in `localStorage`.
   * The final key will be `[storageKeyPrefix]:[sessionId]`.
   * This is used in `immediate` mode, and in `buffered` mode if no `endpoint` is provided.
   * @default 'accordkit'
   */
  storageKeyPrefix?: string;
  /**
   * The delivery strategy for events.
   * - `immediate`: Write each event to `localStorage` right away.
   * - `buffered`: Batch events in memory and flush them periodically.
   * @default 'immediate'
   */
  delivery?: BrowserDeliveryMode;
  /**
   * The number of events to collect in the buffer before triggering a flush.
   * Only applies to `buffered` delivery mode.
   * @default 20
   */
  batchSize?: number;
  /**
   * The maximum time in milliseconds to wait before flushing the buffer, regardless of its size.
   * Only applies to `buffered` delivery mode.
   * @default 1000
   */
  flushIntervalMs?: number;
  /**
   * An optional HTTP endpoint URL to send buffered events to.
   * When provided, `buffered` mode will POST event batches to this URL
   * using `navigator.sendBeacon` if available, falling back to `fetch`.
   * If not provided, `buffered` mode will flush to `localStorage`.
   */
  endpoint?: string;
  /**
   * The maximum number of events to keep in the in-memory buffer.
   * If the buffer exceeds this size, the oldest events will be dropped.
   * This prevents unbounded memory growth.
   * Only applies to `buffered` delivery mode.
   * @default 2000
   */
  maxBuffer?: number;
}

/**
 * A sink for browser environments that persists tracer events.
 *
 * It supports two delivery modes:
 * 1.  **`immediate`**: Writes each event as a JSON line to `localStorage` as it occurs.
 *     This is simple and durable but can be slow due to frequent `localStorage` access.
 *
 * 2.  **`buffered`**: Collects events in an in-memory queue and flushes them in batches.
 *     Flushing occurs when the batch size is reached, on a timer, or when the page is hidden.
 *     If an `endpoint` is configured, batches are sent via HTTP POST (`sendBeacon` or `fetch`).
 *     Otherwise, batches are written to `localStorage`. This mode is more performant for high-volume tracing.
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

  /**
   * Creates an instance of BrowserSink.
   * @param opts - Configuration options for the sink.
   */
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

  /**
   * Writes a tracer event.
   *
   * In `immediate` mode, the event is immediately appended to `localStorage`.
   * In `buffered` mode, the event is added to an in-memory queue for later flushing.
   */
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

  /**
   * Flushes any buffered events.
   *
   * This method is a no-op if the `delivery` mode is `immediate`.
   * In `buffered` mode, it sends the current batch of events.
   * If an `endpoint` is configured, it sends the data as a POST request
   * using `navigator.sendBeacon` or `fetch`. Otherwise, it writes the events
   * to `localStorage`.
   */
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

  /**
   * Cleans up resources used by the sink.
   *
   * This method stops the periodic flushing timer (in `buffered` mode)
   * and performs a final flush of any remaining events in the buffer.
   */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
