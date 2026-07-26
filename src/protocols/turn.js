import { connect } from 'cloudflare:sockets';
import { resolveIPv4 } from './dns.js';
import { md5Digest } from './shadowsocks.js';

const TIMEOUT_MS = 10_000;
const MAGIC_COOKIE = new Uint8Array([0x21, 0x12, 0xa4, 0x42]);
const TYPES = Object.freeze({
    ALLOCATE_REQUEST: 0x0003,
    ALLOCATE_SUCCESS: 0x0103,
    ALLOCATE_ERROR: 0x0113,
    CREATE_PERMISSION_REQUEST: 0x0008,
    CREATE_PERMISSION_SUCCESS: 0x0108,
    CONNECT_REQUEST: 0x000a,
    CONNECT_SUCCESS: 0x010a,
    CONNECTION_BIND_REQUEST: 0x000b,
    CONNECTION_BIND_SUCCESS: 0x010b,
});
const ATTRS = Object.freeze({
    USERNAME: 0x0006,
    MESSAGE_INTEGRITY: 0x0008,
    ERROR_CODE: 0x0009,
    XOR_PEER_ADDRESS: 0x0012,
    REALM: 0x0014,
    NONCE: 0x0015,
    REQUESTED_TRANSPORT: 0x0019,
    CONNECTION_ID: 0x002a,
});
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function concatBytes(...chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function withTimeout(promise, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function padding(length) {
    return -length & 3;
}

export function createTurnAttribute(type, value) {
    const body = value instanceof Uint8Array ? value : new Uint8Array(value);
    const result = new Uint8Array(4 + body.byteLength + padding(body.byteLength));
    const view = new DataView(result.buffer);
    view.setUint16(0, type);
    view.setUint16(2, body.byteLength);
    result.set(body, 4);
    return result;
}

export function createTurnMessage(type, transactionId, attributes = []) {
    const body = concatBytes(...attributes);
    const message = new Uint8Array(20 + body.byteLength);
    const view = new DataView(message.buffer);
    view.setUint16(0, type);
    view.setUint16(2, body.byteLength);
    message.set(MAGIC_COOKIE, 4);
    message.set(transactionId, 8);
    message.set(body, 20);
    return message;
}

function transactionId() {
    return crypto.getRandomValues(new Uint8Array(12));
}

function parseErrorCode(value) {
    return value?.byteLength >= 4 ? (value[2] & 7) * 100 + value[3] : 0;
}

async function addIntegrity(message, key) {
    const signed = new Uint8Array(message);
    const view = new DataView(signed.buffer);
    view.setUint16(2, view.getUint16(2) + 24);
    const hmacKey = await crypto.subtle.importKey(
        'raw',
        key,
        { name: 'HMAC', hash: 'SHA-1' },
        false,
        ['sign']
    );
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, signed));
    return concatBytes(signed, createTurnAttribute(ATTRS.MESSAGE_INTEGRITY, signature));
}

async function readMessage(reader, initial = null, timeoutMessage = 'TURN response timed out') {
    let buffer = initial?.byteLength ? new Uint8Array(initial) : new Uint8Array(0);
    const pull = async () => {
        const { done, value } = await withTimeout(reader.read(), timeoutMessage);
        if (done) throw new Error('TURN server closed the connection');
        buffer = concatBytes(buffer, new Uint8Array(value));
    };
    while (buffer.byteLength < 20) await pull();
    const messageLength = 20 + ((buffer[2] << 8) | buffer[3]);
    if (messageLength > 65_555) throw new Error('TURN response is too large');
    while (buffer.byteLength < messageLength) await pull();
    const message = buffer.subarray(0, messageLength);
    if (MAGIC_COOKIE.some((byte, index) => message[4 + index] !== byte)) {
        throw new Error('Invalid TURN magic cookie');
    }
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    const attributes = {};
    for (let offset = 20; offset + 4 <= messageLength;) {
        const type = view.getUint16(offset);
        const length = view.getUint16(offset + 2);
        if (offset + 4 + length > messageLength) throw new Error('Truncated TURN attribute');
        attributes[type] = message.slice(offset + 4, offset + 4 + length);
        offset += 4 + length + padding(length);
    }
    return {
        type: view.getUint16(0),
        attributes,
        extra: buffer.byteLength > messageLength ? buffer.slice(messageLength) : null,
    };
}

async function write(writer, bytes, message) {
    await withTimeout(writer.write(bytes), message);
}

function openTurnSocket(proxy) {
    return connect(
        { hostname: proxy.hostname, port: proxy.port },
        { secureTransport: proxy.tls ? 'on' : 'off', allowHalfOpen: true }
    );
}

