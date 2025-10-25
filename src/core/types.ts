/**
 * Standard severity levels for trace events, ordered from least to most severe.
 * - `debug`: Detailed information for debugging purposes.
 * - `info`: General informational messages about application state.
 * - `warn`: Indicates a potential problem that does not prevent the operation from completing.
 * - `error`: Indicates a failure or error that prevented an operation from completing.
 */
export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A list of known AI provider identifiers.
 * This helps normalize events coming from different LLM SDKs.
 * - `openai`
 * - `anthropic`
 * - `vertex` (Google Vertex AI)
 * - `mistral`
 * - `ollama`
 * - `azureopenai`
 * - `other` (For any other provider)
 */
export type Provider =
  | 'openai'
  | 'anthropic'
  | 'vertex'
  | 'mistral'
  | 'ollama'
  | 'azureopenai'
  | 'other';

/**
 * W3C TraceContext-like structure for correlating events.
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceContext {
  /** Unique ID for an entire trace tree. */
  traceId: string;
  /** Unique ID for a single span or event within a trace. */
  spanId: string;
  /** The `spanId` of the parent span, if any. */
  parentSpanId?: string;
}

/** Base shape shared by all AccordKit events. */
export interface BaseEvent {
  /** ISO8601 timestamp of when the event occurred. */
  ts: string;
  /** Logical identifier for a user session or conversation. */
  sessionId: string;
  /** Severity level of the event. */
  level: TraceLevel;
  /** Trace context for correlating events. */
  ctx: TraceContext;
  /** The AI provider SDK that emitted the event. */
  provider?: Provider;
  /** The specific model ID used, if known (e.g., 'gpt-4-turbo'). */
  model?: string;
  /** The unique request ID returned by the provider's API. */
  requestId?: string;
  /** The name of the service emitting the event. */
  service?: string;
  /** The deployment environment (e.g., 'production', 'staging'). */
  env?: string;
  /** The cloud or geographical region. */
  region?: string;
  /** The discriminated union type name for the event. */
  type: string;
  /** A bucket for vendor-specific or non-standard extensions. */
  $ext?: Record<string, unknown>;
}

/** Chat/content message event emitted by adapters or apps. */
export interface MessageEvent extends BaseEvent {
  type: 'message';
  /** The role of the message author. */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** The message content. Adapters may stringify structured content. */
  content: string;
  /** The format of the content, if not plain text. */
  format?: 'text' | 'json' | 'tool_result';
}

/** Tool invocation request emitted by apps or providers. */
export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  /** The name or identifier of the tool being called. */
  tool: string;
  /** The input or arguments for the tool call. */
  input: unknown;
}

/** Result of a tool invocation (success or failure). */
export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  /** The name or identifier of the tool that was called. */
  tool: string;
  /** The response payload from the tool. Should be redacted if it contains sensitive data. */
  output: unknown;
  /** A boolean indicating if the tool call was successful. */
  ok?: boolean;
  /** The duration of the tool call in milliseconds. */
  latencyMs?: number;
}

/** Model token usage accounting (provider-reported or estimated). */
export interface ModelUsageEvent extends BaseEvent {
  type: 'usage';
  /** Number of tokens in the input/prompt. */
  inputTokens?: number;
  /** Number of tokens in the output/completion. */
  outputTokens?: number;
  /** Estimated or reported cost for the tokens used. */
  cost?: number;
}

/**
 * An event representing a timed operation, similar to a span in OpenTelemetry.
 * Useful for instrumenting non-LLM operations like database queries, API calls, or function executions.
 * @see https://opentelemetry.io/docs/concepts/signals/traces/#spans
 */
export interface SpanEvent extends BaseEvent {
  type: 'span';
  /** A descriptive name for the operation (e.g., 'db:query', 'api:call'). */
  operation: string;
  /** The total duration of the operation in milliseconds. */
  durationMs: number;
  /** The status of the operation. */
  status?: 'ok' | 'error';
  /** A dictionary of arbitrary attributes related to the span. */
  attrs?: Record<string, unknown>;
}

/** Discriminated union of all supported event shapes. */
export type TracerEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | ModelUsageEvent
  | SpanEvent;

/**
 * (Reserved) The kind of evidence supporting a hypothesis.
 * This is part of a schema for advanced root cause analysis features.
 */
type EvidenceKind = 'metric' | 'deploy' | 'trace' | 'log' | 'attribution';

/** (Reserved) Time-series metric data as evidence. */
type MetricEvidence = {
  kind: Extract<EvidenceKind, 'metric'>;
  name: string;
  points: Array<{ t: number; value: number }>;
};
/** (Reserved) A deployment event as evidence. */
type DeployEvidence = {
  kind: Extract<EvidenceKind, 'deploy'>;
  t: number;
  sha: string;
  tag?: string;
  author?: string;
  url?: string;
};
/** (Reserved) A specific trace or span as evidence. */
type TraceEvidence = {
  kind: Extract<EvidenceKind, 'trace'>;
  traceId: string;
  spanId?: string;
  attrs?: Record<string, unknown>;
};
/** (Reserved) A log entry as evidence. */
type LogEvidence = {
  kind: Extract<EvidenceKind, 'log'>;
  t: number;
  message: string;
  level?: 'debug' | 'info' | 'warn' | 'error';
};
/** (Reserved) An attribution score or label as evidence. */
type AttributionEvidence = {
  kind: Extract<EvidenceKind, 'attribution'>;
  label: string;
  score?: number;
  details?: Record<string, unknown>;
};

/** (Reserved) A discriminated union of all supported evidence shapes. */
export type Evidence =
  | MetricEvidence
  | DeployEvidence
  | TraceEvidence
  | LogEvidence
  | AttributionEvidence;

/**
 * (Reserved) A hypothesis about system behavior for root cause analysis.
 * This structure is used for advanced correlation and diagnostics.
 */
export type Hypothesis = {
  /** A unique identifier for the hypothesis. */
  id: string;
  /** A human-readable title for the hypothesis. */
  title: string;
  /** The service related to this hypothesis. */
  service: string;
  /** A score from 0 to 1 indicating confidence in the hypothesis. */
  confidence: number;
  /** The category of the hypothesis. */
  category: 'deploy' | 'dependency' | 'attribution' | 'other';
  /** A collection of evidence supporting the hypothesis. */
  evidence: Evidence[];
};
