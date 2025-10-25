import { resolveIngestEndpoint, type Region } from './endpoint';

import type { TracerEvent } from '../types';
import type { BufferedSink, RetryPolicy } from './types';

export interface HttpSinkOptions {
  endpoint?: string;
  region?: Region;
  baseUrl?: string;
  headers?: Record<string, string>;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
  retry?: RetryPolicy;
  onDrop?: (reason: 'queue_full' | 'retry_exhausted', dropped: number) => void;
}

/**
 * HTTP sink that batches events and POSTs to a configured endpoint.
 * Provides retries with exponential backoff + optional jitter for transient failures.
 * Best-effort and non-throwing by default.
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
