const DEFAULT_CF_IPV4_CIDRS = [
  '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '104.16.0.0/13',
  '104.24.0.0/14', '108.162.192.0/18', '131.0.72.0/22', '141.101.64.0/18',
  '162.158.0.0/15', '172.64.0.0/13', '173.245.48.0/20', '188.114.96.0/20',
  '190.93.240.0/20', '197.234.240.0/22', '198.41.128.0/17',
].join(',');

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

function splitList(value) {
  return String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function readConfig(env = process.env) {
  const workerBaseUrl = String(env.WORKER_BASE_URL || '').trim().replace(/\/+$/, '');
  const edgeHostname = String(env.EDGE_HOSTNAME || '').trim().toLowerCase();
  const token = String(env.OPTIMIZER_TOKEN || '');
  const dataDir = String(env.DATA_DIR || '/data').trim();
  if (!workerBaseUrl.startsWith('https://')) throw new Error('WORKER_BASE_URL must use HTTPS');
  if (!edgeHostname || edgeHostname.includes('/') || edgeHostname.includes(':')) throw new Error('EDGE_HOSTNAME must be a hostname');
  if (token.length < 24) throw new Error('OPTIMIZER_TOKEN must be at least 24 characters');
  if (!dataDir) throw new Error('DATA_DIR is required');
  return {
    workerBaseUrl,
    edgeHostname,
    token,
    dataDir,
    cfIpv4Cidrs: String(env.CF_IPV4_CIDRS || DEFAULT_CF_IPV4_CIDRS),
    seeds: splitList(env.SEED_ADDRESSES),
    publishEnabled: env.PUBLISH_ENABLED === 'true',
    probeTimeoutMs: positiveInt(env.PROBE_TIMEOUT_MS, 5000, 250, 60000),
    timeoutMs: positiveInt(env.API_TIMEOUT_MS, 8000, 250, 60000),
    concurrency: positiveInt(env.CONCURRENCY, 12, 1, 64),
    fastCandidateCount: positiveInt(env.FAST_CANDIDATE_COUNT, 64, 4, 512),
    fullCandidateCount: positiveInt(env.FULL_CANDIDATE_COUNT, 192, 4, 1024),
  };
}

export const configConstants = { DEFAULT_CF_IPV4_CIDRS };
