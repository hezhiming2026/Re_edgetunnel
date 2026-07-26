const CIPHERS = Object.freeze({
    'aes-128-gcm': { method: 'aes-128-gcm', keyLength: 16, saltLength: 16, aesLength: 128 },
    'aes-256-gcm': { method: 'aes-256-gcm', keyLength: 32, saltLength: 32, aesLength: 256 },
});

const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const MAX_CHUNK_BYTES = 0x3fff;
const MAX_BUFFER_BYTES = 128 * 1024;
const SUBKEY_INFO = new TextEncoder().encode('ss-subkey');
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

export function md5Digest(input) {
    const paddedLength = (input.byteLength + 9 + 63) & ~63;
    const bytes = new Uint8Array(paddedLength);
    bytes.set(input);
    bytes[input.byteLength] = 0x80;
    const view = new DataView(bytes.buffer);
    const bitLength = input.byteLength * 8;
    view.setUint32(paddedLength - 8, bitLength >>> 0, true);
    view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x1_0000_0000), true);

    const shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0);
    const rotateLeft = (value, amount) => ((value << amount) | (value >>> (32 - amount))) >>> 0;
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    for (let offset = 0; offset < paddedLength; offset += 64) {
        const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true));
        let a = a0, b = b0, c = c0, d = d0;
        for (let index = 0; index < 64; index++) {
            let f, g;
            if (index < 16) { f = (b & c) | (~b & d); g = index; }
            else if (index < 32) { f = (d & b) | (~d & c); g = (5 * index + 1) % 16; }
            else if (index < 48) { f = b ^ c ^ d; g = (3 * index + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * index) % 16; }
            const next = d;
            d = c;
            c = b;
            b = (b + rotateLeft((a + f + constants[index] + words[g]) >>> 0, shifts[index])) >>> 0;
            a = next;
        }
        a0 = (a0 + a) >>> 0;
        b0 = (b0 + b) >>> 0;
        c0 = (c0 + c) >>> 0;
        d0 = (d0 + d) >>> 0;
    }

    const digest = new Uint8Array(16);
    const digestView = new DataView(digest.buffer);
    [a0, b0, c0, d0].forEach((value, index) => digestView.setUint32(index * 4, value, true));
    return digest;
}

function deriveMasterKey(password, keyLength) {
    const passwordBytes = textEncoder.encode(password);
    let previous = new Uint8Array(0);
    let result = new Uint8Array(0);
    while (result.byteLength < keyLength) {
        previous = md5Digest(concatBytes(previous, passwordBytes));
        result = concatBytes(result, previous);
    }
    return result.slice(0, keyLength);
}

async function deriveSessionKey(config, masterKey, salt, usage) {
    const hmac = { name: 'HMAC', hash: 'SHA-1' };
    const saltKey = await crypto.subtle.importKey('raw', salt, hmac, false, ['sign']);
    const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, masterKey));
    const prkKey = await crypto.subtle.importKey('raw', prk, hmac, false, ['sign']);
    const subkey = new Uint8Array(config.keyLength);
    let previous = new Uint8Array(0);
    let written = 0;
    for (let counter = 1; written < subkey.byteLength; counter++) {
        previous = new Uint8Array(await crypto.subtle.sign(
            'HMAC',
            prkKey,
            concatBytes(previous, SUBKEY_INFO, new Uint8Array([counter]))
        ));
        const count = Math.min(previous.byteLength, subkey.byteLength - written);
        subkey.set(previous.subarray(0, count), written);
        written += count;
    }
    return crypto.subtle.importKey(
        'raw',
        subkey,
        { name: 'AES-GCM', length: config.aesLength },
        false,
        [usage]
    );
}

function incrementNonce(nonce) {
    for (let index = 0; index < nonce.byteLength; index++) {
        nonce[index] = (nonce[index] + 1) & 0xff;
        if (nonce[index] !== 0) return;
    }
}

async function encryptAead(key, nonce, plaintext) {
    const result = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce.slice(), tagLength: 128 },
        key,
        plaintext
    ));
    incrementNonce(nonce);
    return result;
}

async function decryptAead(key, nonce, ciphertext) {
    const result = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce.slice(), tagLength: 128 },
        key,
        ciphertext
    ));
    incrementNonce(nonce);
    return result;
}

export function getShadowsocksCipher(method) {
    const normalized = String(method ?? '').toLowerCase();
    const config = CIPHERS[normalized];
    if (!config) throw new Error(`Unsupported Shadowsocks cipher: ${normalized || '(empty)'}`);
    return config;
}

