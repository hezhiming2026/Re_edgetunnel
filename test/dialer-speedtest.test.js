import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_CONCURRENT_DIALS,
    parseConcurrentDialCount,
    raceSocketCandidates,
} from '../src/core/dialer.js';
import {
    buildLocal204Response,
    isSpeedTestSite,
    LocalSpeedTestSession,
    parseSpeedTestDomains,
    parseSpeedTestMode,
} from '../src/core/speedtest.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test('dial concurrency is request-safe and bounded', () => {
    assert.equal(parseConcurrentDialCount(undefined), 1);
    assert.equal(parseConcurrentDialCount('0'), 1);
    assert.equal(parseConcurrentDialCount('3'), 3);
    assert.equal(parseConcurrentDialCount('999'), MAX_CONCURRENT_DIALS);
    assert.equal(parseConcurrentDialCount('3junk'), 1);
    assert.equal(parseConcurrentDialCount('not-a-number', 2), 2);
});

test('socket racing selects the first success and closes late losers', async () => {
    const pending = new Map();
    const makeSocket = (name) => ({
        name,
        closed: false,
        close() { this.closed = true; },
    });
    const race = raceSocketCandidates([{ name: 'slow' }, { name: 'fast' }], (candidate) =>
        new Promise((resolve, reject) => pending.set(candidate.name, { resolve, reject }))
    );

    const fast = makeSocket('fast');
    pending.get('fast').resolve(fast);
    const result = await race;
    assert.equal(result.socket, fast);
    assert.equal(result.candidate.name, 'fast');

    const slow = makeSocket('slow');
    pending.get('slow').resolve(slow);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(slow.closed, true);
    assert.equal(fast.closed, false);
});

test('speed-test matching is case-insensitive, suffix-safe, and configurable', () => {
    const defaults = parseSpeedTestDomains();
    assert.equal(isSpeedTestSite('SPEED.CLOUDFLARE.COM', defaults), true);
    assert.equal(isSpeedTestSite('probe.cp.cloudflare.com.', defaults), true);
    assert.equal(isSpeedTestSite('notcloudflare.com', defaults), false);

    const custom = parseSpeedTestDomains('probe.example.com, PROBE.example.com invalid');
    assert.deepEqual(custom, ['probe.example.com']);
    assert.equal(isSpeedTestSite('child.probe.example.com', custom), true);
    assert.equal(parseSpeedTestMode('block'), 'block');
    assert.equal(parseSpeedTestMode('anything-else'), 'local');
});

test('local speed-test session handles split and pipelined HTTP requests', async () => {
    const responses = [];
    const session = new LocalSpeedTestSession(async (response) => responses.push(response), new Uint8Array([1, 0]));
    const requestA = 'GET /generate_204 HTTP/1.1\r\nHost: cp.cloudflare.com\r\n\r\n';
    const requestB = 'POST / HTTP/1.1\r\nHost: speed.cloudflare.com\r\nContent-Length: 4\r\n\r\ntest';
    const firstHalf = encoder.encode(requestA.slice(0, 20));
    const secondHalfAndPipeline = encoder.encode(requestA.slice(20) + requestB);

    assert.equal(await session.push(firstHalf), 0);
    assert.equal(await session.push(secondHalfAndPipeline), 2);
    assert.equal(responses.length, 2);
    assert.deepEqual([...responses[0].subarray(0, 2)], [1, 0]);
    assert.match(decoder.decode(responses[0].subarray(2)), /^HTTP\/1\.1 204 No Content/);
    assert.match(decoder.decode(responses[1]), /^HTTP\/1\.1 204 No Content/);
});

test('local speed-test parser rejects ambiguous or oversized input', async () => {
    const session = new LocalSpeedTestSession(async () => { }, null, {
        maxHeaderBytes: 64,
        maxRequestBytes: 128,
    });
    await assert.rejects(
        () => session.push(encoder.encode('POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n')),
        /Chunked/
    );

    const oversized = new LocalSpeedTestSession(async () => { }, null, {
        maxHeaderBytes: 32,
        maxRequestBytes: 64,
    });
    await assert.rejects(
        () => oversized.push(encoder.encode('GET / HTTP/1.1\r\nX-Long: ' + 'a'.repeat(40))),
        /headers are too large|buffer limit/
    );
});

test('204 builder frames the VLESS response header only when supplied', () => {
    const plain = buildLocal204Response();
    const framed = buildLocal204Response(new Uint8Array([7, 0]));
    assert.equal(decoder.decode(plain).startsWith('HTTP/1.1 204'), true);
    assert.deepEqual([...framed.subarray(0, 2)], [7, 0]);
});
