const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ERROR_BODY = 1024;
const PROBE_BYTES = 64 * 1024;

export class RevisionConflictError extends Error {
  constructor(message = 'optimizer revision conflict') {
    super(message);
    this.name = 'RevisionConflictError';
    this.code = 'REVISION_CONFLICT';
  }
}

function baseUrl(config) {
  const raw = String(config?.workerBaseUrl || '').replace(/\/+$/, '');
  if (!raw) throw new Error('workerBaseUrl is required');
  return raw;
}

function headers(config, extra = {}) {
  const token = String(config?.token || '');
  if (!token) throw new Error('optimizer machine token is required');
  return {
    Authorization: `Bearer ${token}`,
    'Cache-Control': 'no-store',
    ...extra,
  };
}

function timeoutSignal(config) {
  return AbortSignal.timeout(Math.max(100, Number(config?.timeoutMs) || DEFAULT_TIMEOUT_MS));
}

function redact(text, config) {
  let value = String(text || '');
  const token = String(config?.token || '');
  if (token) value = value.split(token).join('[redacted]');
  return value;
}

async function readBoundedBody(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      const remaining = limit - total;
      if (remaining <= 0) break;
      const take = Math.min(remaining, chunk.byteLength);
      if (take > 0) {
        chunks.push(chunk.subarray(0, take));
        total += take;
      }
      if (chunk.byteLength > take || total >= limit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function boundedError(response, config) {
  let text = '';
  try {
    const bytes = await readBoundedBody(response, MAX_ERROR_BODY);
    text = new TextDecoder().decode(bytes);
  } catch {
    text = '';
  }
  return redact(text, config).replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_BODY);
}

async function jsonRequest(config, path, init = {}) {
  const response = await fetch(`${baseUrl(config)}${path}`, {
    redirect: 'manual',
    ...init,
    headers: headers(config, init.headers || {}),
    signal: init.signal || timeoutSignal(config),
  });
  if (response.status === 409) throw new RevisionConflictError();
  if (!response.ok) {
    const detail = await boundedError(response, config);
    throw new Error(`optimizer API HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const type = response.headers.get('content-type') || '';
  if (!type.toLowerCase().includes('application/json')) throw new Error('optimizer API returned non-JSON response');
  return response.json();
}

export function getStatus(config) {
  return jsonRequest(config, '/ops/optimizer/v1/status', { method: 'GET' });
}

export function publishPool(config, { expectedRevision = null, entries = [] }) {
  return jsonRequest(config, '/ops/optimizer/v1/pool', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expected_current_revision: expectedRevision,
      entries,
    }),
  });
}

export function rollback(config, { expectedRevision }) {
  return jsonRequest(config, '/ops/optimizer/v1/rollback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_current_revision: expectedRevision }),
  });
}

export function clearPool(config, { expectedRevision }) {
  return jsonRequest(config, '/ops/optimizer/v1/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expected_current_revision: expectedRevision }),
  });
}

export async function verifyProbe(config) {
  const response = await fetch(`${baseUrl(config)}/ops/optimizer/v1/probe`, {
    method: 'GET',
    redirect: 'manual',
    headers: headers(config),
    signal: timeoutSignal(config),
  });
  if (!response.ok) {
    const detail = await boundedError(response, config);
    throw new Error(`optimizer probe HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== PROBE_BYTES) throw new Error(`optimizer probe expected ${PROBE_BYTES} bytes, got ${bytes.byteLength}`);
  if (!response.headers.get('cache-control')?.toLowerCase().includes('no-store')) throw new Error('optimizer probe missing no-store');
  if (response.headers.get('x-optimizer-probe-version') !== '1') throw new Error('optimizer probe version mismatch');
  return { ok: true, bytes: bytes.byteLength };
}

export const apiConstants = { DEFAULT_TIMEOUT_MS, MAX_ERROR_BODY, PROBE_BYTES };
