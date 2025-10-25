/** Function signature for middleware that can transform or drop events. */
import type { TracerEvent } from "./types";

export type TraceMiddleware = (_e: TracerEvent) => TracerEvent | null | Promise<TracerEvent | null>;

/** Compose multiple middlewares into a single async pipeline. */
export function compose(mw: TraceMiddleware[]) {
  return async (e: TracerEvent) => {
    let event: TracerEvent | null = e;
    for (const m of mw) {
      if (!event) return null;
      event = await m(event);
    }
    return event;
  };
}

/** Probabilistic sampler: keeps ~`rate` fraction of events (0..1). */
export const sample =
  (rate: number): TraceMiddleware =>
  (e) =>
    Math.random() < rate ? e : null;

/** Simple PII masker that redacts email addresses in event content. */
export const maskPII = (): TraceMiddleware => (ev) => {
  // Only MessageEvent has `content`; safely narrow at runtime
  const maybe = ev as { type: string; content?: unknown };
  if (maybe.type === 'message' && typeof maybe.content === 'string') {
    const redacted = maybe.content.replace(/@/g, '[at]');
    // mutate the original union safely
    (maybe as { content: string }).content = redacted;
  }
  return ev;
};
