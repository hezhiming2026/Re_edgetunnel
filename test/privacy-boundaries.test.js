import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogUrl } from '../src/config.js';
import { fetchMasquerade } from '../src/utils/pages.js';
import { SingboxPatch } from '../src/utils/patches.js';

test('request logs remove subscription credentials', () => {
    const logged = sanitizeLogUrl('https://worker.example/sub?token=secret&clash&api_key=also-secret');
    assert.equal(logged, 'https://worker.example/sub?clash=');
});

test('masquerade forwarding drops credentials and Cloudflare client headers', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let outbound;
    globalThis.fetch = async (url, init) => {
        outbound = { url, init };
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
    };

    const request = new Request('https://worker.example/path?q=1', {
        headers: {
            Accept: 'text/html',
            Authorization: 'Bearer secret',
            Cookie: 'auth=secret',
            'CF-Connecting-IP': '203.0.113.1',
            'X-Forwarded-For': '203.0.113.1',
        },
    });
    const response = await fetchMasquerade('https://origin.example/base', request);

    assert.equal(await response.text(), 'ok');
    assert.equal(outbound.url.toString(), 'https://origin.example/path?q=1');
    assert.equal(outbound.init.headers.get('authorization'), null);
    assert.equal(outbound.init.headers.get('cookie'), null);
    assert.equal(outbound.init.headers.get('cf-connecting-ip'), null);
    assert.equal(outbound.init.headers.get('x-forwarded-for'), null);
    assert.equal(outbound.init.headers.get('accept'), 'text/html');
});

test('Sing-box patch emits remote rule sets only for an operator-provided base URL', () => {
    const input = JSON.stringify({ route: { rules: [{ geosite: 'cn', outbound: 'DIRECT' }] } });
    assert.doesNotMatch(SingboxPatch(input, null, null, null), /https:\/\//);
    assert.match(SingboxPatch(input, null, null, null, 'https://rules.example'), /https:\/\/rules\.example\/geosite-cn\.srs/);
});
