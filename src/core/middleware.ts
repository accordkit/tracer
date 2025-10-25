/** Function signature for middleware that can transform or drop events. */
import type { SpanEvent, TracerEvent } from './types';

export type AnyEvent = TracerEvent | SpanEvent;

/**
 * A function that processes a trace event.
 *
 * Middleware can be used to enrich, transform, filter, or drop events before they
 * are sent to a sink. It can operate synchronously or asynchronously.
 *
 * @param e The incoming event.
 * @returns The processed event, a new event, or `null` to drop the event.
 */
export type TraceMiddleware<E extends AnyEvent = AnyEvent> = (e: E) => E | null | Promise<E | null>;

/**
 * Composes multiple middleware functions into a single pipeline that executes in series.
 * If any middleware in the chain returns `null`, the pipeline is short-circuited
 * and the event is dropped.
 *
 * @param mw An array of middleware functions to compose.
 * @returns A single async middleware function that runs the pipeline.
 * @example
 * const pipeline = compose([
 *   maskPII(),
 *   sample(0.5)
 * ]);
 * const processedEvent = await pipeline(someEvent);
 */
export function compose<E extends AnyEvent = AnyEvent>(mw: TraceMiddleware<E>[]) {
  return async (e: E): Promise<E | null> => {
    let event: E | null = e;
    for (const m of mw) {
      if (event === null) return null;
      event = await m(event);
    }
    return event;
  };
}

/**
 * Creates a middleware that probabilistically samples events.
 *
 * @param rate A number between 0 and 1 representing the probability of keeping an event.
 *   A rate of 1 keeps all events, while a rate of 0 drops all events.
 * @returns A middleware function that returns the event if it's sampled, otherwise `null`.
 * @example
 * // Keep approximately 10% of events
 * const sampler = sample(0.1);
 */
export const sample =
  (rate: number): TraceMiddleware =>
  (e) =>
    Math.random() < rate ? e : null;

/**
 * Creates a middleware that performs a simple redaction of email-like patterns.
 *
 * This function targets `message` events and replaces the `@` symbol in the `content`
 * field with `[at]`. It mutates the event in place for performance.
 *
 * Note: This is a naive implementation for demonstration and may not catch all PII.
 * For robust PII handling, a more sophisticated solution is recommended.
 *
 * @returns A middleware function that redacts content.
 * @example
 * const piiMasker = maskPII();
 * const event = { type: 'message', role: 'user', content: 'My email is test@example.com' };
 * const redactedEvent = piiMasker(event);
 * // redactedEvent.content is now 'My email is test[at]example.com'
 */
export const maskPII = (): TraceMiddleware => (ev) => {
  // Only MessageEvent has `content`; safely narrow at runtime
  const maybe = ev as { type: string; content?: unknown };
  if (maybe.type === 'message' && typeof maybe.content === 'string') {
    // Mutate the original union safely for performance.
    (maybe as { content: string }).content = maybe.content.replace(/@/g, '[at]');
  }
  return ev;
};
