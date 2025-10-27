import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { FileSink } from '../src/core/sinks/fileSink';

import type { TracerEvent } from '../src/core/types';

function msg(sessionId = 's1', i = 0): TracerEvent {
  return {
    ts: new Date(1000 + i).toISOString(),
    sessionId,
    level: 'info',
    type: 'message',
    content: `hi ${i}`,
  } as any;
}

function readLines(p: string): string[] {
  if (!existsSync(p)) return [];
  const txt = readFileSync(p, 'utf8').trim();
  return txt ? txt.split('\n') : [];
}

describe('FileSink — immediate mode', () => {
  it('writes a single line JSONL synchronously', () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-file-'));
    const sink = new FileSink({ base, delivery: 'immediate' });

    sink.write('s1', msg('s1', 1));
    const file = join(base, 's1.jsonl');

    const lines = readLines(file);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('message');
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.content).toBe('hi 1');
  });

  it('respects session separation (different files)', () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-file-'));
    const sink = new FileSink({ base, delivery: 'immediate' });

    sink.write('a', msg('a', 1));
    sink.write('b', msg('b', 2));

    const a = readLines(join(base, 'a.jsonl'));
    const b = readLines(join(base, 'b.jsonl'));

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(JSON.parse(a[0]).sessionId).toBe('a');
    expect(JSON.parse(b[0]).sessionId).toBe('b');
  });
});

describe('FileSink — buffered mode', () => {
  beforeEach(() => {
    vi.useRealTimers(); // default per test unless we explicitly fake timers
  });

  it('buffers and flushes to disk on flush()', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    sink.write('s1', msg('s1', 2));

    // nothing yet
    expect(readLines(join(base, 's1.jsonl')).length).toBe(0);

    await sink.flush();

    const lines = readLines(join(base, 's1.jsonl'));
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).content).toBe('hi 2');
  });

  it('periodic flush writes automatically on interval', async () => {
    vi.useFakeTimers();
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({ base, delivery: 'buffered', batchSize: 100, flushIntervalMs: 10 });
    const flushSpy = vi.spyOn(sink, 'flush');

    try {
      sink.write('s1', msg('s1', 1));
      sink.write('s1', msg('s1', 2));

      // Advance timers to trigger the interval.
      await vi.advanceTimersByTimeAsync(10);

      // The timer should have called flush.
      expect(flushSpy).toHaveBeenCalledOnce();

      // Wait for the flush promise to resolve, ensuring I/O is complete.
      await flushSpy.mock.results[0].value;

      const lines = readLines(join(base, 's1.jsonl'));
      expect(lines.length).toBe(2);
    } finally {
      vi.useRealTimers();
      await sink.close();
      flushSpy.mockRestore();
    }
  });

  it('chunking by batchSize still yields all lines after flush', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 2,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    sink.write('s1', msg('s1', 2));
    sink.write('s1', msg('s1', 3));

    await sink.flush();

    const lines = readLines(join(base, 's1.jsonl'));
    expect(lines.length).toBe(3);
    const last = JSON.parse(lines[2]);
    expect(last.content).toBe('hi 3');
  });

  it('auto-flush on full: write() returns a Promise (backpressure) only when over capacity', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 100,
      maxBuffer: 2,
      overflowPolicy: 'auto-flush',
      flushIntervalMs: 60_000,
    });

    const r1 = sink.write('s1', msg('s1', 1));
    const r2 = sink.write('s1', msg('s1', 2));
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();

    const r3 = sink.write('s1', msg('s1', 3));
    expect(r3).toBeInstanceOf(Promise);

    await r3; // backpressure: await the auto-triggered flush

    const lines = readLines(join(base, 's1.jsonl'));
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[2]).content).toBe('hi 3');
  });

  it('drop-oldest: oldest entries are removed under sustained overflow', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 100,
      maxBuffer: 2,
      overflowPolicy: 'drop-oldest',
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    sink.write('s1', msg('s1', 2));
    sink.write('s1', msg('s1', 3)); // should drop '1'

    await sink.flush();

    const lines = readLines(join(base, 's1.jsonl'));
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).content).toBe('hi 2');
    expect(JSON.parse(lines[1]).content).toBe('hi 3');
  });

  it('error policy: throws when writing over capacity', () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 100,
      maxBuffer: 1,
      overflowPolicy: 'error',
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    expect(() => sink.write('s1', msg('s1', 2))).toThrowError(/buffer full/i);
  });

  it('no overlapping flushes: concurrent flush() calls return the same promise', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 2,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    sink.write('s1', msg('s1', 2));

    const p1 = sink.flush();
    const p2 = sink.flush();
    expect(p1).toStrictEqual(p2);

    await p1;

    const lines = readLines(join(base, 's1.jsonl'));
    expect(lines.length).toBe(2);
  });

  it('close(): deterministic shutdown — drains and prevents further writes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-buf-'));
    const sink = new FileSink({
      base,
      delivery: 'buffered',
      batchSize: 100,
      flushIntervalMs: 60_000,
    });

    sink.write('s1', msg('s1', 1));
    sink.write('s1', msg('s1', 2));

    await sink.close();

    // All buffered lines should be flushed
    const linesAfterClose = readLines(join(base, 's1.jsonl'));
    expect(linesAfterClose.length).toBe(2);

    // Subsequent writes are no-ops
    sink.write('s1', msg('s1', 3));
    const linesStill = readLines(join(base, 's1.jsonl'));
    expect(linesStill.length).toBe(2);
  });
});
