import { mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { TracerEvent } from '../types';
import type { BufferedSink } from './types';

export type FileDeliveryMode = 'immediate' | 'buffered';

export interface FileSinkOptions {
  base?: string;
  delivery?: FileDeliveryMode;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBuffer?: number;
}

/**
 * Node.js file-based sink that appends events as JSONL lines.
 * Defaults to immediate/synchronous appends to `~/.accordkit/logs`.
 * Buffered mode is available for higher throughput with `flush()`/`close()`.
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

  /** @inheritdoc */
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

  async flush(): Promise<void> {
    for (const [sid] of Array.from(this.buffers.entries())) {
      this.flushSession(sid);
    }
  }

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
