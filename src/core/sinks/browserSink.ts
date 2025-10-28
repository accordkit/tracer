/* eslint-disable no-empty */
/* eslint-env browser */
import type { TracerEvent } from '../types';
import type { BufferedSink, BufferedOptions, OverflowPolicy } from './types';

export type BrowserDeliveryMode = 'immediate' | 'buffered';

export interface BrowserSinkOptions extends BufferedOptions {
  /** POST endpoint to deliver logs. If omitted, flushes are no-ops (buffer cleared). */
  endpoint?: string;
  /** Extra headers for fetch fallback (content-type defaults to application/json). */
  headers?: Record<string, string>;
  /** Max payload size for sendBeacon (default: 60 KiB). */
  beaconMaxBytes?: number;
  /** Delivery mode: 'immediate' (send on write) or 'buffered' (periodic/explicit flush). Default: 'buffered'. */
  delivery?: BrowserDeliveryMode;
  /** Called when a batch is dropped (e.g., fetch fails in immediate mode). */
  onDropBatch?: (lines: string[], error?: unknown) => void;
  /** Durability: 'none' (default) | 'idb' for IndexedDB-backed queue. */
  durable?: 'none' | 'idb';
  /** IndexedDB database name (when durable === 'idb'). Default: 'accordkit' */
  idbName?: string;
  /** IndexedDB object store name (when durable === 'idb'). Default: 'events' */
  idbStore?: string;
  /** IndexedDB version (when durable === 'idb'). Default: 1 */
  idbVersion?: number;
}

/**
 * BrowserSink
 * Buffered (or immediate) delivery of JSONL batches to an HTTP endpoint from the browser.
 * - Uses navigator.sendBeacon for small payloads (≤ beaconMaxBytes), else falls back to fetch(keepalive).
 * - Guarded flushes: no overlap; close() drains deterministically.
 * - Optional durable storage via IndexedDB (survives reloads/crashes). When enabled:
 *     - flush() moves RAM buffers -> IDB, then dequeues from IDB in batchSize chunks.
 *     - chunks are deleted from IDB only after successful delivery.
 *     - failures leave data in IDB for next flush (no data loss).
 */
export class BrowserSink implements BufferedSink {
  private readonly endpoint?: string;
  private readonly headers: Record<string, string>;
  private readonly beaconMax: number;
  private readonly delivery: BrowserDeliveryMode;
  private readonly onDropBatch?: (lines: string[], error?: unknown) => void;

  // Durability
  private readonly durable: 'none' | 'idb';
  private readonly idbName: string;
  private readonly idbStore: string;
  private readonly idbVersion: number;

  // In-memory per-session buffers (FIFO)
  private readonly buffers = new Map<string, string[]>();
  private totalBuffered = 0;

  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBuffer: number;
  private readonly overflowPolicy: OverflowPolicy;

