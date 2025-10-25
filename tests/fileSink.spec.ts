import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { FileSink } from '../src/core/sinks/fileSink';

import type { MessageEvent } from '../src/core/types';

function event(i: number | null = null): MessageEvent {
  return {
    ts: new Date(0 + (i ?? 0)).toISOString(),
    sessionId: 's1',
    level: 'info',
    type: 'message',
    role: 'user',
    content: i ? 'hi ' + i : 'hi',
    ctx: { traceId: 'tr1', spanId: 'sp1' },
  };
}

describe('FileSink', () => {
  it('writes jsonl to custom base', () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-core-'));
    const sink = new FileSink({ base, delivery: 'immediate' });

    sink.write('s1', event());

    const data = readFileSync(join(base, 's1.jsonl'), 'utf8').trim();
    const parsed = JSON.parse(data);

    expect(parsed.type).toBe('message');
    expect(parsed.sessionId).toBe('s1');
  });
});

describe('FileSink buffered', () => {
  it('buffers by batchSize and flushes to disk', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ak-core-buf-'));
    const sink = new FileSink({ base, delivery: 'buffered', batchSize: 2, flushIntervalMs: 10000 });

    sink.write('s-buf', event(1));
    sink.write('s-buf', event(2)); // triggers flush

    const data = readFileSync(join(base, 's-buf.jsonl'), 'utf8').trim().split('\n');
    expect(data.length).toBe(2);

    const last = JSON.parse(data[1]);
    expect(last.content).toBe('hi 2');
  });
});
