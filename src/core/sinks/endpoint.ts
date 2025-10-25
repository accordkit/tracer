/**
 * Specifies the geographical region for data ingestion.
 * Using a specific region can improve latency.
 * - `eu`: Europe
 * - `us`: United States
 * - `auto`: The service will automatically select the nearest region based on the request's origin.
 */
export type Region = 'eu' | 'us' | 'auto';

/**
 * Constructs the full ingestion endpoint URL based on the provided options.
 * This helper function is useful for configuring sinks that send data to the AccordKit service,
 * ensuring the correct URL is generated for different regions or custom deployments.
 *
 * @param opts - Optional configuration for building the endpoint URL.
 * @param opts.baseUrl - The base URL of the AccordKit API. Defaults to `https://api.accordkit.dev`.
 * @param opts.region - The target geographical region for ingestion. Defaults to `'auto'`.
 * @returns The complete ingest endpoint URL as a string.
 *
 * @example
 * // Returns 'https://api.accordkit.dev/auto/ingest'
 * resolveIngestEndpoint();
 *
 * @example
 * // Returns 'https://api.accordkit.dev/eu/ingest'
 * resolveIngestEndpoint({ region: 'eu' });
 */
export function resolveIngestEndpoint(opts?: { baseUrl?: string; region?: Region }) {
  const base = opts?.baseUrl ?? 'https://api.accordkit.dev';
  const region = opts?.region ?? 'auto';
  const path = region === 'eu' ? '/eu' : region === 'us' ? '/us' : '/auto';
  return `${base}${path}/ingest`;
}
