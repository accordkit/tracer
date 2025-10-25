import { describe, it, expect, vi, beforeEach } from 'vitest';

import { compose, sample, maskPII } from '../src/core/middleware';

import type { MessageEvent } from '../src/core/types';

function baseEvent(): MessageEvent {
  return {
    ts: new Date(0).toISOString(),
    sessionId: 'sess_test',
    level: 'info',
    type: 'message',
    role: 'user',
    content: 'hello alice@example.com',
    ctx: { traceId: 'tr_x', spanId: 'sp_y' },
  };
}

describe('middleware', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.123456); // deterministic
  });

  it('compose runs in order and can drop events', async () => {
    const keep = (e: any) => ({ ...e, content: e.content + '!' });
    const drop = () => null;
    const run = compose([keep, drop, keep]);
    const out = await run(baseEvent());
    expect(out).toBeNull();
  });

  it('sample keeps when random < rate', async () => {
    const run = compose([sample(0.5)]);
    const out = await run(baseEvent());
    expect(out).not.toBeNull();
  });

  it('maskPII obfuscates @ in content', async () => {
    const run = compose([maskPII()]);
    const out = await run(baseEvent());
    expect((out as any)?.content).toContain('[at]');
    expect((out as any)?.content).not.toContain('@');
  });
});
