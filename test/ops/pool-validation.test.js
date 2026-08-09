import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAddTxt, parseAllowedCidrs, validatePoolEntries } from '../../src/ops/pool-store.js';

const allowed = parseAllowedCidrs('104.16.0.0/13,172.64.0.0/13');

test('accepts Cloudflare IPv4 port 443 entries and canonicalizes them', () => {
    const result = validatePoolEntries([
        { address: '104.16.1.1', port: 443, name: 'rank-01' },
        { address: '104.16.2.2', port: 443, name: 'rank-02' },
    ], allowed);

    assert.deepEqual(result, [
        { address: '104.16.1.1', port: 443, name: 'rank-01' },
        { address: '104.16.2.2', port: 443, name: 'rank-02' },
    ]);
    assert.equal(formatAddTxt(result), '104.16.1.1:443#rank-01\n104.16.2.2:443#rank-02\n');
});

test('rejects non-443, duplicates, foreign CIDRs, and third address in one /24', () => {
    assert.throws(() => validatePoolEntries([{ address: '104.16.1.1', port: 8443, name: 'bad' }], allowed));
    assert.throws(() => validatePoolEntries([{ address: '203.0.113.10', port: 443, name: 'bad' }], allowed));
    assert.throws(() => validatePoolEntries([
        { address: '104.16.1.1', port: 443, name: 'a' },
        { address: '104.16.1.1', port: 443, name: 'b' },
    ], allowed));
    assert.throws(() => validatePoolEntries([
        { address: '104.16.1.1', port: 443, name: 'a' },
        { address: '104.16.1.2', port: 443, name: 'b' },
        { address: '104.16.1.3', port: 443, name: 'c' },
    ], allowed));
});

test('rejects malformed CIDRs, empty pools, excessive entries, and unsafe labels', () => {
    assert.throws(() => parseAllowedCidrs(''));
    assert.throws(() => parseAllowedCidrs('104.16.0.0/33'));
    assert.throws(() => validatePoolEntries([], allowed));
    assert.throws(() => validatePoolEntries(Array.from({ length: 17 }, (_, index) => ({
        address: `104.16.${index}.1`, port: 443, name: `rank-${index}`,
    })), allowed));
    assert.throws(() => validatePoolEntries([{ address: '104.16.1.1', port: 443, name: 'bad\nlabel' }], allowed));
    assert.throws(() => validatePoolEntries([{ address: '104.16.1.1', port: 443, name: '界'.repeat(22) }], allowed));
});
