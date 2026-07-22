import assert from 'node:assert/strict';
import { sha224 } from '../src/utils/helpers.js';

const [webSocketUrl, credential, targetHost = 'www.google.com', targetPortText = '80'] = process.argv.slice(2);
const targetPort = Number(targetPortText);
if (!webSocketUrl || !credential || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error('Usage: node scripts/verify-cloudflare-proxy.mjs <wss-url> <uuid> [target-host] [target-port]');
}

const encoder = new TextEncoder();
const requestPayload = encoder.encode(`GET / HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
const hostBytes = encoder.encode(targetHost);

function portBytes() {
    return [targetPort >> 8, targetPort & 0xff];
}

function vlessPacket() {
    const uuidBytes = credential.replaceAll('-', '').match(/../g)?.map((pair) => Number.parseInt(pair, 16));
    if (!uuidBytes || uuidBytes.length !== 16 || uuidBytes.some(Number.isNaN)) throw new Error('VLESS credential must be a UUID');
    return new Uint8Array([0, ...uuidBytes, 0, 1, ...portBytes(), 2, hostBytes.length, ...hostBytes, ...requestPayload]);
}

function trojanPacket() {
    const passwordHash = encoder.encode(sha224(credential));
    return new Uint8Array([...passwordHash, 0x0d, 0x0a, 1, 3, hostBytes.length, ...hostBytes, ...portBytes(), 0x0d, 0x0a, ...requestPayload]);
}

async function verifyProtocol(name, packet, responseHeaderBytes) {
    const response = await new Promise((resolve, reject) => {
        const socket = new WebSocket(webSocketUrl);
        socket.binaryType = 'arraybuffer';
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error(`${name} proxy response timed out`));
        }, 20_000);
        socket.addEventListener('open', () => socket.send(packet));
        socket.addEventListener('message', (event) => {
            clearTimeout(timeout);
            socket.close();
            resolve(new Uint8Array(event.data));
        });
        socket.addEventListener('error', (event) => {
            clearTimeout(timeout);
            reject(event.error || new Error(`${name} WebSocket error`));
        });
    });

    if (responseHeaderBytes) assert.deepEqual([...response.slice(0, responseHeaderBytes)], [0, 0]);
    const text = new TextDecoder().decode(response.slice(responseHeaderBytes));
    assert.match(text, /^HTTP\/1\.[01] [1-5]\d\d/, `${name} did not return a valid HTTP response through TCP`);
    console.log(`${name.toUpperCase()}_TCP_PROXY_OK`);
}

await verifyProtocol('vless', vlessPacket(), 2);
await verifyProtocol('trojan', trojanPacket(), 0);
