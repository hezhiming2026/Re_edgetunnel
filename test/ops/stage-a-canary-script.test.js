import test from 'node:test';
import assert from 'node:assert/strict';
import { runStageACanary } from '../../scripts/stage-a-canary.mjs';

function response(body = '', init = {}) {
    return new Response(body, init);
}

test('Stage A canary validates auth isolation, bounded probe, and redacted diagnostics', async () => {
    const calls = [];
    const logs = [];
    const secretHost = 'secret.example.test';
    const optimizerToken = 'optimizer-token-value-should-never-log';
    const adminPassword = 'admin-password-should-never-log';

    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        const u = new URL(url);
        const auth = new Headers(init.headers || {}).get('authorization');

        if (u.pathname === '/ops/optimizer/v1/status' && !auth) return response('{"error":"Unauthorized"}', { status: 401 });
        if (u.pathname === '/ops/optimizer/v1/status' && auth === `Bearer ${adminPassword}`) return response('{"error":"Unauthorized"}', { status: 401 });
        if (u.pathname === '/admin' && auth === `Bearer ${optimizerToken}`) return response('', { status: 302, headers: { location: '/login' } });
        if (u.pathname === '/ops/optimizer/v1/probe') {
            return response(new Uint8Array(65536), {
                status: 200,
                headers: {
                    'cache-control': 'no-store',
                    'x-optimizer-probe-version': '1',
                },
            });
        }
        if (u.pathname === '/ops/optimizer/v1/status' && auth === `Bearer ${optimizerToken}`) {
            return response('{"current":null,"previous":null}', { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.pathname === '/ops/egress/v1/diagnose') {
            const body = JSON.parse(init.body);
            return response(JSON.stringify({
                target: body.target,
                direct: { state: body.target === 'baseline' ? 'ok' : 'error', elapsed_ms: 12 },
                nas: { state: 'not_configured' },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`unexpected request: ${u.pathname}`);
    };

    const summary = await runStageACanary({
        baseUrl: 'https://edge.example.test',
        optimizerToken,
        adminPassword,
        diagnosticTargets: `baseline=www.example.com:443,x=${secretHost}:443`,
        fetchImpl,
        log: (line) => logs.push(String(line)),
    });

    assert.equal(summary.probeBytes, 65536);
    assert.deepEqual(summary.targets.map((item) => item.target), ['baseline', 'x']);
    assert.equal(summary.targets[0].direct.state, 'ok');
    assert.equal(summary.targets[1].direct.state, 'error');

    const output = logs.join('\n');
    assert.doesNotMatch(output, /secret\.example\.test/);
    assert.doesNotMatch(output, /optimizer-token-value/);
    assert.doesNotMatch(output, /admin-password/);
    assert.match(output, /baseline/);
    assert.match(output, /"x"/);

    const diagnosticCalls = calls.filter((call) => new URL(call.url).pathname === '/ops/egress/v1/diagnose');
    assert.equal(diagnosticCalls.length, 2);
});

test('Stage A canary rejects a probe that is not exactly 65536 bytes', async () => {
    const fetchImpl = async (url, init = {}) => {
        const u = new URL(url);
        const auth = new Headers(init.headers || {}).get('authorization');
        if (u.pathname === '/ops/optimizer/v1/status' && !auth) return response('', { status: 401 });
        if (u.pathname === '/ops/optimizer/v1/status' && auth === 'Bearer admin') return response('', { status: 401 });
        if (u.pathname === '/admin') return response('', { status: 302, headers: { location: '/login' } });
        if (u.pathname === '/ops/optimizer/v1/probe') return response(new Uint8Array(1024), { status: 200, headers: { 'cache-control': 'no-store', 'x-optimizer-probe-version': '1' } });
        throw new Error(`unexpected request: ${u.pathname}`);
    };

    await assert.rejects(() => runStageACanary({
        baseUrl: 'https://edge.example.test',
        optimizerToken: 'optimizer',
        adminPassword: 'admin',
        diagnosticTargets: 'baseline=www.example.com:443',
        fetchImpl,
        log: () => {},
    }), /65536/);
});