export class ShadowsocksAeadDecoder {
    constructor(method, password) {
        this.config = getShadowsocksCipher(method);
        this.masterKey = deriveMasterKey(password, this.config.keyLength);
        this.buffer = new Uint8Array(0);
        this.key = null;
        this.nonce = new Uint8Array(NONCE_LENGTH);
        this.payloadLength = null;
    }

    async push(data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (this.buffer.byteLength + chunk.byteLength > MAX_BUFFER_BYTES) {
            throw new Error('Shadowsocks receive buffer is too large');
        }
        this.buffer = concatBytes(this.buffer, chunk);

        if (!this.key) {
            if (this.buffer.byteLength < this.config.saltLength) return [];
            const salt = this.buffer.slice(0, this.config.saltLength);
            this.buffer = this.buffer.slice(this.config.saltLength);
            this.key = await deriveSessionKey(this.config, this.masterKey, salt, 'decrypt');
        }

        const plaintext = [];
        while (true) {
            if (this.payloadLength === null) {
                if (this.buffer.byteLength < 2 + TAG_LENGTH) break;
                const length = await decryptAead(this.key, this.nonce, this.buffer.slice(0, 2 + TAG_LENGTH));
                this.buffer = this.buffer.slice(2 + TAG_LENGTH);
                this.payloadLength = (length[0] << 8) | length[1];
                if (this.payloadLength > MAX_CHUNK_BYTES) throw new Error('Invalid Shadowsocks payload length');
            }
            if (this.buffer.byteLength < this.payloadLength + TAG_LENGTH) break;
            plaintext.push(await decryptAead(
                this.key,
                this.nonce,
                this.buffer.slice(0, this.payloadLength + TAG_LENGTH)
            ));
            this.buffer = this.buffer.slice(this.payloadLength + TAG_LENGTH);
            this.payloadLength = null;
        }
        return plaintext;
    }
}

export class ShadowsocksAeadEncoder {
    constructor(method, password) {
        this.config = getShadowsocksCipher(method);
        this.masterKey = deriveMasterKey(password, this.config.keyLength);
        this.key = null;
        this.nonce = new Uint8Array(NONCE_LENGTH);
        this.salt = null;
    }

    async encode(data) {
        const plaintext = data instanceof Uint8Array ? data : new Uint8Array(data);
        const frames = [];
        if (!this.key) {
            this.salt = crypto.getRandomValues(new Uint8Array(this.config.saltLength));
            this.key = await deriveSessionKey(this.config, this.masterKey, this.salt, 'encrypt');
            frames.push(this.salt);
        }
        for (let offset = 0; offset < plaintext.byteLength || (plaintext.byteLength === 0 && offset === 0); offset += MAX_CHUNK_BYTES) {
            const payload = plaintext.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, plaintext.byteLength));
            if (!payload.byteLength) break;
            const length = new Uint8Array([payload.byteLength >> 8, payload.byteLength & 0xff]);
            frames.push(await encryptAead(this.key, this.nonce, length));
            frames.push(await encryptAead(this.key, this.nonce, payload));
        }
        return concatBytes(...frames);
    }
}

export function tryParseShadowsocksTarget(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength < 1) return { status: 'need-more' };
    const addressType = bytes[0];
    let cursor = 1;
    let hostname;
    if (addressType === 1) {
        if (bytes.byteLength < cursor + 4 + 2) return { status: 'need-more' };
        hostname = [...bytes.subarray(cursor, cursor + 4)].join('.');
        cursor += 4;
    } else if (addressType === 3) {
        if (bytes.byteLength < cursor + 1) return { status: 'need-more' };
        const length = bytes[cursor++];
        if (bytes.byteLength < cursor + length + 2) return { status: 'need-more' };
        hostname = textDecoder.decode(bytes.subarray(cursor, cursor + length));
        cursor += length;
    } else if (addressType === 4) {
        if (bytes.byteLength < cursor + 16 + 2) return { status: 'need-more' };
        const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 16);
        hostname = Array.from({ length: 8 }, (_, index) => view.getUint16(index * 2).toString(16)).join(':');
        cursor += 16;
    } else {
        return { status: 'invalid' };
    }
    const port = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (!port) return { status: 'invalid' };
    cursor += 2;
    return { status: 'ok', hostname, port, rawData: bytes.slice(cursor) };
}
