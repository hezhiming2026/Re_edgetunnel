import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateMachineRequest, machineUnauthorized } from '../../src/ops/auth.js';

const requestWithAuth = (authorization) => new Request('https://example.invalid/ops/optimizer/v1/status', {
    headers: authorization ? { Authorization: authorization } : {},
});

test('machine auth requires exact bearer token', async () => {
    const env = { OPTIMIZER_TOKEN: 'optimizer-secret-1234567890' };

    assert.equal(await authenticateMachineRequest(requestWithAuth(), env), false);
    assert.equal(await authenticateMachineRequest(requestWithAuth('Bearer wrong'), env), false);
    assert.equal(await authenticateMachineRequest(requestWithAuth('Basic optimizer-secret-1234567890'), env), false);
    assert.equal(await authenticateMachineRequest(requestWithAuth('Bearer optimizer-secret-1234567890'), env), true);
});

test('machine auth fails closed when token is unset or too short', async () => {
    assert.equal(await authenticateMachineRequest(requestWithAuth('Bearer anything'), {}), false);
    assert.equal(await authenticateMachineRequest(requestWithAuth('Bearer short'), { OPTIMIZER_TOKEN: 'short' }), false);
});

test('machine unauthorized response is JSON and non-cacheable', async () => {
    const response = machineUnauthorized();

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('content-type'), 'application/json;charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Unauthorized' });
});
