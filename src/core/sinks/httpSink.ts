/* eslint-disable no-empty */
import type { TracerEvent } from '../types';
import type { BufferedSink, BufferedOptions, OverflowPolicy, RetryPolicy } from './types';

interface RetryableError extends Error {
  status?: number;
  retryAfterMs?: number;
}

export interface HttpSinkOptions extends BufferedOptions {
  /** POST URL for ingestion (required). */
  endpoint: string;
  /** Extra headers for POST (content-type defaults to application/json). */
  headers?: Record<string, string>;
  /** Per-batch retry policy (defaults: retries=3, baseMs=300, maxMs=5000, jitter=true). */
  retry?: Partial<RetryPolicy>;
  /** Called when a batch is dropped after retry exhaustion or non-retryable status. */
  onDropBatch?: (lines: string[], error: unknown) => void;
  /**
   * Optional idempotency key supplier. If provided, its return value will be set as
   * the 'Idempotency-Key' header on each attempt for this batch.
   * Signature: (lines, attempt) => key
   */
  idempotencyKey?: (lines: string[], attempt: number) => string;
}

/**
 * HttpSink
 * Buffered POST of JSONL batches to a single endpoint.
 *
 * Guarantees:
 *  - No overlapping flushes (guarded).
 *  - Deterministic shutdown (close() drains).
 *  - Full drain with awaited I/O, chunked by batchSize.
 *  - Per-batch retry with cap; after exhaustion, drop only that batch and continue.
 *  - Auto-flush on capacity; backpressure only while over capacity (buffered).
 *  - Retry policy refined: shouldRetry() + Retry-After for 429/503 + 413 downshift.
 */
export class HttpSink implements BufferedSink {
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly onDropBatch?: (lines: string[], error: unknown) => void;
  private readonly idempotencyKey?: (lines: string[], attempt: number) => string;

  private readonly buffers = new Map<string, string[]>();
  private totalBuffered = 0;

  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly overflowPolicy: OverflowPolicy;

  private readonly retry: Required<RetryPolicy>;

