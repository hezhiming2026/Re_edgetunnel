const MAX_DIAGNOSTIC_BODY_BYTES = 4096;
const SYNTHETIC_CONNECT_TIMEOUT_MS = 3000;

function defaultNow() {
    return Date.now();
}

function defaultRecord(event) {
    console.log(JSON.stringify({ type: 'egress_diagnostic', ...event }));
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}

async function readDiagnosticRequest(request) {
    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DIAGNOSTIC_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413) };
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_DIAGNOSTIC_BODY_BYTES) {
        return { error: jsonResponse({ error: 'Request body is too large' }, 413) };
    }
    let body;
    try {
        body = JSON.parse(text || '{}');
    } catch {
        return { error: jsonResponse({ error: 'Invalid JSON body' }, 400) };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { error: jsonResponse({ error: 'Invalid request body' }, 400) };
    }
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'target' || typeof body.target !== 'string') {
        return { error: jsonResponse({ error: 'Only a configured target key is accepted' }, 400) };
    }
    return { targetKey: body.target.trim().toLowerCase() };
}

export function findDiagnosticTargetKey(hostname, port, diagnosticTargets) {
    if (!(diagnosticTargets instanceof Map) || typeof hostname !== 'string') return null;
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
    for (const [key, target] of diagnosticTargets.entries()) {
        if (target?.hostname === normalized && target?.port === port) return key;
    }
    return null;
}

export function recordEgressDiagnosticEvent(event) {
    defaultRecord(event);
}

export function createEgressObserver({
    targetKey,
    now = defaultNow,
    timeoutMs = 8000,
    record = defaultRecord,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    if (typeof targetKey !== 'string' || !targetKey) return null;
    const startedAt = now();
    let timer = null;
    let terminal = false;
    let opened = false;
    let payloadStarted = false;

    const emit = (event) => {
        record({
            targetKey,
            event,
            elapsedMs: Math.max(0, Math.round(now() - startedAt)),
        });
    };

    const clear = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    return {
        openOk() {
            if (terminal || opened) return;
            opened = true;
            emit('direct_open_ok');
        },
        clientData(byteLength) {
            if (terminal || payloadStarted || !opened || !(byteLength > 0)) return;
            payloadStarted = true;
            timer = setTimer(() => {
                if (terminal) return;
                terminal = true;
                timer = null;
                emit('direct_first_byte_timeout');
            }, timeoutMs);
        },
        openError() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_open_error');
        },
        firstByte() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_first_byte_ok');
        },
        closedBeforeByte() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_closed_before_byte');
        },
        finish() {
            clear();
            terminal = true;
        },
    };
}

export async function handleEgressDiagnose(request, env, proxyConfig, deps = {}) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);
    const parsed = await readDiagnosticRequest(request);
    if (parsed.error) return parsed.error;

    const targets = proxyConfig?.diagnosticTargets;
    const target = targets instanceof Map ? targets.get(parsed.targetKey) : null;
    if (!target) return jsonResponse({ error: 'Unknown diagnostic target' }, 404);
    if (typeof deps.directDial !== 'function') return jsonResponse({ error: 'Direct diagnostic dialer is not configured' }, 503);

    const now = typeof deps.now === 'function' ? deps.now : defaultNow;
    const startedAt = now();
    let socket = null;
    let direct;
    try {
        socket = await deps.directDial(target, SYNTHETIC_CONNECT_TIMEOUT_MS);
        direct = {
            state: 'ok',
            elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
        };
    } catch {
        direct = {
            state: 'error',
            elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
        };
    } finally {
        try { await socket?.close?.(); } catch { }
    }

    return jsonResponse({
        target: parsed.targetKey,
        direct,
        nas: { state: 'not_configured' },
    });
}
