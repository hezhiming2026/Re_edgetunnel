import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProxyUri, MD5MD5 } from '../src/utils/helpers.js';
import { readConfig } from '../src/config.js';

class MemoryKV {
    constructor() { this.values = new Map(); }
    async get(key) { return this.values.get(key) ?? null; }
    async put(key, value) { this.values.set(key, value); }
}

test('token hashing works without unsupported WebCrypto MD5', async () => {
    assert.equal(await MD5MD5('hello'), 'f7481295eaac1eb07163731dd1e00e9e');
});

test('default configuration initializes and never generates ech=null', async () => {
    const config = await readConfig({ KV: new MemoryKV() }, 'worker.example', '00000000-0000-4000-8000-000000000000', '/admin');
    assert.match(config.LINK, /^vless:\/\//);
    assert.doesNotMatch(config.LINK, /ech=null/);
    assert.equal(config.跳过证书验证, false);
    assert.deepEqual(config.支持协议, ['vless', 'trojan', 'shadowsocks']);
    assert.deepEqual(config.TRANSPORTS, ['ws', 'xhttp', 'grpc']);
    assert.equal(config.LINKS.length, 7);
    assert.match(config.LINKS.at(-1), /^ss:\/\//);
    assert.deepEqual(config.客户端DNS, []);
});

test('VLESS and Trojan links use protocol-appropriate parameters', () => {
    const common = { credential: '00000000-0000-4000-8000-000000000000', address: 'edge.example', host: 'edge.example' };
    const vless = buildProxyUri({ ...common, protocol: 'vless' });
    const trojan = buildProxyUri({ ...common, protocol: 'trojan' });
    assert.match(vless, /^vless:\/\//);
    assert.match(vless, /encryption=none/);
    assert.match(trojan, /^trojan:\/\//);
    assert.doesNotMatch(trojan, /encryption=/);
});

test('transport URIs expose compatible XHTTP and gRPC parameters', () => {
    const common = {
        protocol: 'vless',
        credential: '00000000-0000-4000-8000-000000000000',
        address: '2001:db8::1',
        host: 'worker.example',
        path: '/tunnel',
    };
    const xhttp = buildProxyUri({ ...common, transport: 'xhttp' });
    const grpc = buildProxyUri({ ...common, transport: 'grpc' });
    assert.match(xhttp, /^vless:\/\/[^@]+@\[2001:db8::1\]:443\?/);
    assert.match(xhttp, /type=xhttp/);
    assert.match(xhttp, /mode=stream-one/);
    assert.match(grpc, /type=grpc/);
    assert.match(grpc, /serviceName=tunnel/);
    assert.match(grpc, /mode=gun/);
    assert.doesNotMatch(grpc, /path=/);
});
