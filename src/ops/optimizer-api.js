import {
    PoolStoreError,
    parseAllowedCidrs,
    publishPool,
    readPoolStatus,
    rollbackPool,
} from './pool-store.js';

const MAX_JSON_BODY_BYTES = 16 * 1024;
const PROBE_PAYLOAD_BYTES = 64 * 1024;
const PROBE_PATTERN = new TextEncoder().encode('re-edgetunnel-optimizer-probe-v1\n');
const PROBE_PAYLOAD = (() => {
    const payload = new Uint8Array(PROBE_PAYLOAD_BYTES);
    for (let offset = 0; offset < payload.length; offset += PROBE_PATTERN.length) {
        payload.set(PROBE_PATTERN.subarray(0, Math.min(PROBE_PATTERN.length, payload.length - offset)), offset);
    }
    return payload;
})();

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

export function buildOptimizerProbeResponse() {
    return new Response(PROBE_PAYLOAD.slice(), {
        status: 200,
        headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(PROBE_PAYLOAD_BYTES),
            'Cache-Control': 'no-store',
            'X-Optimizer-Probe-Version': '1',
        },
    });
}

async function readBoundedJson(request) {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
        throw new PoolStoreError('Request body is too large', 413);
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BODY_BYTES) {
        throw new PoolStoreError('Request body is too large', 413);
    }
    try {
        return JSON.parse(text || '{}');
    } catch {
        throw new PoolStoreError('Invalid JSON body', 400);
    }
}

function allowedCidrsFromEnv(env) {
    try {
        return parseAllowedCidrs(env.OPTIMIZER_ALLOWED_CIDRS || '');
    } catch (error) {
        throw new PoolStoreError(`Optimizer CIDR configuration is invalid: ${error.message}`, 503);
    }
}

export async function handleOptimizerRequest(request, env, pathLower) {
    try {
        if (pathLower === 'ops/optimizer/v1/probe') {
            if (request.method !== 'GET') return jsonResponse({ error: 'Method Not Allowed' }, 405);
            return buildOptimizerProbeResponse();
        }

        if (pathLower === 'ops/optimizer/v1/status') {
            if (request.method !== 'GET') return jsonResponse({ error: 'Method Not Allowed' }, 405);
            return jsonResponse(await readPoolStatus(env));
        }

        if (pathLower === 'ops/optimizer/v1/pool') {
            if (request.method !== 'PUT') return jsonResponse({ error: 'Method Not Allowed' }, 405);
            const body = await readBoundedJson(request);
            const result = await publishPool(env, body, allowedCidrsFromEnv(env));
            return jsonResponse(result);
        }

        if (pathLower === 'ops/optimizer/v1/rollback') {
            if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);
            const body = await readBoundedJson(request);
            const result = await rollbackPool(env, body.expected_current_revision);
            return jsonResponse(result);
        }

        return jsonResponse({ error: 'Not Found' }, 404);
    } catch (error) {
        const status = error instanceof PoolStoreError ? error.status : 500;
        return jsonResponse({ error: status >= 500 ? 'Internal Server Error' : error.message }, status);
    }
}
