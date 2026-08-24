import tls from 'node:tls';
import { performance } from 'node:perf_hooks';

const EXPECTED_BYTES = 64 * 1024;

function roundMs(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function classifyError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  if (code.includes('CERT') || message.includes('certificate') || message.includes('hostname/ip')) return 'tls_certificate_error';
  if (code === 'ETIMEDOUT' || message.includes('timeout')) return 'timeout';
  if (code.startsWith('ERR_TLS') || message.includes('tls') || message.includes('ssl')) return 'tls_error';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET') return 'connection_reset';
  return 'network_error';
}

function parseHeaders(buffer) {
  const marker = buffer.indexOf('\r\n\r\n');
  if (marker < 0) return null;
  const head = buffer.subarray(0, marker).toString('latin1');
  const lines = head.split('\r\n');
  const status = Number(/^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0])?.[1]);
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return { marker: marker + 4, status, headers };
}

export function probeCandidate({ address, hostname, token, timeoutMs = 5000, payloadPath = '/ops/optimizer/v1/probe' }, deps = {}) {
  return new Promise((resolve) => {
    const started = performance.now();
    let tcpAt = null;
    let tlsAt = null;
    let firstByteAt = null;
    let status = null;
    let bodyBytes = 0;
    let headerBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let done = false;
    const port = deps.port ?? 443;

    const resultBase = () => ({
      tcpMs: tcpAt == null ? null : roundMs(tcpAt - started),
      tlsMs: tlsAt == null ? null : roundMs(tlsAt - started),
      ttfbMs: firstByteAt == null ? null : roundMs(firstByteAt - started),
      totalMs: roundMs(performance.now() - started),
      bytes: bodyBytes,
      status,
    });

    let socket;
    const finish = (ok, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve({ ok, ...resultBase(), error });
    };

    const timer = setTimeout(() => finish(false, 'timeout'), Math.max(100, Number(timeoutMs) || 5000));
    timer.unref?.();

    try {
      socket = (deps.tlsConnect || tls.connect)({
        host: address,
        port,
        servername: hostname,
        rejectUnauthorized: true,
        ...(deps.ca ? { ca: deps.ca } : {}),
      });
    } catch (error) {
      finish(false, classifyError(error));
      return;
    }

    socket.once('connect', () => {
      tcpAt = performance.now();
    });

    socket.once('secureConnect', () => {
      tlsAt = performance.now();
      const request = [
        `GET ${payloadPath} HTTP/1.1`,
        `Host: ${hostname}`,
        `Authorization: Bearer ${token}`,
        'Accept: application/octet-stream',
        'Cache-Control: no-store',
        'Connection: close',
        '',
        '',
      ].join('\r\n');
      socket.write(request);
    });

    socket.on('data', (chunk) => {
      if (done) return;
      if (firstByteAt == null) firstByteAt = performance.now();
      let bodyChunk = chunk;
      if (!headersParsed) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        if (headerBuffer.length > 16 * 1024) {
          finish(false, 'response_headers_too_large');
          return;
        }
        const parsed = parseHeaders(headerBuffer);
        if (!parsed) return;
        headersParsed = true;
        status = parsed.status;
        const contentLength = Number(parsed.headers.get('content-length'));
        const probeVersion = parsed.headers.get('x-optimizer-probe-version');
        if (status !== 200) {
          finish(false, 'unexpected_status');
          return;
        }
        if (contentLength !== EXPECTED_BYTES || probeVersion !== '1') {
          finish(false, 'unexpected_probe_contract');
          return;
        }
        bodyChunk = headerBuffer.subarray(parsed.marker);
        headerBuffer = Buffer.alloc(0);
      }
      bodyBytes += bodyChunk.length;
      if (bodyBytes > EXPECTED_BYTES) finish(false, 'probe_body_too_large');
    });

    socket.once('end', () => {
      if (!headersParsed) {
        finish(false, 'incomplete_response_headers');
        return;
      }
      if (bodyBytes !== EXPECTED_BYTES) {
        finish(false, 'incomplete_probe_body');
        return;
      }
      finish(true, null);
    });

    socket.once('error', (error) => finish(false, classifyError(error)));
  });
}

export const probeConstants = { EXPECTED_BYTES };
