import test from 'node:test';
import assert from 'node:assert/strict';
import { MD5MD5 } from '../src/utils/helpers.js';
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
});
