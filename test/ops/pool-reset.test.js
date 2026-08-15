import test from 'node:test';
import assert from 'node:assert/strict';
import * as authority from '../../src/ops/pool-authority-core.js';

class MemorySyncStorage {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
    this.kv = {
      get: (key) => this.map.get(key),
      put: (key, value) => this.map.set(key, structuredClone(value)),
      delete: (key) => this.map.delete(key),
    };
  }
  transactionSync(callback) { callback(); }
}

test('first-publish recovery clears optimizer authority only when expected revision still matches', () => {
  assert.equal(typeof authority.resetAuthoritativePoolToEmpty, 'function');
  const storage = new MemorySyncStorage({
    current: 'r2',
    add_txt: '104.16.1.1:443#nas-01\n',
    'pool:r2': { revision: 'r2', checksum: 'abc', entries: [] },
  });

  const stale = authority.resetAuthoritativePoolToEmpty(storage, 'stale');
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 409);
  assert.equal(storage.map.get('current'), 'r2');

  const cleared = authority.resetAuthoritativePoolToEmpty(storage, 'r2', '2026-08-15T12:00:00.000Z');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.revision, null);
  assert.equal(cleared.previous, 'r2');
  assert.equal(storage.map.has('current'), false);
  assert.equal(storage.map.has('previous'), false);
  assert.equal(storage.map.get('add_txt'), '');
  const state = authority.readAuthoritativeAddState(storage);
  assert.equal(state.initialized, true);
  assert.equal(state.source, 'optimizer');
  assert.equal(state.add_txt, '');
  assert.equal(storage.map.get('status').mutation, 'reset_empty');
});

test('empty reset preserves an independent manual ADD override', () => {
  assert.equal(typeof authority.resetAuthoritativePoolToEmpty, 'function');
  const storage = new MemorySyncStorage({
    current: 'r2',
    add_txt: '104.16.1.1:443#nas-01\n',
    manual_add_initialized: true,
    manual_add_txt: 'manual.example.com:443#manual\n',
  });

  const result = authority.resetAuthoritativePoolToEmpty(storage, 'r2');
  assert.equal(result.ok, true);
  assert.equal(authority.readAuthoritativeAddState(storage).source, 'manual');
  assert.equal(authority.readAuthoritativeAddTxt(storage), 'manual.example.com:443#manual\n');
});
