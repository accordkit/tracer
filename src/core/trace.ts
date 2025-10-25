import type { TraceContext } from "./types";

/**
 * Returns the current time as an ISO 8601 formatted string.
 * This is a high-resolution timestamp, typically used for event timing.
 *
 * @returns The current timestamp in UTC, formatted as a string (e.g., "2023-10-27T10:00:00.000Z").
 */
export function nowISO() {
  return new Date().toISOString();
}

/**
 * Creates a reasonably unique identifier, suitable for trace and span IDs.
 * The ID is composed of a prefix, a random string, and a timestamp, making it
 * highly unlikely to collide within a single process.
 *
 * Note: This is not a cryptographically secure or globally unique identifier (like a UUID).
 * It is designed to be simple, fast, and sufficient for tracing purposes.
 *
 * @param prefix - A short string to prepend to the ID, indicating its type (e.g., 'tr' for trace). Defaults to 'id'.
 * @returns A unique identifier string.
 * @example
 * // Returns something like "tr_1a2b3c_1678886400000"
 * const traceId = randomId('tr');
 */
export function randomId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/**
 * Creates a new trace context object, which contains the identifiers for a trace and a new span.
 * This is the starting point for a new trace or a child span within an existing trace.
 *
 * @param parentSpanId - Optional. The ID of the parent span. If provided, the new span will be a child of the parent,
 *   but it will still belong to a new trace. To create a child span within the *same* trace, you should
 *   manually pass the `traceId` from the parent.
 * @returns {TraceContext} An object containing the new trace context.
 *
 * @example
 * // Create a new root trace context
 * const rootCtx = newTraceCtx();
 * // { traceId: 'tr_...', spanId: 'sp_...', parentSpanId: undefined }
 */
export function newTraceCtx(parentSpanId?: string): TraceContext {
  const traceId = randomId('tr');
  const spanId = randomId('sp');
  return { traceId, spanId, parentSpanId };
}
