import { mkdirSync, appendFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TracerEvent } from '../types';
import type { BufferedSink, BufferedOptions, OverflowPolicy } from './types';

/**
 * Defines the delivery strategy for events to the file system.
 * - `immediate`: Events are written synchronously to a file as they are received.
 * - `buffered`: Events are collected in an in-memory queue and flushed periodically in batches.
 */
export type FileDeliveryMode = 'immediate' | 'buffered';

/**
 * Configuration options for the `FileSink`.
 */
export interface FileSinkOptions extends BufferedOptions {
  /**
   * The base directory where log files will be stored.
   * Each session will have its own `.jsonl` file inside this directory.
   * @default '~/.accordkit/logs' (resolved via `os.homedir()`)
   */
  base?: string;
  /**
   * The delivery strategy for events.
   * - `immediate`: Write each event to its file synchronously.
   * - `buffered`: Batch events in memory and flush them periodically.
   * @default 'immediate'
   */
  delivery?: FileDeliveryMode;
}

/**
 * A sink for Node.js environments that persists tracer events to the local file system.
 * Events are stored in JSON Lines (`.jsonl`) format, with a separate file for each session ID.
 *
 * It supports two delivery modes:
 * 1.  **`immediate`**: Synchronously appends each event to its corresponding file. This is simple and durable.
 * 2.  **`buffered`**: Collects events in memory and writes them to files in batches. This offers higher throughput
 *     and is recommended for high-volume tracing. Flushing occurs when a batch is full, on a timer, or manually.
 */
export class FileSink implements BufferedSink {
  private base: string;
  private delivery: FileDeliveryMode;

  private buffers: Map<string, TracerEvent[]> = new Map();
  private totalBuffered = 0;

  private batchSize: number;
  private flushIntervalMs: number;
  private maxBuffer: number;
  private overflowPolicy: OverflowPolicy;

  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private flushInFlight: Promise<void> | null = null;
  private flushRequested = false;

  /**
   * Creates an instance of FileSink.
   * @param opts - Configuration options for the sink.
   */
  constructor(opts: FileSinkOptions = {}) {
    this.base = opts.base ?? join(homedir(), '.accordkit', 'logs');
    this.delivery = opts.delivery ?? 'immediate';

    this.batchSize = opts?.batchSize ?? 100;
    this.flushIntervalMs = opts?.flushIntervalMs ?? 2000;
    this.maxBuffer = opts?.maxBuffer ?? 5000;
    this.overflowPolicy = opts?.overflowPolicy ?? 'auto-flush';

    if (this.delivery === 'buffered') {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      // @ts-ignore
      this.timer.unref?.();
    }
  }

  /**
   * Writes a tracer event to a file.
   *
   * In `immediate` mode, the event is synchronously appended to the session's log file.
   * In `buffered` mode, the event is added to an in-memory buffer for the session.
   */
  write(sessionId: string, e: TracerEvent) {
    if (this.closed) return;

    if (this.delivery == 'immediate') {
      mkdirSync(this.base, { recursive: true });
      appendFileSync(this.pathFor(sessionId), JSON.stringify(e) + '\n', 'utf8');
      return;
    }

    const buf = this.buffers.get(sessionId) ?? [];
    if (!this.buffers.has(sessionId)) this.buffers.set(sessionId, buf);

    if (this.totalBuffered >= this.maxBuffer && this.overflowPolicy === 'error') {
      throw new Error('FileSink buffer full');
    }

    buf.push(e);

    this.totalBuffered++;

    if (this.totalBuffered > this.maxBuffer) {
      switch (this.overflowPolicy) {
        case 'auto-flush': {
          // Trigger an immediate guarded flush.
          // Backpressure only while over capacity: return the flush promise
          // so the caller can await if desired.
          return this.flush();
        }
        case 'drop-oldest': {
          this.dropOldest();
          break;
        }
        case 'error': {
          // already handled above; unreachable here
          break;
        }
      }
    }
  }

  /**
   * Flushes all buffered events for all sessions to their respective files.
   *
   * This method is a no-op if the `delivery` mode is `immediate`.
   * In `buffered` mode, it forces a write of any pending events in memory.
   */
  async flush(): Promise<void> {
    if (this.delivery === 'immediate') return; // nothing to do

    if (this.closed && this.totalBuffered === 0) return;

    if (this.flushInFlight) {
      this.flushRequested = true;
      return this.flushInFlight;
    }

    this.flushInFlight = (async () => {
      try {
        await mkdir(this.base, { recursive: true });

        do {
          this.flushRequested = false;

          // Snapshot all current buffers into batches
          const toWrite = this.drainBatches();

          // Write sequentially per batch to preserve order
          for (const { sessionId, lines } of toWrite) {
            if (lines.length === 0) continue;

            const filePath = this.pathFor(sessionId);
            const payload = lines.join('\n') + '\n';
            await appendFile(filePath, payload, 'utf8');
          }
        } while (this.flushRequested);
      } finally {
        this.flushInFlight = null;
      }
    })();

    return this.flushInFlight;
  }

  /**
   * Cleans up resources used by the sink.
   *
   * This method stops the periodic flushing timer and performs a final flush of any remaining events.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private pathFor(sessionId: string) {
    return join(this.base, `${sessionId}.jsonl`);
  }

  private drainBatches(): Array<{ sessionId: string; lines: string[] }> {
    const out: Array<{ sessionId: string; lines: string[] }> = [];
    // Walk sessions; keep per-session order; chunk by batchSize
    for (const [sid, arr] of this.buffers) {
      if (arr.length === 0) continue;

      while (arr.length) {
        out.push({
          sessionId: sid,
          lines: arr.splice(0, this.batchSize).map((e) => JSON.stringify(e)),
        });
      }
      // keep the emptied array for future writes
      this.buffers.set(sid, arr);
    }

    // After full drain snapshot, recompute total count (will usually be 0)
    let cnt = 0;
    for (const [, arr] of this.buffers) {
      cnt += arr.length;
    }

    this.totalBuffered = cnt;
    return out;
  }

  private dropOldest() {
    for (const [sid, arr] of this.buffers) {
      if (arr.length) {
        arr.shift();
        this.totalBuffered = Math.max(0, this.totalBuffered - 1);
        if (!arr.length) this.buffers.set(sid, arr);
        return;
      }
    }
  }
}
