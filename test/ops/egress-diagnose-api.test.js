import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEgressDiagnose } from '../../src/ops/egress-diagnostics.js';

const request = (body) => new Request('https://example.invalid/ops/egress/v1/diagnose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

const proxyConfig = {
    diagnosticTargets: new Map([
        ['baseline', { hostname: 'example.com', port: 443 }],
    ]),
};

test('diagnose resolves only configured target keys and omits hostname', async () => {
    let clock = 100;
    const response = await handleEgressDiagnose(request({ target: 'baseline' }), {}, proxyConfig, {
        now: () => clock,
        directDial: async (target, timeoutMs) => {
            assert.deepEqual(target, { hostname: 'example.com', port: 443 });
            assert.equal(timeoutMs, 3000);
            clock = 137;
            return { close() {} };
        },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
        target: 'baseline',
        direct: { state: 'ok', elapsed_ms: 37 },
        nas: { state: 'not_configured' },
    });
    assert.equal(JSON.stringify(body).includes('example.com'), false);
});

test('arbitrary hostname or port fields are rejected', async () => {
    const response = await handleEgressDiagnose(request({ hostname: '127.0.0.1', port: 22 }), {}, proxyConfig, {
        directDial: async () => { throw new Error('must not run'); },
    });
    assert.equal(response.status, 400);
});

test('unknown target key returns 404', async () => {
    const response = await handleEgressDiagnose(request({ target: 'unknown' }), {}, proxyConfig, {
        directDial: async () => { throw new Error('must not run'); },
    });
    assert.equal(response.status, 404);
});

test('direct dial failure returns bounded error state without leaking configured hostname', async () => {
    let clock = 0;
    const response = await handleEgressDiagnose(request({ target: 'baseline' }), {}, proxyConfig, {
        now: () => clock,
        directDial: async () => {
            clock = 25;
            throw new Error('example.com refused connection');
        },
    });
    const body = await response.json();
    assert.deepEqual(body, {
        target: 'baseline',
        direct: { state: 'error', elapsed_ms: 25 },
        nas: { state: 'not_configured' },
    });
    assert.equal(JSON.stringify(body).includes('example.com'), false);
});
