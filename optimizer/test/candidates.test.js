import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateSet, parseCidrs, sampleIpv4Cidrs } from '../src/candidates.js';

test('current winners and seeds are retained first and de-duplicated', () => {
  const result = buildCandidateSet({
    current: ['104.16.1.1'],
    seeds: ['104.16.2.2', '104.16.1.1'],
    cidrs: parseCidrs('104.16.0.0/13'),
    targetCount: 4,
    rng: () => 0.25,
  });
  assert.deepEqual(result.slice(0, 2), ['104.16.1.1', '104.16.2.2']);
  assert.equal(new Set(result).size, result.length);
});

test('sampling is deterministic with injected RNG and stays inside allowed CIDRs', () => {
  const cidrs = parseCidrs('104.16.0.0/30\n172.64.0.0/30');
  const first = sampleIpv4Cidrs(cidrs, 4, () => 0.4);
  const second = sampleIpv4Cidrs(cidrs, 4, () => 0.4);
  assert.deepEqual(first, second);
  assert.ok(first.every((ip) => /^104\.16\.0\.[12]$|^172\.64\.0\.[12]$/.test(ip)));
});

test('malformed or IPv6 CIDRs are rejected', () => {
  assert.throws(() => parseCidrs('104.16.0.0/33'), /CIDR/);
  assert.throws(() => parseCidrs('2606:4700::/32'), /IPv4/);
});
