import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGrpcHunk, GrpcFrameDecoder } from '../src/protocols/grpc.js';
import { readTunnelHandshake, tryParseTunnelHandshake } from '../src/protocols/handshake.js';
import {
    md5Digest,
    ShadowsocksAeadDecoder,
    ShadowsocksAeadEncoder,
    tryParseShadowsocksTarget,
} from '../src/protocols/shadowsocks.js';
import { parseUpstreamProxy } from '../src/protocols/upstream.js';
import {
    frameTcpDnsQuery,
    TrojanDnsResponseFramer,
    TrojanUdpDecoder,
} from '../src/protocols/trojan-udp.js';
import { sha224 } from '../src/utils/helpers.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const credential = '00000000-0000-0000-0000-000000000000';

function vlessRequest(payload = new Uint8Array(0)) {
    const host = encoder.encode('example.com');
    return new Uint8Array([
        0,
        ...new Uint8Array(16),
        0,
        1,
        0x01, 0xbb,
        2,
        host.byteLength,
        ...host,
        ...payload,
    ]);
}

function trojanRequest(command = 1, payload = new Uint8Array(0)) {
    const password = encoder.encode(sha224(credential));
    const host = encoder.encode('example.com');
    return new Uint8Array([
        ...password,
        0x0d, 0x0a,
        command,
        3,
        host.byteLength,
        ...host,
        0, 53,
        0x0d, 0x0a,
        ...payload,
    ]);
}

test('incremental handshake parser handles split VLESS data without over-reading', async () => {
    const request = vlessRequest(encoder.encode('hello'));
    assert.equal(tryParseTunnelHandshake(request.subarray(0, 20), credential).status, 'need-more');
    const chunks = [request.subarray(0, 12), request.subarray(12, 27), request.subarray(27)];
    const reader = {
        async read() {
            return chunks.length
                ? { done: false, value: chunks.shift() }
                : { done: true, value: undefined };
        },
    };
    const parsed = await readTunnelHandshake(reader, credential);
    assert.equal(parsed.protocol, 'vless');
    assert.equal(parsed.hostname, 'example.com');
    assert.equal(parsed.port, 443);
    assert.equal(decoder.decode(parsed.rawData), 'hello');
});

test('Trojan UDP associate is parsed explicitly', () => {
    const parsed = tryParseTunnelHandshake(trojanRequest(3), credential);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.protocol, 'trojan');
    assert.equal(parsed.isUDP, true);
    assert.equal(parsed.port, 53);
});

test('Trojan UDP codec preserves fragmented datagrams and frames TCP DNS responses', () => {
    const host = encoder.encode('dns.example');
    const payload = new Uint8Array([0x12, 0x34, 0x01, 0x00]);
    const packet = new Uint8Array([
        3, host.byteLength, ...host,
        0, 53,
        0, payload.byteLength,
        0x0d, 0x0a,
        ...payload,
    ]);
    const parser = new TrojanUdpDecoder();
    assert.deepEqual(parser.push(packet.subarray(0, 8)), []);
    const decoded = parser.push(packet.subarray(8));
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].port, 53);
    assert.deepEqual(decoded[0].payload, payload);

    const tcpDns = frameTcpDnsQuery(payload);
    assert.deepEqual(tcpDns, new Uint8Array([0, payload.byteLength, ...payload]));
    const framer = new TrojanDnsResponseFramer(decoded[0].addressHeader);
    assert.deepEqual(framer.push(tcpDns.subarray(0, 3)), []);
    const responseFrames = framer.push(tcpDns.subarray(3));
    assert.equal(responseFrames.length, 1);
    assert.deepEqual(responseFrames[0], packet);
});

test('gRPC hunk codec handles fragmented and coalesced frames', () => {
    const first = encodeGrpcHunk(encoder.encode('one'));
    const second = encodeGrpcHunk(encoder.encode('two'));
    const joined = new Uint8Array(first.byteLength + second.byteLength);
    joined.set(first);
    joined.set(second, first.byteLength);
    const frames = new GrpcFrameDecoder();
    assert.deepEqual(frames.push(joined.subarray(0, 7)), []);
    assert.deepEqual(frames.push(joined.subarray(7)).map((value) => decoder.decode(value)), ['one', 'two']);
});

test('Shadowsocks AEAD derives standard MD5 keys and round-trips split records', async () => {
    const digest = [...md5Digest(encoder.encode('password'))]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    assert.equal(digest, '5f4dcc3b5aa765d61d8327deb882cf99');

    for (const method of ['aes-128-gcm', 'aes-256-gcm']) {
        const encrypt = new ShadowsocksAeadEncoder(method, 'secret');
        const decrypt = new ShadowsocksAeadDecoder(method, 'secret');
        const ciphertext = await encrypt.encode(encoder.encode('round trip'));
        assert.deepEqual(await decrypt.push(ciphertext.subarray(0, 10)), []);
        const plaintext = await decrypt.push(ciphertext.subarray(10));
        assert.equal(decoder.decode(plaintext[0]), 'round trip');
    }
});

test('Shadowsocks target parser supports domain and preserves initial payload', () => {
    const host = encoder.encode('example.com');
    const parsed = tryParseShadowsocksTarget(new Uint8Array([
        3,
        host.byteLength,
        ...host,
        1, 187,
        ...encoder.encode('GET'),
    ]));
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.hostname, 'example.com');
    assert.equal(parsed.port, 443);
    assert.equal(decoder.decode(parsed.rawData), 'GET');
});

test('upstream proxy URLs are strict and cover every supported adapter', () => {
    assert.deepEqual(parseUpstreamProxy('https://user:pass@proxy.example'), {
        type: 'https',
        hostname: 'proxy.example',
        port: 443,
        username: 'user',
        password: 'pass',
        tls: true,
    });
    assert.equal(parseUpstreamProxy('turn://turn.example').port, 3478);
    assert.equal(parseUpstreamProxy('turns://turn.example').port, 5349);
    assert.equal(parseUpstreamProxy('sstp://vpn.example').port, 443);
    assert.throws(() => parseUpstreamProxy('ftp://proxy.example'), /Unsupported/);
    assert.throws(() => parseUpstreamProxy('https://proxy.example/path'), /must contain only/);
});
