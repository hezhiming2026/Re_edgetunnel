import test from 'node:test';
import assert from 'node:assert/strict';
import {
    publishAuthoritativePool,
    readAuthoritativeAddTxt,
    readAuthoritativePoolStatus,
    rollbackAuthoritativePool,
} from '../../src/ops/pool-authority-core.js';
import {
    buildPoolSnapshot,
    formatAddTxt,
    parseAllowedCidrs,
    readOptimizerAddTxt,
    validatePoolEntries,
} from '../../src/ops/pool-store.js';

class MemorySyncStorage {
    constructor(seed = {}) {
        this.map = new Map(Object.entries(seed));
        this.mutations = [];
        this.kv = {
            get: (key) => this.map.get(key),
            put: (key, value) => {
                this.mutations.push(['put', key]);
                this.map.set(key, structuredClone(value));
            },
            delete: (key) => {
                this.mutations.push(['delete', key]);
                this.map.delete(key);
            },
        };
    }

    transactionSync(callback) {
        callback();
    }
}

const allowed = parseAllowedCidrs('104.16.0.0/13,172.64.0.0/13');
const entry = (address, name) => ({ address, port: 443, name });

async function requestFor(address, name, expected, iso) {
    const entries = validatePoolEntries([entry(address, name)], allowed);
    const snapshot = await buildPoolSnapshot(entries, new Date(iso));
    return {
        expected_current_revision: expected,
        snapshot,
        add_txt: formatAddTxt(entries),
    };
}

test('two mutations using the same expected revision cannot both succeed', async () => {
    const storage = new MemorySyncStorage();
    const firstRequest = await requestFor('104.16.1.1', 'first', null, '2026-08-08T00:00:00.000Z');
    const competingRequest = await requestFor('104.16.2.2', 'second', null, '2026-08-08T00:00:01.000Z');

    const first = publishAuthoritativePool(storage, firstRequest);
    assert.equal(first.ok, true);
    const mutationsAfterFirst = storage.mutations.length;

    const second = publishAuthoritativePool(storage, competingRequest);
    assert.deepEqual(second, {
        ok: false,
        status: 409,
        error: 'Current optimizer revision changed',
    });
    assert.equal(storage.mutations.length, mutationsAfterFirst);
    assert.equal(readAuthoritativePoolStatus(storage).current, firstRequest.snapshot.revision);
    assert.equal(readAuthoritativeAddTxt(storage), '104.16.1.1:443#first\n');
});

test('publish sequence and rollback are atomic against authoritative state', async () => {
    const storage = new MemorySyncStorage();
    const firstRequest = await requestFor('104.16.1.1', 'first', null, '2026-08-08T00:00:00.000Z');
    const first = publishAuthoritativePool(storage, firstRequest);
    assert.equal(first.ok, true);

    const secondRequest = await requestFor('104.16.2.2', 'second', first.revision, '2026-08-08T00:00:01.000Z');
    const second = publishAuthoritativePool(storage, secondRequest);
    assert.equal(second.ok, true);
    assert.equal(second.previous, first.revision);
    assert.equal(readAuthoritativeAddTxt(storage), '104.16.2.2:443#second\n');

    const rollback = rollbackAuthoritativePool(storage, second.revision, '2026-08-08T00:00:02.000Z');
    assert.equal(rollback.ok, true);
    assert.equal(rollback.revision, first.revision);
    assert.equal(readAuthoritativeAddTxt(storage), '104.16.1.1:443#first\n');

    const status = readAuthoritativePoolStatus(storage);
    assert.equal(status.current, first.revision);
    assert.equal(status.previous, second.revision);
    assert.equal(status.status.mutation, 'rollback');
});

test('stale rollback makes no authoritative mutation', async () => {
    const storage = new MemorySyncStorage();
    const firstRequest = await requestFor('104.16.1.1', 'first', null, '2026-08-08T00:00:00.000Z');
    const first = publishAuthoritativePool(storage, firstRequest);
    assert.equal(first.ok, true);
    const mutationsBefore = storage.mutations.length;

    const result = rollbackAuthoritativePool(storage, 'stale-revision');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(storage.mutations.length, mutationsBefore);
    assert.equal(readAuthoritativePoolStatus(storage).current, first.revision);
});

test('snapshot revision is timestamp plus canonical checksum prefix', async () => {
    const entries = validatePoolEntries([entry('104.16.3.3', 'rank-01')], allowed);
    const snapshot = await buildPoolSnapshot(entries, new Date('2026-08-08T12:34:56.789Z'));
    assert.match(snapshot.revision, /^20260808T123456789Z-[0-9a-f]{12}$/);
    assert.match(snapshot.checksum, /^[0-9a-f]{64}$/);
});

test('legacy fallback is allowed only when durable binding is absent or uninitialized', async () => {
    assert.equal(await readOptimizerAddTxt({}), null);
    assert.equal(await readOptimizerAddTxt({
        OPTIMIZER_COORDINATOR: {
            getByName() {
                return { getAddTxt: async () => null };
            },
        },
    }), null);
});

test('durable authority RPC errors fail closed instead of silently falling back', async () => {
    await assert.rejects(() => readOptimizerAddTxt({
        OPTIMIZER_COORDINATOR: {
            getByName() {
                return { getAddTxt: async () => { throw new Error('authority unavailable'); } };
            },
        },
    }), /authority unavailable/);
});
