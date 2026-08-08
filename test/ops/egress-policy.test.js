import test from 'node:test';
import assert from 'node:assert/strict';
import {
    matchDomainSuffix,
    parseDiagnosticTargets,
    parseDomainSuffixList,
    parseEgressRuntimeConfig,
    resolveEgressPolicy,
} from '../../src/ops/egress-policy.js';

test('suffix matching honors DNS label boundaries', () => {
    assert.equal(matchDomainSuffix('x.com', ['x.com']), true);
    assert.equal(matchDomainSuffix('api.x.com', ['x.com']), true);
    assert.equal(matchDomainSuffix('notx.com', ['x.com']), false);
});

test('v1 rejects wildcard, IP literal, URL, and unsafe suffix policies', () => {
    assert.deepEqual(
        parseDomainSuffixList('*,1.1.1.1,https://bad.example,example.com,bad/path.example'),
        ['example.com'],
    );
});

test('diagnostic targets accept only named bounded host:port entries', () => {
    const targets = parseDiagnosticTargets('baseline=example.com:443,target-a=example.net:8443,bad=127.0.0.1:22,UPPER=Example.org:443');
    assert.deepEqual([...targets.entries()], [
        ['baseline', { hostname: 'example.com', port: 443 }],
        ['target-a', { hostname: 'example.net', port: 8443 }],
        ['upper', { hostname: 'example.org', port: 443 }],
    ]);
});

test('policy precedence is force then fallback then direct', () => {
    const config = {
        fallbackDomains: ['example.com'],
        forceEgressDomains: ['api.example.com'],
    };
    assert.equal(resolveEgressPolicy('api.example.com', config), 'force');
    assert.equal(resolveEgressPolicy('www.example.com', config), 'fallback');
    assert.equal(resolveEgressPolicy('example.net', config), 'direct');
});

test('Stage A runtime config parses policy but keeps routing disabled', () => {
    const config = parseEgressRuntimeConfig({
        DIAGNOSTIC_TARGETS: 'baseline=example.com:443',
        FALLBACK_DOMAINS: 'example.com',
        FORCE_EGRESS_DOMAINS: 'example.net',
        EGRESS_FIRST_BYTE_TIMEOUT_MS: '9000',
    });

    assert.equal(config.diagnosticTargets.get('baseline').hostname, 'example.com');
    assert.deepEqual(config.fallbackDomains, ['example.com']);
    assert.deepEqual(config.forceEgressDomains, ['example.net']);
    assert.equal(config.egressFirstByteTimeoutMs, 9000);
    assert.equal(config.egressRoutingEnabled, false);
});
