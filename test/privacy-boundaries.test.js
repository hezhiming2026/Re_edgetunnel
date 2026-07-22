import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogUrl } from '../src/config.js';
import { fetchMasquerade } from '../src/utils/pages.js';
import { ClashPatch, SingboxPatch } from '../src/utils/patches.js';
import { parseLocalAddressList, parseProxyAddress } from '../src/utils/ip.js';

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

test('subscription patches do not inject public DNS services', () => {
    const untouched = SingboxPatch(JSON.stringify({ dns: { servers: [{ address: '1.1.1.1' }] } }), null, null, null);
    assert.match(untouched, /1\.1\.1\.1/);
    assert.doesNotMatch(untouched, /8\.8\.8\.8|8\.8\.4\.4/);

    const clash = ClashPatch('proxies: []\n', null, false, [], null, null, ['https://dns.operator.example/dns-query']);
    assert.match(clash, /dns\.operator\.example/);
    assert.doesNotMatch(clash, /doh\.pub|alidns|8\.8\.4\.4|208\.67/);
});

test('proxy hostnames are passed to Cloudflare socket DNS without hidden DoH fetches', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => { throw new Error('unexpected fetch'); };
    assert.deepEqual(await parseProxyAddress('proxy.operator.example:8443'), [['proxy.operator.example', 8443]]);
});

test('operator-owned address lists are parsed locally and invalid entries are ignored', () => {
    assert.deepEqual(parseLocalAddressList('edge.operator.example:8443#owned\ninvalid host\n[2001:db8::1]:443#v6'), [
        { address: 'edge.operator.example', port: 8443, name: 'owned' },
        { address: '[2001:db8::1]', port: 443, name: 'v6' },
    ]);
});
