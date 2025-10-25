import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TracerEvent } from '../types';
import type { BufferedSink } from './types';

/**
 * Defines the delivery strategy for events to the file system.
 * - `immediate`: Events are written synchronously to a file as they are received.
 * - `buffered`: Events are collected in an in-memory queue and flushed periodically in batches.
 */
export type FileDeliveryMode = 'immediate' | 'buffered';

/**
 * Configuration options for the `FileSink`.
 */
export interface FileSinkOptions {
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
  /**
   * The number of events to collect in a session's buffer before triggering a flush.
   * Only applies to `buffered` delivery mode.
   * @default 100
   */
  batchSize?: number;
  /**
   * The maximum time in milliseconds to wait before flushing buffers, regardless of their size.
   * Only applies to `buffered` delivery mode.
   * @default 1000
   */
  flushIntervalMs?: number;
  /**
   * The maximum total number of events to keep in memory across all session buffers.
   * If the total exceeds this size, the oldest events from the largest buffer will be dropped.
   * This prevents unbounded memory growth.
   * Only applies to `buffered` delivery mode.
   * @default 5000
   */
  maxBuffer?: number;
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
  private batchSize: number;
  private flushIntervalMs: number;
  private maxBuffer: number;
  private buffers: Map<string, TracerEvent[]> = new Map();
  private totalBuffered = 0;
  private timer?: ReturnType<typeof setInterval>;

  /**
   * Creates an instance of FileSink.
   * @param opts - Configuration options for the sink.
   */
  constructor(opts: FileSinkOptions = {}) {
    this.base = opts.base ?? join(homedir(), '.accordkit', 'logs');
    this.delivery = opts.delivery ?? 'immediate';
    this.batchSize = Math.max(1, opts.batchSize ?? 100);
    this.flushIntervalMs = Math.max(50, opts.flushIntervalMs ?? 1000);
    this.maxBuffer = Math.max(this.batchSize, opts.maxBuffer ?? 5000);

    if (this.delivery === 'buffered') {
      this.ensureTimer();
    }
  }

  /**
   * Writes a tracer event to a file.
   *
   * In `immediate` mode, the event is synchronously appended to the session's log file.
   * In `buffered` mode, the event is added to an in-memory buffer for the session.
   */
  write(sessionId: string, e: TracerEvent) {
    if (this.delivery == 'immediate') {
      mkdirSync(this.base, { recursive: true });
      appendFileSync(join(this.base, `${sessionId}.jsonl`), JSON.stringify(e) + '\n', 'utf8');
      return;
    }

    const buf = this.buffers.get(sessionId) ?? [];
    buf.push(e);

    this.buffers.set(sessionId, buf);
    this.totalBuffered++;

    if (buf.length >= this.batchSize || this.totalBuffered >= this.maxBuffer) {
      if (this.totalBuffered >= this.maxBuffer) this.dropOldest();
      this.flushSession(sessionId);
    }
  }

  /**
   * Flushes all buffered events for all sessions to their respective files.
   *
   * This method is a no-op if the `delivery` mode is `immediate`.
   * In `buffered` mode, it forces a write of any pending events in memory.
   */
  async flush(): Promise<void> {
    for (const [sid] of Array.from(this.buffers.entries())) {
      this.flushSession(sid);
    }
  }

  /**
   * Cleans up resources used by the sink.
   *
   * This method stops the periodic flushing timer and performs a final flush of any remaining events.
   */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }

  private ensureTimer() {
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const [sid, events] of this.buffers) {
          if (events.length) this.flushSession(sid);
        }
      }, this.flushIntervalMs);
      // @ts-ignore: Node timers expose unref
      this.timer.unref?.();
    }
  }

  private flushSession(sessionId: string) {
    const buf = this.buffers.get(sessionId);
    if (!buf || buf.length === 0) return;

    const chunk = buf.map((e) => JSON.stringify(e)).join('\n') + '\n';
    this.buffers.set(sessionId, []);
    this.totalBuffered -= buf.length;
    
    mkdirSync(this.base, { recursive: true });
    appendFileSync(join(this.base, `${sessionId}.jsonl`), chunk, 'utf8');
  }

  private dropOldest() {
    for (const [_, arr] of this.buffers) {
      if (arr.length) {
        arr.shift();
        this.totalBuffered = Math.max(0, this.totalBuffered - 1);
        return;
      }
    }
  }
}
