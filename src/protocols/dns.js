import { connect } from 'cloudflare:sockets';
import { isSafeConnectTarget } from '../utils/helpers.js';

const DNS_TIMEOUT_MS = 5000;
const MAX_DNS_RESPONSE_BYTES = 4096;

async function withTimeout(promise, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), DNS_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function encodeDnsName(hostname) {
    const labels = hostname.replace(/\.$/, '').split('.');
    if (!labels.length || labels.some((label) => !label || label.length > 63)) {
        throw new Error('Invalid DNS hostname');
    }
    const encoded = [];
    const encoder = new TextEncoder();
    for (const label of labels) {
        const bytes = encoder.encode(label);
        encoded.push(bytes.byteLength, ...bytes);
    }
    encoded.push(0);
    return new Uint8Array(encoded);
}

function skipDnsName(message, offset) {
    let cursor = offset;
    let labels = 0;
    while (cursor < message.byteLength) {
        if (++labels > 128) throw new Error('DNS name has too many labels');
        const length = message[cursor];
        if ((length & 0xc0) === 0xc0) {
            if (cursor + 1 >= message.byteLength) throw new Error('Truncated DNS pointer');
            return cursor + 2;
        }
        cursor += 1;
        if (length === 0) return cursor;
        if (length > 63 || cursor + length > message.byteLength) throw new Error('Invalid DNS name');
        cursor += length;
    }
    throw new Error('Truncated DNS name');
}

function parseARecords(message, expectedId) {
    if (message.byteLength < 12) throw new Error('Truncated DNS response');
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    if (view.getUint16(0) !== expectedId) throw new Error('DNS transaction ID mismatch');
    if ((view.getUint16(2) & 0x000f) !== 0) return [];
    const questionCount = view.getUint16(4);
    const answerCount = view.getUint16(6);
    let cursor = 12;
    for (let index = 0; index < questionCount; index++) {
        cursor = skipDnsName(message, cursor);
        if (cursor + 4 > message.byteLength) throw new Error('Truncated DNS question');
        cursor += 4;
    }
    const addresses = [];
    for (let index = 0; index < answerCount; index++) {
        cursor = skipDnsName(message, cursor);
        if (cursor + 10 > message.byteLength) throw new Error('Truncated DNS answer');
        const type = view.getUint16(cursor);
        const klass = view.getUint16(cursor + 2);
        const length = view.getUint16(cursor + 8);
        cursor += 10;
        if (cursor + length > message.byteLength) throw new Error('Truncated DNS record');
        if (type === 1 && klass === 1 && length === 4) {
            addresses.push([...message.subarray(cursor, cursor + 4)].join('.'));
        }
        cursor += length;
    }
    return addresses;
}

export function isIPv4(hostname) {
    const parts = String(hostname ?? '').split('.');
    return parts.length === 4 && parts.every((part) =>
        /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255
    );
}

export async function resolveIPv4(hostname, resolver) {
    const normalized = String(hostname ?? '').replace(/^\[|\]$/g, '');
    if (isIPv4(normalized)) return normalized;
    if (!resolver || !isSafeConnectTarget(resolver.hostname, resolver.port)) {
        throw new Error(`A configured DNS_RESOLVER is required to resolve ${normalized}`);
    }

    const idBytes = crypto.getRandomValues(new Uint8Array(2));
    const id = (idBytes[0] << 8) | idBytes[1];
    const name = encodeDnsName(normalized);
    const query = new Uint8Array(12 + name.byteLength + 4);
    const view = new DataView(query.buffer);
    view.setUint16(0, id);
    view.setUint16(2, 0x0100);
    view.setUint16(4, 1);
    query.set(name, 12);
    view.setUint16(12 + name.byteLength, 1);
    view.setUint16(14 + name.byteLength, 1);

    const framed = new Uint8Array(query.byteLength + 2);
    new DataView(framed.buffer).setUint16(0, query.byteLength);
    framed.set(query, 2);

    const socket = connect(
        { hostname: resolver.hostname.replace(/^\[|\]$/g, ''), port: resolver.port },
        { allowHalfOpen: true }
    );
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    try {
        await withTimeout(socket.opened, 'DNS resolver connection timed out');
        await withTimeout(writer.write(framed), 'DNS query write timed out');
        let buffered = new Uint8Array(0);
        let expectedLength = null;
        while (expectedLength === null || buffered.byteLength < expectedLength + 2) {
            const { done, value } = await withTimeout(reader.read(), 'DNS response timed out');
            if (done) throw new Error('DNS resolver closed the connection');
            const next = new Uint8Array(buffered.byteLength + value.byteLength);
            next.set(buffered);
            next.set(value, buffered.byteLength);
            buffered = next;
            if (buffered.byteLength >= 2 && expectedLength === null) {
                expectedLength = new DataView(buffered.buffer, buffered.byteOffset, 2).getUint16(0);
                if (expectedLength > MAX_DNS_RESPONSE_BYTES) throw new Error('DNS response is too large');
            }
        }
        const addresses = parseARecords(buffered.subarray(2, 2 + expectedLength), id);
        if (!addresses.length) throw new Error(`No IPv4 address found for ${normalized}`);
        return addresses[0];
    } finally {
        try { writer.releaseLock(); } catch { }
        try { reader.releaseLock(); } catch { }
        try { socket.close(); } catch { }
    }
}
