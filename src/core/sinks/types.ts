import type { TracerEvent } from '../types';

/**
 * A destination for AccordKit trace events.
 *
 * Sinks are responsible for persisting trace events to various destinations like files,
 * databases, or remote services. They serve as pluggable backends for the tracing system.
 *
 * @remarks
 * Implementation guidelines:
 * - Make implementations resilient and non-throwing by default
 * - Favor local-first behavior for offline/development workflows
 * - Handle errors gracefully without disrupting the application
 * - Consider implementing BufferedSink for better performance
 *
 * @example
 * ```typescript
 * // A simple sink that logs events to the console.
 * class ConsoleSink implements Sink {
 *   write(sessionId: string, e: TracerEvent): void {
 *     const { type, level } = e;
 *     console.log(`[${sessionId}] ${level} - ${type}`);
 *   }
 * }
 *
 * const sink = new ConsoleSink();
 * // sink.write('session-123', { ... });
 * ```
 * ```
 */
export interface Sink {
  /**
   * Persist a single event for a session.
   *
   * @remarks
   * Implementations should:
   * - Handle errors gracefully without throwing
   * - Consider batching for performance if needed
   * - Maintain order of events within a session
   * - Be thread-safe if used in concurrent environments
   *
   * @param sessionId - Unique identifier for grouping related events.
   *                   Used for partitioning and log file naming.
   * @param e - The trace event to persist. See {@link TracerEvent} for structure.
   * @returns Void or Promise<void> for async implementations.
   */
  write(sessionId: string, e: TracerEvent): void | Promise<void>;
}

/**
 * What to do when a buffered sink reaches capacity.
 *
 * - 'auto-flush' (default): accept the write, then immediately trigger a guarded flush.
 *   Node sinks may temporarily apply backpressure (write() awaits the in-flight flush) *only when over capacity*.
 *   Browser sinks remain non-blocking and best-effort.
 * - 'drop-oldest': ring-buffer semantics under sustained overload; never blocks producers.
 * - 'error': throw on overflow (useful for tests).
 */
export type OverflowPolicy = 'auto-flush' | 'drop-oldest' | 'error';

export interface BufferedOptions {
  /**
   * The maximum total number of events to keep in memory across all session buffers.
   * If the total exceeds this size, the oldest events from the largest buffer will be dropped.
   * This prevents unbounded memory growth.
   * Only applies to `buffered` delivery mode.
   * @default 5000
   */
  maxBuffer?: number;
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
   * The policy to apply when the `maxBuffer` limit is reached.
   * This determines how the sink behaves when it's under heavy load.
   *
   * - `auto-flush`: Immediately triggers a flush.
   * - `drop-oldest`: Discards the oldest events to make room for new ones.
   * - `error`: Throw on overflow (useful for tests).
   *
   * @see OverflowPolicy
   * @default 'auto-flush'
   */
  overflowPolicy?: OverflowPolicy;
}

/**
 * Extended sink interface that supports buffering and explicit cleanup.
 *
 * Buffered sinks can improve performance by batching events before writing
 * to the underlying storage. They also provide explicit control over
 * flushing and cleanup.
 *
 * @remarks
 * - Consider implementing this interface for network or disk-based sinks
 * - Ensure proper cleanup in application shutdown scenarios
 * - Document any size/time limits on buffering
 *
 * @example
 * ```typescript
 * // Usage in a Node.js application with a sink like FileSink
 * import { FileSink } from './fileSink'; // Assuming FileSink implements BufferedSink
 *
 * const sink = new FileSink({ delivery: 'buffered' });
 *
 * // In your application logic...
 * // sink.write('session-abc', event1);
 * // sink.write('session-abc', event2);
 *
 * // On application shutdown, ensure all buffered events are written.
 * async function onShutdown() {
 *   if (sink.close) {
 *     await sink.close();
 *   }
 *   process.exit(0);
 * }
 *
 * process.on('SIGINT', onShutdown);
 * process.on('SIGTERM', onShutdown);
 * ```
 */
export interface BufferedSink extends Sink {
  /**
   * Flush any buffered events to the underlying storage.
   *
   * @returns Promise that resolves when all buffered events are persisted
   */
  flush(): Promise<void>;

  /**
   * Optional cleanup method for releasing resources.
   *
   * @remarks
   * Implementations should:
   * - Flush any remaining buffered events
   * - Close network connections or file handles
   * - Release any other held resources
   *
   * @returns Promise that resolves when cleanup is complete
   */
  close?(): Promise<void>;
}

/**
 * Configuration for retry behavior in networked sinks.
 *
 * @remarks
 * Uses exponential backoff with optional jitter for network resilience.
 * Retry delay is calculated as: min(maxMs, baseMs * 2^attempt) + jitter
 *
 * @example
 * ```typescript
 * const policy: RetryPolicy = {
 *   retries: 3,        // Try up to 3 times
 *   baseMs: 100,       // Start with 100ms delay
 *   maxMs: 5000,       // Cap at 5 seconds
 *   jitter: true       // Add randomness to prevent thundering herd
 * };
 * ```
 */
export type RetryPolicy = {
  /** Maximum number of retry attempts */
  retries: number;

  /** Base delay in milliseconds between retries */
  baseMs: number;

  /** Maximum delay in milliseconds between retries */
  maxMs: number;

  /** Whether to add random jitter to retry delays */
  jitter?: boolean;
};
