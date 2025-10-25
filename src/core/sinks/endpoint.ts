export type Region = 'eu' | 'us' | 'auto';

export function resolveIngestEndpoint(opts?: { baseUrl?: string; region?: Region }) {
  const base = opts?.baseUrl ?? 'https://api.accordkit.dev';
  const region = opts?.region ?? 'auto';
  const path = region === 'eu' ? '/eu' : region === 'us' ? '/us' : '/auto';
  return `${base}${path}/ingest`;
}
