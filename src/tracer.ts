import {
  compose,
  newTraceCtx,
  nowISO,
  type BufferedSink,
  type Sink,
  type TraceMiddleware,
  type TracerEvent,
} from './core';

/** Narrow a TracerEvent union by its discriminant type. */
type EventByType<T extends TracerEvent['type']> = Extract<TracerEvent, { type: T }>;

/** Input shape accepted by `emit` (base fields are injected inside `emit`). */
type EmitInput<T extends TracerEvent> = Omit<T, 'ts' | 'sessionId' | 'level' | 'ctx'> & {
  ctx?: T['ctx'];
};

/** Log level used for events emitted by the tracer. */
export type Level = 'debug' | 'info' | 'warn' | 'error';

/** Token returned from {@link Tracer.spanStart}; pass it to {@link Tracer.spanEnd}. */
export interface SpanToken {
  /** Trace context associated with this span. Reuse it on related events. */
  ctx: { traceId: string; spanId: string; parentSpanId?: string };
  /** Operation name (e.g., `db.query`, `http.request`). */
  operation: string;
  /** Start time (epoch ms). */
  t0: number;
  /** Span attributes captured at start. */
  attrs?: Record<string, unknown>;
}

/** Options to construct a {@link Tracer} instance. */
export interface TracerOptions {
  /** Optional fixed session id; auto-generated if omitted. */
  sessionId?: string;
  /** Destination that persists events (file, browser, http, etc.). */
  sink: Sink | BufferedSink;
  /** Middlewares to transform/sample/drop events. */
  middlewares?: TraceMiddleware[];
  /** Default log level applied to emitted events. */
  defaultLevel?: Level;
  /** Optional environment tags propagated on each event. */
  service?: string;
  env?: string;
  region?: string;
}

/**
 * Lightweight, vendor-agnostic tracer that emits normalized AccordKit events
 * to a pluggable {@link Sink}. Middlewares can transform or drop events.
 *
 * If the provided sink implements {@link BufferedSink}, `flush()` and `close()` will
 * be proxied for graceful delivery on shutdown.
 */
export class Tracer {
  /** The logical session id used to partition trace logs. */
  public readonly sessionId: string;

  private sink: Sink | BufferedSink;
  private runMw: (e: TracerEvent) => Promise<TracerEvent | null>;
  private level: Level;
  private tags: { service?: string; env?: string; region?: string };

  /**
   * Create a new tracer.
   */
  constructor(opts: TracerOptions) {
    this.sessionId = opts.sessionId || `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.sink = opts.sink;
    this.runMw = compose(opts.middlewares || []);
    this.level = opts.defaultLevel ?? 'info';
    this.tags = { service: opts.service, env: opts.env, region: opts.region };
  }

  /**
   * Compose a base event with defaults and run middleware + sink.
   * @internal
   */
  private emit<T extends TracerEvent>(e: EmitInput<T>): Promise<void | unknown> {
    const base: T = {
      ...e,
      ts: nowISO(),
      sessionId: this.sessionId,
      level: this.level,
      ctx: e.ctx || newTraceCtx(),
      service: this.tags.service,
      env: this.tags.env,
      region: this.tags.region,
    } as T;

    return this.runMw(base).then((x) => {
      if (x) return this.sink.write(this.sessionId, x);
    });
  }

  /**
   * Emit a `message` event (system/user/assistant/tool).
   */
  message(
    e: Omit<EventByType<'message'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'message'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'message'>>({ ...e, type: 'message' });
  }

  /**
   * Emit a `tool_call` event.
   */
  toolCall(
    e: Omit<EventByType<'tool_call'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'tool_call'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'tool_call'>>({ ...e, type: 'tool_call' });
  }

  /**
   * Emit a `tool_result` event.
   */
  toolResult(
    e: Omit<EventByType<'tool_result'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'tool_result'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'tool_result'>>({ ...e, type: 'tool_result' });
  }

  /**
   * Emit a `usage` event (tokens/cost).
   */
  usage(
    e: Omit<EventByType<'usage'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'usage'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'usage'>>({ ...e, type: 'usage' });
  }

  /**
   * Start a span; returns a token to later pass to {@link spanEnd}.
   * Any emitted event can reuse `token.ctx` to relate messages to this span.
   */
  spanStart(args: {
    operation: string;
    attrs?: Record<string, unknown>;
    parentSpanId?: string;
  }): SpanToken {
    const ctx = args.parentSpanId ? { ...newTraceCtx(args.parentSpanId) } : newTraceCtx();
    const t0 = Date.now();
    return { ctx, t0, operation: args.operation, attrs: args.attrs };
  }

  /**
   * Finish a span and emit a `span` event with computed duration.
   * Defaults to `status='ok'`; set `status='error'` if the span failed.
   */
  spanEnd(token: SpanToken, end?: { status?: 'ok' | 'error'; attrs?: Record<string, unknown> }) {
    const durationMs = Date.now() - token.t0;

    return this.emit<EventByType<'span'>>({
      type: 'span',
      operation: token.operation,
      durationMs,
      status: end?.status ?? 'ok',
      attrs: { ...(token.attrs || {}), ...(end?.attrs || {}) },
      ctx: token.ctx,
    });
  }

  /**
   * If the underlying sink buffers, flush any queued events to durable storage.
   * No-op for sinks that write immediately.
   */
  async flush(): Promise<void> {
    const s = this.sink as Partial<BufferedSink>;
    if (typeof s.flush === 'function') {
      await s.flush();
    }
  }

  /**
   * If the underlying sink buffers, close timers and flush remaining events.
   * No-op for sinks that write immediately.
   */
  async close(): Promise<void> {
    const s = this.sink as Partial<BufferedSink>;
    if (typeof s.close === 'function') {
      await s.close();
    } else if (typeof s.flush === 'function') {
      await s.flush();
    }
  }
}
