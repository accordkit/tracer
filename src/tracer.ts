import {
  compose,
  newTraceCtx,
  nowISO,
  type BufferedSink,
  type Sink,
  type SpanEvent,
  type TraceMiddleware,
  type TracerEvent,
} from './core';

/**
 * Narrows a `TracerEvent` union by its discriminant `type` property.
 * This is useful for creating type-safe event handlers that only deal with a specific kind of event.
 * @template T The type of the tracer event.
 */
type EventByType<T extends TracerEvent['type']> = Extract<TracerEvent, { type: T }>;

/**
 * Defines the input shape accepted by the `emit` method.
 * The base fields (`ts`, `sessionId`, `level`, `ctx`) are injected by `emit`, so they are omitted from this type.
 * The `ctx` field is optional, and if not provided, a new trace context will be created.
 * @template T The type of the tracer event.
 */
type EmitInput<T extends TracerEvent> = Omit<T, 'ts' | 'sessionId' | 'level' | 'ctx'> & {
  ctx?: T['ctx'];
};

/**
 * The log level for events emitted by the tracer.
 * - `debug`: Verbose logs for debugging purposes.
 * - `info`: Informational messages about the system's state.
 * - `warn`: Warnings about potential issues.
 * - `error`: Errors that have occurred.
 */
export type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * A lightweight token representing an in-flight span.
 * This token is returned from {@link Tracer.spanStart} and should be passed to {@link Tracer.spanEnd} to complete the span.
 * It contains the trace context and other metadata associated with the span.
 */
export interface SpanToken {
  /**
   * The trace context associated with this span.
   * This should be reused on related events to link them to the same trace.
   */
  ctx: { traceId: string; spanId: string; parentSpanId?: string };
  /** The name of the operation being traced (e.g., `db.query`, `http.request`). */
  operation: string;
  /** The name of the service where the operation is taking place (e.g., `user-service`, `payment-service`). */
  service?: string;
  /** The name of the environment where the service is running (e.g., `dev`, `prod`). */
  env?: string;
  /** The name of the region where the service is located (e.g., `us-east-1`, `eu-west-1`). */
  region?: string;
  /** The start time of the span in milliseconds since the epoch. */
  t0: number;
  /** A record of attributes captured at the start of the span. */
  attrs?: Record<string, unknown>;
}

/**
 * The options for starting a new span.
 */
export type SpanStartOptions = {
  /** The name of the operation being traced (e.g., `db.query`, `http.request`). */
  operation: string;
  /** The name of the service where the operation is taking place (e.g., `user-service`, `payment-service`). */
  service?: string;
  /** The name of the environment where the service is running (e.g., `dev`, `prod`). */
  env?: string;
  /** The name of the region where the service is located (e.g., `us-east-1`, `eu-west-1`). */
  region?: string;
  /** A record of attributes to associate with the span. */
  attrs?: Record<string, unknown>;
  /**
   * The parent span to which this span is a child.
   * This can be a `SpanToken`, an object with `traceId` and `spanId`, or an object with a `ctx` property containing the trace context.
   */
  parent?:
    | SpanToken
    | { traceId: string; spanId: string }
    | { ctx: { traceId: string; spanId: string } };
};

/**
 * The options for constructing a new {@link Tracer} instance.
 */
export interface TracerOptions {
  /**
   * An optional fixed session ID. If not provided, a new session ID will be generated automatically.
   * A session ID is a unique identifier for a sequence of related traces.
   */
  sessionId?: string;
  /**
   * The destination that persists events, such as a file, browser console, or HTTP endpoint.
   * The sink is responsible for writing events to the desired output.
   */
  sink: Sink | BufferedSink;
  /**
   * An array of middlewares to transform, sample, or drop events before they are sent to the sink.
   * Middlewares are executed in the order they are provided.
   */
  middlewares?: TraceMiddleware[];
  /**
   * The default log level to apply to emitted events.
   * This can be overridden on a per-event basis.
   */
  defaultLevel?: Level;
  /**
   * Optional environment tags that are propagated on each event.
   * These tags provide context about the service, environment, and region where the event originated.
   */
  service?: string;
  env?: string;
  region?: string;
}

/**
 * A lightweight, vendor-agnostic tracer that emits normalized AccordKit events to a pluggable {@link Sink}.
 * Middlewares can be used to transform or drop events before they are sent to the sink.
 *
 * If the provided sink implements the {@link BufferedSink} interface, the `flush()` and `close()` methods will be proxied
 * to allow for graceful delivery of events on shutdown.
 */
export class Tracer {
  /** The logical session ID used to partition trace logs. */
  public readonly sessionId: string;

  private sink: Sink | BufferedSink;
  private runMw: (e: TracerEvent) => Promise<TracerEvent | null>;
  private level: Level;
  private tags: { service?: string; env?: string; region?: string };