  private flushInFlight: Promise<void> | null = null;
  private flushRequested = false;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  // Exit handlers
  private readonly unloadHandler = () => {
    void this.flush();
  };
  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  constructor(opts?: BrowserSinkOptions) {
    this.endpoint = opts?.endpoint;
    this.headers = { 'content-type': 'application/json', ...(opts?.headers ?? {}) };
    this.beaconMax = opts?.beaconMaxBytes ?? 60 * 1024; // conservative cap
    this.delivery = opts?.delivery ?? 'buffered';
    this.onDropBatch = opts?.onDropBatch;

    this.durable = opts?.durable ?? 'none';
    this.idbName = opts?.idbName ?? 'accordkit';
    this.idbStore = opts?.idbStore ?? 'events';
    this.idbVersion = opts?.idbVersion ?? 1;

    this.batchSize = opts?.batchSize ?? 100;
    this.flushIntervalMs = opts?.flushIntervalMs ?? 2000;
    this.maxBuffer = opts?.maxBuffer ?? 1000;
    this.overflowPolicy = opts?.overflowPolicy ?? 'auto-flush';

    if (this.delivery === 'buffered') {
      this.timer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.unloadHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  public write(sessionId: string, e: TracerEvent): void | Promise<void> {
    if (this.closed) return;

    // Immediate mode, attempt to send now without buffering.
    if (this.delivery === 'immediate') {
      return this.sendNow(JSON.stringify(e) + '\n').catch((err) => {
        try {
          this.onDropBatch?.([JSON.stringify(e)], err);
        } catch {}
      });
    }

    // Buffered mode
    const line = JSON.stringify(e);
    const existing = this.buffers.get(sessionId);
    const arr = existing ?? [];
    if (!existing) this.buffers.set(sessionId, arr);

    if (this.totalBuffered >= this.maxBuffer && this.overflowPolicy === 'error') {
      throw new Error('BrowserSink buffer full');
    }

    arr.push(line);
    this.totalBuffered++;

    // If a flush is already running, make sure we take another pass when it finishes
    if (this.flushInFlight) {
      this.flushRequested = true;
    }

    if (this.totalBuffered > this.maxBuffer) {
      switch (this.overflowPolicy) {
        case 'auto-flush':
          // Trigger guarded flush, backpressure only while over capacity
          return this.flush();
        case 'drop-oldest':
          this.dropOldest();
          break;
        case 'error':
          // handled above
          break;
      }
    }
  }

  /** Public flush: serialized, drains RAM buffers (-> IDB if enabled) then IDB in batchSize chunks with sendBeacon/fetch. */
  public async flush(): Promise<void> {
    if (this.delivery === 'immediate') return;
    if (this.closed && this.totalBuffered === 0 && this.durable !== 'idb') return;

    if (this.flushInFlight) {
      this.flushRequested = true;
      return this.flushInFlight;
    }

    this.flushInFlight = (async () => {
      try {
        do {
          this.flushRequested = false;

          if (this.durable === 'idb') {
            const ram = this.drainAllFromRam(); // returns flat lines[]
            if (ram.length > 0) {
              await this.idbBulkAdd(ram);
            }
            // Dequeue from IDB in batches and deliver and delete on success
            // Stop on first delivery failure to avoid starving the UI, data remains durable.
            for (;;) {
              const { ids, lines } = await this.idbTakeBatch(this.batchSize);
              if (lines.length === 0) break;
              const body = lines.join('\n') + '\n';
              try {
                await this.send(body);
                await this.idbDelete(ids);
              } catch {
                // Leave records in IDB for next flush
                break;
              }
            }
          } else {
            // Non-durable, drain from RAM in interleaved session batches
            const batches = this.drainBatches();
            for (const lines of batches) {
              if (lines.length === 0) continue;
              const body = lines.join('\n') + '\n';
              try {
                await this.send(body);
              } catch (err) {
                // Best-effort: drop this batch and continue
                try {
                  this.onDropBatch?.(lines, err);
                } catch {}
              }
            }
          }
        } while (this.flushRequested);
      } finally {
        this.flushInFlight = null;
      }
    })();

    return this.flushInFlight;
  }

  /** Deterministic shutdown, idempotent, clears timers and handlers, drains fully. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.timer) clearInterval(this.timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.unloadHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }

    await this.flush();
  }

  /** Drain all in-memory buffers to a flat array of lines and clears RAM. */
  private drainAllFromRam(): string[] {
    if (this.totalBuffered === 0) return [];
    const out: string[] = [];
    for (const [, arr] of this.buffers) {
      if (arr && arr.length) out.push(...arr.splice(0, arr.length));
    }
    this.totalBuffered = 0;
    return out;
  }

  /** Drain from RAM into batches, interleaving sessions to avoid starvation. */
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

  /** Try sendBeacon if available & payload small; otherwise fallback to fetch(keepalive). */
  private async send(body: string): Promise<void> {
    if (!this.endpoint) return; // nothing to do; treat as delivered (buffer cleared)

    const bytes = this.byteLength(body);
    const canBeacon =
      typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';

    if (canBeacon && bytes <= this.beaconMax) {
      const ok = navigator.sendBeacon(
        this.endpoint,
        new Blob([body], { type: 'application/json' }),
      );
      if (ok) return; // best-effort delivered
      // fall through to fetch when beacon refuses
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body,
      keepalive: true,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  }

  /** Used by immediate mode, try once (beacon -> fetch). */
  private async sendNow(body: string): Promise<void> {
    try {
      await this.send(body);
    } catch (err) {
      try {
        this.onDropBatch?.([body.trim()], err);
      } catch {}
    }
  }

  private byteLength(s: string): number {
    // TextEncoder is the standard and preferred way to get byte length
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;

    // Fallback for very old browsers without TextEncoder.
    // This is an approximation that is good enough for payload sizing.
    // It correctly handles multi-byte characters by iterating through the string.
    let byteLength = s.length;
    for (let i = s.length - 1; i >= 0; i--) {
      const code = s.charCodeAt(i);
      if (code > 0x7f && code <= 0x7ff) byteLength++;
      else if (code > 0x7ff) byteLength += 2;
    }
    return byteLength;
  }

  /** Remove the oldest item across sessions (O(n) scan). */
  private dropOldest() {
    for (const [, arr] of this.buffers) {
      if (arr && arr.length) {
        arr.shift();
        this.totalBuffered = Math.max(0, this.totalBuffered - 1);
        return;
      }
    }
  }

  // IndexedDB durability
  private async idbOpen(): Promise<IDBDatabase> {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.idbName, this.idbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.idbStore)) {
          // keyPath auto-increment for FIFO; store minimal payload
          db.createObjectStore(this.idbStore, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /** Add many lines in a single readwrite transaction. */
  private async idbBulkAdd(lines: string[]): Promise<void> {
    const db = await this.idbOpen();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.idbStore, 'readwrite');
      const store = tx.objectStore(this.idbStore);
      for (const line of lines) {
        store.add({ line });
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const err = tx.error;
        db.close();
        reject(err);
      };
      tx.onabort = () => {
        const err = tx.error;
        db.close();
        reject(err);
      };
    });
  }

  /** Take up to `limit` records in FIFO order without deleting them. */
  private async idbTakeBatch(limit: number): Promise<{ ids: number[]; lines: string[] }> {
    const db = await this.idbOpen();
    return new Promise<{ ids: number[]; lines: string[] }>((resolve, reject) => {
      const tx = db.transaction(this.idbStore, 'readonly');
      const store = tx.objectStore(this.idbStore);
      const ids: number[] = [];
      const lines: string[] = [];

      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result as IDBCursorWithValue | null;
        if (!cursor || ids.length >= limit) {
          db.close();
          resolve({ ids, lines });
          return;
        }
        const val = cursor.value as { id: number; line: string };
        ids.push(val.id);
        lines.push(val.line);
        cursor.continue();
      };
      req.onerror = () => {
        const err = req.error;
        db.close();
        reject(err);
      };
    });
  }

  /** Delete records by id in a single readwrite transaction. */
  private async idbDelete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.idbOpen();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.idbStore, 'readwrite');
      const store = tx.objectStore(this.idbStore);
      for (const id of ids) {
        store.delete(id);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        const err = tx.error;
        db.close();
        reject(err);
      };
      tx.onabort = () => {
        const err = tx.error;
        db.close();
        reject(err);
      };
    });
  }
}
