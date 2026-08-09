import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('/ops machine auth is dispatched before websocket tunnel handling', async () => {
    const source = await readFile(new URL('../../src/index.js', import.meta.url), 'utf8');
    const machineBoundary = source.indexOf("if (pathLower === 'ops' || pathLower.startsWith('ops/'))");
    const websocketBoundary = source.indexOf("if (upgradeHeader === 'websocket')");

    assert.notEqual(machineBoundary, -1);
    assert.notEqual(websocketBoundary, -1);
    assert.ok(machineBoundary < websocketBoundary, 'machine-only /ops boundary must precede websocket dispatch');
});

test('plain HTTP is redirected before machine-only /ops authentication or mutation handling', async () => {
    const source = await readFile(new URL('../../src/index.js', import.meta.url), 'utf8');
    const httpsRedirect = source.indexOf("if (url.protocol === 'http:') return Response.redirect");
    const machineBoundary = source.indexOf("if (pathLower === 'ops' || pathLower.startsWith('ops/'))");
    const websocketBoundary = source.indexOf("if (upgradeHeader === 'websocket')");

    assert.notEqual(httpsRedirect, -1);
    assert.notEqual(machineBoundary, -1);
    assert.notEqual(websocketBoundary, -1);
    assert.ok(httpsRedirect < machineBoundary, 'HTTP redirect must precede /ops authentication and mutation handling');
    assert.ok(machineBoundary < websocketBoundary, 'machine-only /ops boundary must still precede websocket dispatch');
});
