import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrojanRequest, parseVlessRequest } from '../src/protocols/parsers.js';
import { isSafeConnectTarget, sha224 } from '../src/utils/helpers.js';

test('VLESS parser rejects truncated addresses without throwing', () => {
    const request = new Uint8Array(24);
    request[17] = 0;
    request[18] = 1;
    request[19] = 1;
    request[20] = 187;
    request[21] = 3;
    request[22] = 5;
    assert.doesNotThrow(() => parseVlessRequest(request.buffer, '00000000-0000-0000-0000-000000000000'));
    assert.equal(parseVlessRequest(request.buffer, '00000000-0000-0000-0000-000000000000').hasError, true);
});

test('Trojan parser rejects a truncated address without throwing', () => {
    const request = new Uint8Array(60);
    request.set(new TextEncoder().encode(sha224('secret')));
    request[56] = 0x0d;
    request[57] = 0x0a;
    request[58] = 1;
    request[59] = 4;
    assert.doesNotThrow(() => parseTrojanRequest(request.buffer, 'secret'));
    assert.equal(parseTrojanRequest(request.buffer, 'secret').hasError, true);
});

test('HTTP CONNECT targets cannot inject headers', () => {
    assert.equal(isSafeConnectTarget('example.com', 443), true);
    assert.equal(isSafeConnectTarget('example.com\r\nX-Injected: yes', 443), false);
    assert.equal(isSafeConnectTarget('example.com', 0), false);
});
