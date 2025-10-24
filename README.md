# @accordkit/tracer

[![Part of AccordKit](https://img.shields.io/badge/AccordKit-ecosystem-00cc88?style=flat-square)](https://github.com/accordkit)

> **Part of the [AccordKit](https://github.com/accordkit) ecosystem** —  
> an open, AI-agnostic tracing SDK for LLM-powered and ChatGPT-interoperable applications.  
> AccordKit gives developers local-first observability: **no vendor lock-in, no opaque dashboards**, just clean event streams and tools that work anywhere.

[🌍 Positioning Map →](https://github.com/accordkit/docs/blob/main/assets/accordkit_positioning_map.png)

Lightweight, vendor-agnostic instrumentation that emits **normalized AccordKit events** through a pluggable **sink**. The tracer ships with:
- Simple helpers for chat events, tool calls, usage metrics, and spans.
- Middleware support for sampling, masking, and custom transforms.
- Optional buffering hooks so long-running jobs can flush/close sinks on shutdown.

## Installation
```bash
pnpm add @accordkit/tracer @accordkit/core
# or: npm install @accordkit/tracer @accordkit/core
```

## Quickstart
```ts
import { Tracer } from '@accordkit/tracer';
import { FileSink } from '@accordkit/core';

const tracer = new Tracer({
  sink: new FileSink({ basePath: './logs' }),
  service: 'checkout',
  env: 'dev',
  region: 'eu-west-1',
});

await tracer.message({
  type: 'message',
  role: 'system',
  content: 'Hello from AccordKit',
} as any);

const span = tracer.spanStart({ operation: 'fetch.users' });
// ... do work ...
await tracer.spanEnd(span, { status: 'ok', attrs: { rows: 42 } });
```

## Choosing a Sink
All sinks implement `Sink` from `@accordkit/core`, exposing a single `write(sessionId, event)` method. Some sinks also implement `BufferedSink`, adding `flush()` and optional `close()` for controlled delivery.

- **FileSink (Node.js)** – JSONL per session, optional buffered mode via `delivery: 'buffered'`.
- **BrowserSink (Web)** – Persists to `localStorage` under `accordkit:{sessionId}`.
- **HttpSink (Node.js / Web)** – Batches events to an HTTP endpoint; falls back to best effort delivery.

`Tracer` only depends on the interface, so you can bring your own sink or test with an in-memory implementation.

### Buffered vs Immediate Delivery
Buffered sinks accumulate events before writing them out. Tracer forwards `flush()` and `close()` so your app can do:
```ts
await tracer.flush(); // ensure buffered events are persisted
await tracer.close(); // close transport (if supported)
```
If the sink lacks `close()`, the tracer falls back to `flush()`. For immediate sinks, both methods are no-ops.

## Lifecycle Options
```ts
const tracer = new Tracer({
  sink: new HttpSink({ url: 'https://trace.ingest' }),
  middlewares: [sample(0.1), maskPII()],
  defaultLevel: 'warn',
  sessionId: 'session-123', // optional override
  service: 'support-bot',
  env: 'prod',
  region: 'us-east-1',
});
```

- `defaultLevel` sets the log level for emitted events (`info` by default).
- `sessionId` can be provided for deterministic sessions (otherwise generated).
- `service`, `env`, and `region` tags propagate on every event.
- `middlewares` run sequentially. Return `null` from a middleware to drop the event.

## Emitting Events
```ts
await tracer.message({ role: 'user', content: 'Hi there!' } as any);
await tracer.toolCall({ tool: 'weather', input: { city: 'AMS' } } as any);
await tracer.toolResult({ tool: 'weather', output: { temp: 12 }, ok: true } as any);
await tracer.usage({ inputTokens: 100, outputTokens: 18, cost: 0.02 } as any);
```
Each helper injects timestamps, session id, level, and (if needed) a fresh trace context.

## Spans
```ts
const parent = tracer.spanStart({ operation: 'db.query' });

const child = tracer.spanStart({
  operation: 'cache.lookup',
  parentSpanId: parent.ctx.spanId,
});

/* ... */

await tracer.spanEnd(child, { status: 'ok' });
await tracer.spanEnd(parent, { status: 'error', attrs: { reason: 'timeout' } });
```
- `spanStart` returns `{ ctx, operation, t0, attrs }`. Reuse `ctx` on related events.
- `spanEnd` computes `durationMs`, merges attributes provided at start and end, and defaults `status` to `ok`.

## Testing
For unit tests, supply a simple `Sink` double:
```ts
class MemorySink {
  events = [];
  write(_sessionId, event) {
    this.events.push(event);
  }
}

const tracer = new Tracer({ sink: new MemorySink() });
```
If you need to assert `flush()`/`close()` calls, implement the `BufferedSink` interface in your test double.

## Further Reading
- Core event schema and sink details: `@accordkit/core` docs (`docs/CORE.md`).
- Middleware helpers: `sample(rate)`, `maskPII()`, or roll your own by returning either a transformed event or `null`.
- Full TypeScript signatures are documented via TSDoc; run `pnpm run docs` in the repo to generate API documentation.
