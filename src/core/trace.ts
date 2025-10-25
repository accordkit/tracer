/** ISO 8601 timestamp for "now". */
export function nowISO() {
  return new Date().toISOString();
}

/** Create a simple unique id for traces/spans; stable enough for tests. */
export function randomId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}

/** Create a fresh trace context; pass `parentSpanId` to link spans. */
export function newTraceCtx(parentSpanId?: string) {
  const traceId = randomId('tr');
  const spanId = randomId('sp');
  return { traceId, spanId, parentSpanId };
}
