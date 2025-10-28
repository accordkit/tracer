# @accordkit/tracer

[![Part of AccordKit](https://img.shields.io/badge/AccordKit-ecosystem-00cc88?style=flat-square)](https://github.com/accordkit)

> **Part of the [AccordKit](https://github.com/accordkit) ecosystem** —  
> an open, AI-agnostic tracing SDK for LLM-powered and ChatGPT-interoperable applications.  
> AccordKit gives developers local-first observability: **no vendor lock-in, no opaque dashboards**, just clean event streams and tools that work anywhere.

[🌍 Positioning Map →](https://github.com/accordkit/docs/blob/main/assets/accordkit_positioning_map.png)

Lightweight, vendor-agnostic tracing core for AccordKit — designed for SDKs, AI agents, and self-hosted analytics.  
Provides a unified `Tracer` interface with message, usage, and span events that can be streamed or batched to any sink.

---

## ✨ Features

- **Unified tracing model** for messages, tool calls, spans, and usage.
- **Parent–child span propagation** with accurate `durationMs`.
- **Middleware pipeline** for sampling, transformation, or enrichment.
- **Buffered and immediate sinks** with `flush()` / `close()` for graceful shutdowns.
- **No vendor lock-in** — integrate with your own backend, file sink, or AccordKit Cloud.

---

## 📦 Installation

```bash
pnpm add @accordkit/tracer
# or
npm install @accordkit/tracer
```

## 🚀 QuickStart

```ts
import { Tracer } from '@accordkit/tracer';

// simplest usage
const tracer = new Tracer({
  sink: { write: (_session, e) => console.log('trace event', e) },
  service: 'demo-service',
  env: 'dev',
});

// emit a message
await tracer.message({ role: 'user', content: 'hello, Trabzon!' });

// start a span
const span = tracer.spanStart({ operation: 'db.query' });
// ... perform some work ...
await tracer.spanEnd(span, { status: 'ok', attrs: { rows: 61 } });
```

## 🧩 Span Lifecycle

```ts
const parent = tracer.spanStart({ operation: 'request' });
const child = tracer.spanStart({ operation: 'fetch.users', parent });
await tracer.spanEnd(child, { attrs: { count: 3 } });
await tracer.spanEnd(parent);
```

When a parent is provided, the new span inherits the parent’s traceId and sets its parentSpanId to the parent’s spanId.

Each span produces a SpanEvent with:

```ts
{
  type: 'span',
  operation: string,
  durationMs: number,
  status: 'ok' | 'error',
  ctx: { traceId, spanId, parentSpanId? },
  service?: string,
  env?: string,
  region?: string,
}
```

- ### 🧠 Types

```ts
interface SpanToken {
  ctx: { traceId: string; spanId: string; parentSpanId?: string };
  operation: string;
  service?: string;
  env?: string;
  region?: string;
  attrs?: Record<string, unknown>;
  t0: number;
}

interface SpanStartOptions {
  operation: string;
  service?: string;
  env?: string;
  region?: string;
  attrs?: Record<string, unknown>;
  parent?:
    | SpanToken
    | { traceId: string; spanId: string }
    | { ctx: { traceId: string; spanId: string } };
}
```

## ⚙️ Middleware

Middleware functions can transform, enrich, or drop events before they reach the sink.

```ts
import type { TraceMiddleware } from '@accordkit/tracer';

const redact: TraceMiddleware = (e) => {
  if (e.type === 'message' && typeof e.content === 'string') {
    e.content = e.content.replace(/secret/gi, '[REDACTED]');
  }
  return e;
};

const tracer = new Tracer({ sink, middlewares: [redact] });
```

## 🧺 Choosing a Sink

All sinks implement `Sink` from `@accordkit/tracer`, exposing a single `write(sessionId, event)` method. Some sinks also implement `BufferedSink`, adding `flush()` and optional `close()` for controlled delivery.

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

region is optional and propagated to all emitted events (useful for multi-region ingestion).

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
const child = tracer.spanStart({ operation: 'cache.lookup', parent });

/* ... */

await tracer.spanEnd(child, { status: 'ok' });
await tracer.spanEnd(parent, { status: 'error', attrs: { reason: 'timeout' } });
```

- `spanStart` returns `{ ctx, operation, t0, attrs }`. Reuse `ctx` on related events.
- `spanEnd` computes `durationMs`, merges attributes provided at start and end, and defaults `status` to `ok`.

## 🧪 Testing

This package ships with comprehensive Vitest coverage under tests/, validating:

- span lifecycle and duration
- parent propagation
- middleware execution
- sink buffering and idempotency
- attribute merge and tag propagation

Run:

```bash
pnpm vitest
```

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

- Core event schema and sink details: `@accordkit/tracer` docs (`docs/CORE.md`).
- Middleware helpers: `sample(rate)`, `maskPII()`, or roll your own by returning either a transformed event or `null`.
- Full TypeScript signatures are documented via TSDoc; run `pnpm run docs` in the repo to generate API documentation.

---

### 🧱 Repository structure

This package is part of the [AccordKit](https://github.com/accordkit) organization:

- [`@accordkit/provider-openai`](https://github.com/accordkit/provider-openai) — OpenAI API adapter with automatic trace streaming
- [`@accordkit/viewer`](https://github.com/accordkit/viewer) — local-first viewer for traces
- [`@accordkit/docs`](https://github.com/accordkit/docs) — developer documentation site
- [`@accordkit/examples`](https://github.com/accordkit/examples) — sample integrations

---

## 🪪 License

MIT © AccordKit Contributors

## 🤝 Contributing

Issues and PRs welcome!  
Please follow the [AccordKit Contribution Guide](https://github.com/accordkit/tracer/blob/main/CONTRIBUTING.md).
