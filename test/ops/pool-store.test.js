import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedCidrs, publishPool, readPoolStatus, rollbackPool } from '../../src/ops/pool-store.js';

class MemoryKV {
    constructor(seed = {}) {
        this.map = new Map(Object.entries(seed));
        this.puts = [];
    }

    async get(key) {
        return this.map.has(key) ? this.map.get(key) : null;
    }

    async put(key, value) {
        this.puts.push([key, String(value)]);
        this.map.set(key, String(value));
    }
}

const allowed = parseAllowedCidrs('104.16.0.0/13,172.64.0.0/13');

const entry = (address, name) => ({ address, port: 443, name });

test('stale expected revision performs no writes', async () => {
    const kv = new MemoryKV({
        'optimizer:current': 'rev-new',
        'ADD.txt': '104.16.1.1:443#old\n',
    });
    const env = { KV: kv };

    await assert.rejects(() => publishPool(env, {
        expected_current_revision: 'rev-old',
        entries: [entry('104.16.2.2', 'new')],
    }, allowed), (error) => error.status === 409);

    assert.equal(await kv.get('ADD.txt'), '104.16.1.1:443#old\n');
    assert.deepEqual(kv.puts, []);
});

test('first and second publish create immutable revisions and rollback restores previous pool', async () => {
    const kv = new MemoryKV();
    const env = { KV: kv };

    const first = await publishPool(env, {
        expected_current_revision: null,
        entries: [entry('104.16.1.1', 'first')],
    }, allowed);
    assert.match(first.revision, /^\d{8}T\d{9}Z-[0-9a-f]{12}$/);
    assert.equal(first.previous, null);
    assert.equal(await kv.get('optimizer:current'), first.revision);
    assert.equal(await kv.get('ADD.txt'), '104.16.1.1:443#first\n');
    assert.ok(await kv.get(`optimizer:pool:${first.revision}`));

    const second = await publishPool(env, {
        expected_current_revision: first.revision,
        entries: [entry('104.16.2.2', 'second')],
    }, allowed);
    assert.equal(second.previous, first.revision);
    assert.equal(await kv.get('optimizer:previous'), first.revision);
    assert.equal(await kv.get('optimizer:current'), second.revision);
    assert.equal(await kv.get('ADD.txt'), '104.16.2.2:443#second\n');

    const rolledBack = await rollbackPool(env, second.revision);
    assert.equal(rolledBack.revision, first.revision);
    assert.equal(await kv.get('optimizer:current'), first.revision);
    assert.equal(await kv.get('optimizer:previous'), second.revision);
    assert.equal(await kv.get('ADD.txt'), '104.16.1.1:443#first\n');

    const status = await readPoolStatus(env);
    assert.equal(status.current, first.revision);
    assert.equal(status.previous, second.revision);
    assert.equal(status.status.mutation, 'rollback');
});

test('rollback with stale expected revision performs no mutation', async () => {
    const kv = new MemoryKV({
        'optimizer:current': 'rev-current',
        'optimizer:previous': 'rev-previous',
        'ADD.txt': '104.16.1.1:443#current\n',
    });

    await assert.rejects(() => rollbackPool({ KV: kv }, 'rev-stale'), (error) => error.status === 409);
    assert.deepEqual(kv.puts, []);
    assert.equal(await kv.get('ADD.txt'), '104.16.1.1:443#current\n');
});
