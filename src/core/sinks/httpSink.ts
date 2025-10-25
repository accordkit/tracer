import { resolveIngestEndpoint, type Region } from './endpoint';

import type { TracerEvent } from '../types';
import type { BufferedSink, RetryPolicy } from './types';

/**
 * Configuration options for the {@link HttpSink}.
 */
export interface HttpSinkOptions {
  /**
   * The endpoint URL to which events will be sent.
   * If not provided, it will be resolved using `baseUrl` and `region`.
   */
  endpoint?: string;
  /**
   * The geographical region for the ingest endpoint.
   * @default 'auto'
   */
  region?: Region;
  /**
   * The base URL for the ingest endpoint.
   * @default 'https://api.accordkit.dev'
   */
  baseUrl?: string;
  /**
   * A record of custom headers to include in the HTTP request.
   * The `content-type` header is automatically set to `application/json`.
   */
  headers?: Record<string, string>;
  /**
   * The number of events to buffer before sending them to the endpoint.
   * @default 20
   */
  batchSize?: number;
  /**
   * The interval in milliseconds at which to flush the buffer, regardless of its size.
   * @default 1000
   */
  flushIntervalMs?: number;
  /**
   * The maximum number of events to keep in the buffer before dropping the oldest ones.
   * @default 5000
   */
  maxBuffer?: number;
  /**
   * The retry policy for handling transient failures when sending events.
   * @default { retries: 3, baseMs: 250, maxMs: 4000, jitter: true }
   */
  retry?: RetryPolicy;
  /**
   * A callback function that is called when events are dropped.
   * @param reason The reason why the events were dropped (`queue_full` or `retry_exhausted`).
   * @param dropped The number of events that were dropped.
   */
  onDrop?: (reason: 'queue_full' | 'retry_exhausted', dropped: number) => void;
}

/**
 * An HTTP sink that batches events and sends them to a configured endpoint via a POST request.
 * It provides a retry mechanism with exponential backoff and optional jitter for transient failures.
 * By default, it is a best-effort, non-throwing sink, meaning it will not throw errors if events fail to be delivered.
 *
 * @example
 * ```typescript
 * const sink = new HttpSink({
 *   endpoint: 'https://my-collector.com/ingest',
 *   batchSize: 100,
 *   flushIntervalMs: 5000,
 * });
 *
 * const tracer = new Tracer({ sink });
 *
 * // ... trace events
 *
 * await tracer.close(); // Flushes any remaining events
 * ```
 */
export class HttpSink implements BufferedSink {
  private endpoint: string;
  private headers: Record<string, string>;
  private batchSize: number;
  private flushIntervalMs: number;
  private maxBuffer: number;
  private retry: RetryPolicy;
  private onDrop?: (reason: 'queue_full' | 'retry_exhausted', dropped: number) => void;

  private queue: Array<{ sessionId: string; e: TracerEvent }> = [];
  private timer?: ReturnType<typeof setInterval>;
  private inflight = false;

  /**
   * Creates a new `HttpSink` instance.
   * @param opts The configuration options for the sink.
   */
  constructor(opts: HttpSinkOptions) {
    this.endpoint =
      opts.endpoint ?? resolveIngestEndpoint({ baseUrl: opts.baseUrl, region: opts.region });
    this.headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    this.batchSize = Math.max(1, opts.batchSize ?? 20);
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1000);
    this.maxBuffer = Math.max(this.batchSize, opts.maxBuffer ?? 5000);
    this.retry = opts.retry ?? { retries: 3, baseMs: 250, maxMs: 4000, jitter: true };
    this.onDrop = opts.onDrop;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // @ts-ignore
    this.timer.unref?.();
  }

  /**
   * Adds an event to the queue to be sent to the endpoint.
   *
   * If the queue is full (i.e., it has reached `maxBuffer`), the oldest events are dropped to make space for the new one.
   * If the queue size reaches `batchSize`, a flush is automatically triggered.
   *
   * @param sessionId The ID of the session to which the event belongs.
   * @param e The event to write.
   */
  write(sessionId: string, e: TracerEvent) {
    this.queue.push({ sessionId, e });

    if (this.queue.length > this.maxBuffer) {
      const dropped = this.queue.length - this.maxBuffer;
      this.queue.splice(0, dropped);
      this.onDrop?.('queue_full', dropped);
    }

    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }
  }

  /**
   * Flushes the queue of events to the configured endpoint.
   *
   * If a flush is already in progress, this method will do nothing to prevent concurrent flushes.
   * The method will attempt to send the batch of events and will retry with exponential backoff if the request fails with a 5xx status code or a 429 (Too Many Requests).
   * If the request fails for other reasons, or if the retries are exhausted, the events are dropped.
   *
   * @returns A promise that resolves when the flush is complete.
   */
  async flush(): Promise<void> {
    if (this.inflight) return;
    if (this.queue.length === 0) return;

    this.inflight = true;

    const batch = this.queue.splice(0, this.batchSize);
    try {
      const body = JSON.stringify({
        sessionId: batch[batch.length - 1]?.sessionId,
        events: batch.map((x) => x.e),
      });

      let attempt = 0;
      while (true) {
        try {
          const res = await fetch(this.endpoint, { method: 'POST', headers: this.headers, body });
          if (res.ok) break;

          if (!(res.status >= 500 || res.status === 429)) break;

          if (attempt >= this.retry.retries) {
            this.onDrop?.('retry_exhausted', batch.length);
            break;
          }
        } catch {
          if (attempt >= this.retry.retries) {
            this.onDrop?.('retry_exhausted', batch.length);
            break;
          }
        }

        attempt++;
        const delay = this.backoffDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      this.inflight = false;
    }
  }

  /**
   * Clears the flush timer and flushes any remaining events in the queue.
   * This should be called before the application exits to ensure that all buffered events are sent.
   *
   * @returns A promise that resolves when the sink is closed and all events have been flushed.
   */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private backoffDelay(attempt: number) {
    const exp = Math.min(this.retry.baseMs * Math.pow(2, attempt - 1), this.retry.maxMs);
    if (!this.retry.jitter) return exp;

    const rand = Math.random() + 0.5; // 0.5..1.5
    return Math.floor(exp * rand);
  }
}
