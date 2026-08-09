import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptimizerProbeResponse } from '../../src/ops/optimizer-api.js';

test('probe returns deterministic 64 KiB body with no-store', async () => {
    const first = buildOptimizerProbeResponse();
    const second = buildOptimizerProbeResponse();
    const firstBody = new Uint8Array(await first.arrayBuffer());
    const secondBody = new Uint8Array(await second.arrayBuffer());

    assert.equal(first.status, 200);
    assert.equal(firstBody.byteLength, 64 * 1024);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(first.headers.get('content-type'), 'application/octet-stream');
    assert.equal(first.headers.get('content-length'), String(64 * 1024));
    assert.equal(first.headers.get('x-optimizer-probe-version'), '1');
    assert.deepEqual(firstBody, secondBody);
});