  private flushInFlight: Promise<void> | null = null;
  private flushRequested = false;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: HttpSinkOptions) {
    this.endpoint = opts.endpoint;
    this.headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    this.onDropBatch = opts.onDropBatch;
    this.idempotencyKey = opts.idempotencyKey;

    this.batchSize = opts.batchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBuffer = opts.maxBuffer ?? 1000;
    this.overflowPolicy = opts.overflowPolicy ?? 'auto-flush';

    this.retry = {
      retries: opts.retry?.retries ?? 3,
      baseMs: opts.retry?.baseMs ?? 300,
      maxMs: opts.retry?.maxMs ?? 5000,
      jitter: opts.retry?.jitter ?? true,
    };

    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
    // @ts-ignore Node timers
    if (this.timer?.unref) this.timer.unref();
  }

  public write(sessionId: string, e: TracerEvent): void | Promise<void> {
    if (this.closed) return;

    const line = JSON.stringify(e);
    const existing = this.buffers.get(sessionId);
    const arr = existing ?? [];
    if (!existing) this.buffers.set(sessionId, arr);

    // pre-check for 'error' policy
    if (this.totalBuffered >= this.maxBuffer && this.overflowPolicy === 'error') {
      throw new Error('HttpSink buffer full');
    }

    arr.push(line);
    this.totalBuffered++;

    // If a flush is already running, ensure we take another pass after it finishes
    if (this.flushInFlight) {
      this.flushRequested = true;
    }

    if (this.totalBuffered > this.maxBuffer) {
      switch (this.overflowPolicy) {
        case 'auto-flush':
          // Trigger an immediate guarded flush; backpressure only while over capacity
          return this.flush();
        case 'drop-oldest':
          this.dropOldest();
          break;
        case 'error':
          // already handled above
          break;
      }
    }
  }

  public async flush(): Promise<void> {
    if (this.closed && this.totalBuffered === 0) return;

    if (this.flushInFlight) {
      this.flushRequested = true;
      return this.flushInFlight;
    }

    this.flushInFlight = (async () => {
      try {
        do {
          this.flushRequested = false;

          const batches = this.drainBatches();
          for (const lines of batches) {
            if (lines.length === 0) continue;
            await this.sendBatchWithRetry(lines);
          }
        } while (this.flushRequested);
      } finally {
        this.flushInFlight = null;
      }
    })();

    return this.flushInFlight;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private drainBatches(): string[][] {
    if (this.totalBuffered === 0) return [];

    const batches: string[][] = [];
    let removed = 0;

    const sessions = Array.from(this.buffers.keys());
    let any = true;

    while (any) {
      any = false;
      for (const sid of sessions) {
        const arr = this.buffers.get(sid);
        if (!arr || arr.length === 0) continue;
        any = true;

        const chunk = arr.splice(0, this.batchSize);
        if (chunk.length > 0) {
          batches.push(chunk);
          removed += chunk.length;
        }
      }
    }

    this.totalBuffered = Math.max(0, this.totalBuffered - removed);
    return batches;
  }

  /**
   * Retry predicate for HTTP status or network error.
   * - Retries on network errors (status === undefined)
   * - Retries on 408/425/429 and 5xx (transient)
   * - No retry on typical 4xx (400,401,403,404,405,415,422, etc.)
   * - 409 is not retried by default unless your server guarantees idempotency.
   */
  private shouldRetry(status: number | undefined): boolean {
    if (status === undefined) return true; // network/throw
    if (status === 408) return true; // timeout
    if (status === 425) return true; // too early
    if (status === 429) return true; // throttled
    if (status >= 500 && status < 600) return true; // 5xx
    return false;
  }

  /** Parse Retry-After header: seconds or HTTP-date. Return milliseconds or undefined. */
  private parseRetryAfterMs(h: string | null): number | undefined {
    if (!h) return undefined;
    const s = h.trim();
    if (/^\d+$/.test(s)) {
      const ms = parseInt(s, 10) * 1000;
      return Number.isFinite(ms) ? ms : undefined;
    }
    const t = Date.parse(s);
    if (!Number.isNaN(t)) {
      const delta = t - Date.now();
      // ensure at least 1ms if future or present, otherwise undefined
      if (delta >= 1) return delta;
      if (delta >= 0) return 1; // clamp 0 to 1ms
      return undefined; // past date
    }
    return undefined;
  }

  private async sendBatchWithRetry(lines: string[], allowDownshift: boolean = true): Promise<void> {
    const body = lines.join('\n') + '\n';

    let attempt = 0;
    for (;;) {
      try {
        const headers: Record<string, string> = { ...this.headers };
        if (this.idempotencyKey) {
          const key = this.idempotencyKey(lines, attempt + 1);
          if (key) headers['Idempotency-Key'] = key;
        }

        const res: Response = await fetch(this.endpoint, {
          method: 'POST',
          headers,
          body,
        });

        if (!res.ok) {
          const retryAfter = this.parseRetryAfterMs(res.headers.get('Retry-After'));
          const err: RetryableError = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          err.retryAfterMs = retryAfter;
          throw err;
        }

        return; // success
      } catch (e) {
        const err = e as RetryableError;
        const status = err.status;
        const retryAfterMs = err.retryAfterMs;

        // 413 — one-shot downshift: split once and retry sub-batches
        if (status === 413) {
          if (allowDownshift && lines.length > 1) {
            const mid = Math.floor(lines.length / 2);
            const left = lines.slice(0, mid);
            const right = lines.slice(mid);
            await this.sendBatchWithRetry(left, false);
            await this.sendBatchWithRetry(right, false);
            return;
          } else {
            try {
              this.onDropBatch?.(lines, err);
            } catch {}
            return;
          }
        }

        // Decide whether this is retryable
        if (!this.shouldRetry(status)) {
          try {
            this.onDropBatch?.(lines, err);
          } catch {}
          return;
        }

        // Retry with either Retry-After (429/503) or exponential backoff
        attempt++;
        if (attempt > this.retry.retries) {
          try {
            this.onDropBatch?.(lines, err);
          } catch {}
          return;
        }

        const delayMs = retryAfterMs ?? this.computeBackoffMs(attempt);
        await this.sleep(delayMs);
        // loop and retry this same batch
      }
    }
  }

  private computeBackoffMs(attempt: number): number {
    const base = Math.min(this.retry.maxMs, this.retry.baseMs * 2 ** (attempt - 1));
    if (!this.retry.jitter) return base;
    return Math.floor(base * (0.5 + Math.random() * 0.5)); // full jitter [base/2, base)
  }

  private async sleep(ms: number) {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  /** Remove the oldest item across sessions (O(n) scan), used by drop-oldest policy. */
  private dropOldest() {
    for (const [, arr] of this.buffers) {
      if (arr && arr.length) {
        arr.shift();
        this.totalBuffered = Math.max(0, this.totalBuffered - 1);
        return;
      }
    }
  }
}
