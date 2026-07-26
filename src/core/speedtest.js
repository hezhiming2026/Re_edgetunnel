const DEFAULT_SPEED_TEST_DOMAINS = Object.freeze([
    'speed.cloudflare.com',
    'cp.cloudflare.com',
]);

const HEADER_END = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function findSequence(data, sequence) {
    outer:
    for (let i = 0; i <= data.byteLength - sequence.byteLength; i++) {
        for (let j = 0; j < sequence.byteLength; j++) {
            if (data[i + j] !== sequence[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function concatBytes(left, right) {
    if (!left.byteLength) return right.slice();
    if (!right.byteLength) return left;
    const joined = new Uint8Array(left.byteLength + right.byteLength);
    joined.set(left);
    joined.set(right, left.byteLength);
    return joined;
}

function normalizeHostname(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function parseSpeedTestDomains(value) {
    if (value == null || String(value).trim() === '') return [...DEFAULT_SPEED_TEST_DOMAINS];

    const domains = String(value)
        .split(/[\s,]+/)
        .map(normalizeHostname)
        .filter((domain) =>
            domain.length > 0 &&
            domain.length <= 253 &&
            /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
        );

    return [...new Set(domains)].slice(0, 16);
}

export function parseSpeedTestMode(value) {
    return String(value ?? 'local').trim().toLowerCase() === 'block' ? 'block' : 'local';
}

export function isSpeedTestSite(hostname, domains = DEFAULT_SPEED_TEST_DOMAINS) {
    const normalized = normalizeHostname(hostname);
    return domains.some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

export function buildLocal204Response(protocolHeader = null) {
    const response = textEncoder.encode(
        'HTTP/1.1 204 No Content\r\n' +
        'Content-Length: 0\r\n' +
        'Connection: keep-alive\r\n' +
        'Cache-Control: no-store\r\n' +
        '\r\n'
    );
    if (!protocolHeader?.byteLength) return response;

    const header = protocolHeader instanceof Uint8Array
        ? protocolHeader
        : new Uint8Array(protocolHeader);
    const framed = new Uint8Array(header.byteLength + response.byteLength);
    framed.set(header);
    framed.set(response, header.byteLength);
    return framed;
}

export class LocalSpeedTestSession {
    constructor(send, protocolHeader = null, options = {}) {
        this.send = send;
        this.protocolHeader = protocolHeader;
        this.buffer = new Uint8Array(0);
        this.maxHeaderBytes = options.maxHeaderBytes ?? 8192;
        this.maxRequestBytes = options.maxRequestBytes ?? 64 * 1024;
        this.maxRequestsPerPush = options.maxRequestsPerPush ?? 8;
    }

    async push(data) {
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (!chunk.byteLength) return 0;
        if (this.buffer.byteLength + chunk.byteLength > this.maxRequestBytes) {
            throw new Error('Local speed-test request exceeds the buffer limit');
        }
        this.buffer = concatBytes(this.buffer, chunk);

        let handled = 0;
        while (this.buffer.byteLength) {
            const headerStart = findSequence(this.buffer, HEADER_END);
            if (headerStart < 0) {
                if (this.buffer.byteLength > this.maxHeaderBytes) {
                    throw new Error('Local speed-test headers are too large');
                }
                return handled;
            }

            const headerEnd = headerStart + HEADER_END.byteLength;
            if (headerEnd > this.maxHeaderBytes) {
                throw new Error('Local speed-test headers are too large');
            }
            const headerText = textDecoder.decode(this.buffer.subarray(0, headerEnd));
            if (/(?:^|\r\n)transfer-encoding\s*:/i.test(headerText)) {
                throw new Error('Chunked local speed-test requests are not supported');
            }
            const lengthMatch = headerText.match(/(?:^|\r\n)content-length\s*:\s*(\d+)\s*(?:\r\n|$)/i);
            const contentLength = lengthMatch ? Number(lengthMatch[1]) : 0;
            const requestLength = headerEnd + contentLength;
            if (!Number.isSafeInteger(contentLength) || requestLength > this.maxRequestBytes) {
                throw new Error('Local speed-test request body is too large');
            }
            if (this.buffer.byteLength < requestLength) return handled;
            if (++handled > this.maxRequestsPerPush) {
                throw new Error('Too many pipelined local speed-test requests');
            }

            this.buffer = this.buffer.slice(requestLength);
            const response = buildLocal204Response(this.protocolHeader);
            this.protocolHeader = null;
            await this.send(response);
        }
        return handled;
    }
}