export async function turnConnect(proxy, targetHost, targetPort, dnsResolver) {
    const targetIp = await resolveIPv4(targetHost, dnsResolver);
    let controlSocket;
    let dataSocket;
    let controlReader;
    let controlWriter;
    let dataReader;
    let dataWriter;
    let dataReaderReleased = false;

    const close = () => {
        try { controlSocket?.close(); } catch { }
        try { dataSocket?.close(); } catch { }
    };
    const releaseDataReader = () => {
        if (dataReaderReleased) return;
        dataReaderReleased = true;
        try { dataReader?.releaseLock(); } catch { }
    };

    try {
        controlSocket = openTurnSocket(proxy);
        await withTimeout(controlSocket.opened, 'TURN control connection timed out');
        controlReader = controlSocket.readable.getReader();
        controlWriter = controlSocket.writable.getWriter();

        const xorAddress = new Uint8Array(8);
        xorAddress[1] = 1;
        new DataView(xorAddress.buffer).setUint16(2, targetPort ^ 0x2112);
        targetIp.split('.').forEach((part, index) => {
            xorAddress[4 + index] = Number(part) ^ MAGIC_COOKIE[index];
        });
        const peer = createTurnAttribute(ATTRS.XOR_PEER_ADDRESS, xorAddress);
        const requestedTransport = createTurnAttribute(
            ATTRS.REQUESTED_TRANSPORT,
            new Uint8Array([6, 0, 0, 0])
        );

        await write(
            controlWriter,
            createTurnMessage(TYPES.ALLOCATE_REQUEST, transactionId(), [requestedTransport]),
            'TURN Allocate write timed out'
        );
        let response = await readMessage(controlReader, null, 'TURN Allocate response timed out');
        let buffered = response.extra;
        let integrityKey = null;
        let authAttributes = [];

        if (response.type === TYPES.ALLOCATE_ERROR && parseErrorCode(response.attributes[ATTRS.ERROR_CODE]) === 401) {
            if (!proxy.username || !proxy.password) throw new Error('TURN server requires credentials');
            const realmBytes = response.attributes[ATTRS.REALM];
            const nonce = response.attributes[ATTRS.NONCE];
            if (!realmBytes || !nonce?.byteLength) throw new Error('TURN challenge is incomplete');
            const realm = textDecoder.decode(realmBytes);
            integrityKey = md5Digest(textEncoder.encode(`${proxy.username}:${realm}:${proxy.password}`));
            authAttributes = [
                createTurnAttribute(ATTRS.USERNAME, textEncoder.encode(proxy.username)),
                createTurnAttribute(ATTRS.REALM, textEncoder.encode(realm)),
                createTurnAttribute(ATTRS.NONCE, nonce),
            ];
            const allocate = await addIntegrity(
                createTurnMessage(TYPES.ALLOCATE_REQUEST, transactionId(), [requestedTransport, ...authAttributes]),
                integrityKey
            );
            await write(controlWriter, allocate, 'Authenticated TURN Allocate write timed out');
            response = await readMessage(controlReader, buffered, 'Authenticated TURN Allocate response timed out');
            buffered = response.extra;
        }

        if (response.type !== TYPES.ALLOCATE_SUCCESS) {
            const code = parseErrorCode(response.attributes[ATTRS.ERROR_CODE]);
            throw new Error(code ? `TURN Allocate failed with ${code}` : 'TURN Allocate failed');
        }

        const sign = (message) => integrityKey ? addIntegrity(message, integrityKey) : Promise.resolve(message);
        const permission = await sign(createTurnMessage(
            TYPES.CREATE_PERMISSION_REQUEST,
            transactionId(),
            [peer, ...authAttributes]
        ));
        const connectRequest = await sign(createTurnMessage(
            TYPES.CONNECT_REQUEST,
            transactionId(),
            [peer, ...authAttributes]
        ));
        await write(
            controlWriter,
            concatBytes(permission, connectRequest),
            'TURN permission/connect write timed out'
        );

        response = await readMessage(controlReader, buffered, 'TURN permission response timed out');
        buffered = response.extra;
        if (response.type !== TYPES.CREATE_PERMISSION_SUCCESS) throw new Error('TURN permission failed');
        response = await readMessage(controlReader, buffered, 'TURN CONNECT response timed out');
        if (response.type !== TYPES.CONNECT_SUCCESS || !response.attributes[ATTRS.CONNECTION_ID]) {
            throw new Error('TURN CONNECT failed');
        }

        dataSocket = openTurnSocket(proxy);
        await withTimeout(dataSocket.opened, 'TURN data connection timed out');
        dataReader = dataSocket.readable.getReader();
        dataWriter = dataSocket.writable.getWriter();
        const bind = await sign(createTurnMessage(
            TYPES.CONNECTION_BIND_REQUEST,
            transactionId(),
            [
                createTurnAttribute(ATTRS.CONNECTION_ID, response.attributes[ATTRS.CONNECTION_ID]),
                ...authAttributes,
            ]
        ));
        await write(dataWriter, bind, 'TURN ConnectionBind write timed out');
        response = await readMessage(dataReader, null, 'TURN ConnectionBind response timed out');
        if (response.type !== TYPES.CONNECTION_BIND_SUCCESS) throw new Error('TURN ConnectionBind failed');
        const extra = response.extra;

        controlReader.releaseLock();
        controlReader = null;
        controlWriter.releaseLock();
        controlWriter = null;
        dataWriter.releaseLock();
        dataWriter = null;

        const readable = new ReadableStream({
            start(controller) {
                if (extra?.byteLength) controller.enqueue(extra);
            },
            async pull(controller) {
                const { done, value } = await dataReader.read();
                if (done) {
                    releaseDataReader();
                    controller.close();
                } else if (value?.byteLength) {
                    controller.enqueue(new Uint8Array(value));
                }
            },
            cancel() {
                try { dataReader?.cancel(); } catch { }
                releaseDataReader();
                close();
            },
        });
        const closed = dataSocket.closed.finally(() => {
            try { controlSocket?.close(); } catch { }
        });
        return {
            readable,
            writable: dataSocket.writable,
            opened: Promise.resolve({}),
            closed,
            close,
        };
    } catch (error) {
        try { controlReader?.releaseLock(); } catch { }
        try { controlWriter?.releaseLock(); } catch { }
        try { dataWriter?.releaseLock(); } catch { }
        releaseDataReader();
        close();
        throw error;
    }
}
