import { parseTrojanRequest, parseVlessRequest } from './parsers.js';

const MAX_HANDSHAKE_BYTES = 8192;

function concatBytes(left, right) {
    const result = new Uint8Array(left.byteLength + right.byteLength);
    result.set(left);
    result.set(right, left.byteLength);
    return result;
}

function requiredVlessBytes(data) {
    if (data.byteLength < 19) return null;
    const commandIndex = 18 + data[17];
    if (data.byteLength <= commandIndex) return null;
    if (data[commandIndex] !== 1 && data[commandIndex] !== 2) return -1;

    const addressTypeIndex = commandIndex + 3;
    if (data.byteLength <= addressTypeIndex) return null;
    const addressStart = addressTypeIndex + 1;
    if (data[addressTypeIndex] === 1) return addressStart + 4;
    if (data[addressTypeIndex] === 3) return addressStart + 16;
    if (data[addressTypeIndex] === 2) {
        if (data.byteLength <= addressStart) return null;
        return addressStart + 1 + data[addressStart];
    }
    return -1;
}

function requiredTrojanBytes(data) {
    if (data.byteLength < 58) return null;
    if (data[56] !== 0x0d || data[57] !== 0x0a) return -1;
    if (data.byteLength < 60) return null;
    if (data[58] !== 1 && data[58] !== 3) return -1;

    const addressType = data[59];
    let cursor = 60;
    if (addressType === 1) cursor += 4;
    else if (addressType === 4) cursor += 16;
    else if (addressType === 3) {
        if (data.byteLength <= cursor) return null;
        cursor += 1 + data[cursor];
    } else return -1;
    return cursor + 4;
}

export function tryParseTunnelHandshake(data, credential) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const vlessRequired = requiredVlessBytes(bytes);
    if (vlessRequired !== -1 && vlessRequired !== null && bytes.byteLength >= vlessRequired) {
        const parsed = parseVlessRequest(bytes, credential);
        if (!parsed.hasError) {
            return {
                status: 'ok',
                protocol: 'vless',
                hostname: parsed.hostname,
                port: parsed.port,
                isUDP: parsed.isUDP,
                rawData: bytes.slice(parsed.rawIndex),
                responseHeader: new Uint8Array([parsed.version[0], 0]),
            };
        }
    }

    const trojanRequired = requiredTrojanBytes(bytes);
    if (trojanRequired !== -1 && trojanRequired !== null && bytes.byteLength >= trojanRequired) {
        const parsed = parseTrojanRequest(bytes, credential);
        if (!parsed.hasError) {
            return {
                status: 'ok',
                protocol: 'trojan',
                hostname: parsed.hostname,
                port: parsed.port,
                isUDP: parsed.isUDP,
                rawData: new Uint8Array(parsed.rawClientData),
                responseHeader: null,
            };
        }
    }

    if (vlessRequired === -1 && trojanRequired === -1) return { status: 'invalid' };
    return { status: 'need-more' };
}

export async function readTunnelHandshake(reader, credential, maxBytes = MAX_HANDSHAKE_BYTES) {
    let buffered = new Uint8Array(0);
    while (buffered.byteLength <= maxBytes) {
        const parsed = tryParseTunnelHandshake(buffered, credential);
        if (parsed.status === 'ok') return parsed;
        if (parsed.status === 'invalid') throw new Error('Invalid tunnel handshake');

        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        if (buffered.byteLength + chunk.byteLength > maxBytes) {
            throw new Error('Tunnel handshake is too large');
        }
        buffered = concatBytes(buffered, chunk);
    }
    throw new Error('Incomplete tunnel handshake');
}