  /**
   * Creates a new tracer with the specified options.
   * @param opts The options for configuring the tracer.
   */
  constructor(opts: TracerOptions) {
    this.sessionId = opts.sessionId || `sess_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.sink = opts.sink;
    this.runMw = compose(opts.middlewares || []);
    this.level = opts.defaultLevel ?? 'info';
    this.tags = { service: opts.service, env: opts.env, region: opts.region };
  }

  /**
   * Composes a base event with default values, runs it through the middleware chain, and sends it to the sink.
   * @param e The event to emit.
   * @returns A promise that resolves when the event has been sent to the sink.
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
   * Emits a `message` event, which can be from the system, user, assistant, or a tool.
   * @param e The message event to emit.
   * @returns A promise that resolves when the event has been sent to the sink.
   */
  message(
    e: Omit<EventByType<'message'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'message'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'message'>>({ ...e, type: 'message' });
  }

  /**
   * Emits a `tool_call` event, which represents a call to a tool.
   * @param e The tool call event to emit.
   * @returns A promise that resolves when the event has been sent to the sink.
   */
  toolCall(
    e: Omit<EventByType<'tool_call'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'tool_call'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'tool_call'>>({ ...e, type: 'tool_call' });
  }

  /**
   * Emits a `tool_result` event, which represents the result of a tool call.
   * @param e The tool result event to emit.
   * @returns A promise that resolves when the event has been sent to the sink.
   */
  toolResult(
    e: Omit<EventByType<'tool_result'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'tool_result'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'tool_result'>>({ ...e, type: 'tool_result' });
  }

  /**
   * Emits a `usage` event, which contains information about token usage and cost.
   * @param e The usage event to emit.
   * @returns A promise that resolves when the event has been sent to the sink.
   */
  usage(
    e: Omit<EventByType<'usage'>, 'ts' | 'sessionId' | 'level' | 'type' | 'ctx'> & {
      ctx?: EventByType<'usage'>['ctx'];
    },
  ) {
    return this.emit<EventByType<'usage'>>({ ...e, type: 'usage' });
  }

  /**
   * Starts a new span and returns a `SpanToken` that should be passed to {@link spanEnd} to complete the span.
   * Any emitted event can reuse `token.ctx` to relate messages to this span.
   * @param opts The options for starting the span.
   * @returns A `SpanToken` representing the in-flight span.
   */
  spanStart(opts: SpanStartOptions): SpanToken {
    let parentCtx: { traceId: string; spanId: string } | undefined;
    if (opts.parent) {
      if ('ctx' in opts.parent) {
        // SpanToken or { ctx: { traceId, spanId } }
        parentCtx = opts.parent.ctx;
      } else if ('traceId' in opts.parent && 'spanId' in opts.parent) {
        parentCtx = opts.parent;
      }
    }

    const ctx = newTraceCtx(parentCtx?.spanId);
    if (parentCtx?.traceId) {
      // preserve parent traceId if provided
      ctx.traceId = parentCtx.traceId;
    }

    const token: SpanToken = {
      ctx,
      operation: opts.operation,
      service: opts.service,
      env: opts.env,
      attrs: opts.attrs,
      t0: Date.now(),
    };
    return token;
  }

  /**
   * Finishes a span and emits a `span` event with the computed duration.
   * The status of the span defaults to `'ok'`, but can be set to `'error'` if the operation failed.
   * @param token The `SpanToken` returned from `spanStart`.
   * @param end An optional object containing the status and attributes to add to the span.
   * @returns A promise that resolves when the span event has been sent to the sink.
   */
  spanEnd(token: SpanToken, end?: { status?: 'ok' | 'error'; attrs?: Record<string, unknown> }) {
    const durationMs = Math.max(0, Date.now() - token.t0);
    const ev: SpanEvent = {
      ts: nowISO(),
      sessionId: this.sessionId,
      level: this.level,
      type: 'span',
      operation: token.operation,
      durationMs,
      status: end?.status ?? 'ok',
      attrs: { ...(token.attrs || {}), ...(end?.attrs || {}) },
      ctx: token.ctx,
      // Prefer span-specific values, fall back to tracer-level tags
      service: token.service ?? this.tags.service,
      env: token.env ?? this.tags.env,
      region: token.region ?? this.tags.region,
    };
    return this.runMw(ev).then((x) => {
      if (x) this.sink.write(this.sessionId, x);
    });
  }

  /**
   * If the underlying sink is buffered, this method flushes any queued events to durable storage.
   * This is a no-op for sinks that write immediately.
   * @returns A promise that resolves when the flush is complete.
   */
  async flush(): Promise<void> {
    const s = this.sink as Partial<BufferedSink>;
    if (typeof s.flush === 'function') {
      await s.flush();
    }
  }

  /**
   * If the underlying sink is buffered, this method closes any open timers and flushes any remaining events.
   * This is a no-op for sinks that write immediately.
   * @returns A promise that resolves when the close operation is complete.
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
