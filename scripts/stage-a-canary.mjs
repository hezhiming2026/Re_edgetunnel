import { pathToFileURL } from 'node:url';
import { parseDiagnosticTargets } from '../src/ops/egress-policy.js';

const PROBE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function invariant(condition, message) {
    if (!condition) throw new Error(message);
}

function bearer(value) {
    return { Authorization: `Bearer ${value}` };
}

async function request(fetchImpl, baseUrl, path, init = {}) {
    const signal = init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetchImpl(`${baseUrl}${path}`, { redirect: 'manual', ...init, signal });
}

function assertStatus(response, expected, label) {
    invariant(response.status === expected, `${label}: expected HTTP ${expected}, got ${response.status}`);
}

function assertNoTargetHostnameLeak(payloadText, targets) {
    const lower = payloadText.toLowerCase();
    for (const target of targets.values()) {
        invariant(!lower.includes(target.hostname.toLowerCase()), 'diagnostic response leaked configured hostname');
    }
}

export async function runStageACanary({
    baseUrl,
    optimizerToken,
    adminPassword,
    diagnosticTargets,
    fetchImpl = fetch,
    log = console.log,
}) {
    invariant(typeof baseUrl === 'string' && /^https:\/\//.test(baseUrl), 'EDGE_BASE_URL must be HTTPS');
    invariant(typeof optimizerToken === 'string' && optimizerToken.length > 0, 'OPTIMIZER_TOKEN is required');
    invariant(typeof adminPassword === 'string' && adminPassword.length > 0, 'ADMIN_PASSWORD is required');

    const normalizedBase = baseUrl.replace(/\/$/, '');
    const targets = parseDiagnosticTargets(diagnosticTargets || '');
    invariant(targets.size > 0, 'DIAGNOSTIC_TARGETS must contain at least one configured key');

    const unauth = await request(fetchImpl, normalizedBase, '/ops/optimizer/v1/status');
    let edgeProtection;
    if (unauth.status === 401) edgeProtection = 'worker-401';
    else if (unauth.status === 403) edgeProtection = 'pre-worker-403';
    else throw new Error(`unauthenticated machine route: expected HTTP 401 or edge 403, got ${unauth.status}`);
    log(JSON.stringify({ canary: 'edge-preflight', anonymous_machine_route: edgeProtection }));

    // A Cloudflare edge 403 for an anonymous cloud-runner request is acceptable only
    // if the authenticated machine route still reaches the Worker successfully.
    const statusResponse = await request(fetchImpl, normalizedBase, '/ops/optimizer/v1/status', {
        headers: bearer(optimizerToken),
    });
    assertStatus(statusResponse, 200, 'authenticated optimizer status');
    const status = await statusResponse.json();

    const adminAsMachine = await request(fetchImpl, normalizedBase, '/ops/optimizer/v1/status', {
        headers: bearer(adminPassword),
    });
    assertStatus(adminAsMachine, 401, 'browser admin credential on machine route');

    const optimizerAsAdmin = await request(fetchImpl, normalizedBase, '/admin', {
        headers: bearer(optimizerToken),
    });
    assertStatus(optimizerAsAdmin, 302, 'machine credential on browser-admin route');
    invariant(optimizerAsAdmin.headers.get('location') === '/login', 'machine credential unexpectedly authorized browser-admin route');

    const probe = await request(fetchImpl, normalizedBase, '/ops/optimizer/v1/probe', {
        headers: bearer(optimizerToken),
    });
    assertStatus(probe, 200, 'bounded optimizer probe');
    const probeBody = new Uint8Array(await probe.arrayBuffer());
    invariant(probeBody.byteLength === PROBE_BYTES, `bounded optimizer probe must be exactly ${PROBE_BYTES} bytes`);
    invariant(probe.headers.get('cache-control')?.toLowerCase().includes('no-store'), 'bounded optimizer probe must be no-store');
    invariant(probe.headers.get('x-optimizer-probe-version') === '1', 'unexpected optimizer probe version');

    const targetResults = [];
    for (const key of targets.keys()) {
        const diagnose = await request(fetchImpl, normalizedBase, '/ops/egress/v1/diagnose', {
            method: 'POST',
            headers: {
                ...bearer(optimizerToken),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ target: key }),
        });
        assertStatus(diagnose, 200, `synthetic diagnostic ${key}`);
        const text = await diagnose.text();
        assertNoTargetHostnameLeak(text, targets);
        const result = JSON.parse(text);
        invariant(result?.target === key, `synthetic diagnostic ${key}: unexpected target key`);
        invariant(result?.direct?.state === 'ok' || result?.direct?.state === 'error', `synthetic diagnostic ${key}: invalid direct state`);
        invariant(Number.isFinite(result?.direct?.elapsed_ms), `synthetic diagnostic ${key}: missing bounded timing`);
        invariant(result?.nas?.state === 'not_configured', `synthetic diagnostic ${key}: NAS must remain unconfigured in Stage A`);

        const redacted = {
            target: key,
            direct: {
                state: result.direct.state,
                elapsed_ms: result.direct.elapsed_ms,
            },
            nas: { state: result.nas.state },
        };
        targetResults.push(redacted);
        log(JSON.stringify({ canary: 'egress', ...redacted }));
    }

    const summary = {
        authIsolation: 'ok',
        edgeProtection,
        probeBytes: probeBody.byteLength,
        optimizer: {
            current: status?.current ?? null,
            previous: status?.previous ?? null,
        },
        targets: targetResults,
    };
    log(JSON.stringify({ canary: 'stage-a', status: 'ok', edge_protection: edgeProtection, target_count: targetResults.length, probe_bytes: probeBody.byteLength }));
    return summary;
}

async function main() {
    await runStageACanary({
        baseUrl: process.env.EDGE_BASE_URL,
        optimizerToken: process.env.OPTIMIZER_TOKEN,
        adminPassword: process.env.ADMIN_PASSWORD,
        diagnosticTargets: process.env.DIAGNOSTIC_TARGETS,
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(`Stage A canary failed: ${error.message}`);
        process.exitCode = 1;
    });
}
