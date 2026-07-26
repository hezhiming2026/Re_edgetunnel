import { connect } from 'cloudflare:sockets';
import { resolveIPv4 } from './dns.js';

const TIMEOUT_MS = 10_000;
const TCP_MSS = 1400;
const EMPTY = new Uint8Array(0);
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

async function withTimeout(promise, message, timeoutMs = TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function uint16(bytes, offset = 0) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint32(bytes, offset = 0) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function randomUint16() {
    return uint16(crypto.getRandomValues(new Uint8Array(2)));
}

function checksum(bytes, offset, length) {
    let sum = 0;
    for (let index = offset; index < offset + length - 1; index += 2) {
        sum += uint16(bytes, index);
    }
    if (length & 1) sum += bytes[offset + length - 1] << 8;
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return (~sum) & 0xffff;
}

function buildDataPacket(pppFrame) {
    const length = 6 + pppFrame.byteLength;
    const packet = new Uint8Array(length);
    packet.set([0x10, 0x00, ((length >> 8) & 0x0f) | 0x80, length & 0xff, 0xff, 0x03]);
    packet.set(pppFrame, 6);
    return packet;
}

function buildPppConfigure(protocol, code, id, options = []) {
    const optionsLength = options.reduce((sum, option) => sum + 2 + option.data.byteLength, 0);
    const frame = new Uint8Array(6 + optionsLength);
    const view = new DataView(frame.buffer);
    view.setUint16(0, protocol);
    frame[2] = code;
    frame[3] = id;
    view.setUint16(4, 4 + optionsLength);
    let offset = 6;
    for (const option of options) {
        frame[offset] = option.type;
        frame[offset + 1] = option.data.byteLength + 2;
        frame.set(option.data, offset + 2);
        offset += option.data.byteLength + 2;
    }
    return frame;
}

function parsePppFrame(data) {
    const offset = data.byteLength >= 2 && data[0] === 0xff && data[1] === 0x03 ? 2 : 0;
    if (data.byteLength - offset < 4) return null;
    const protocol = uint16(data, offset);
    if (protocol === 0x0021) return { protocol, ipPacket: data.subarray(offset + 2) };
    if (data.byteLength - offset < 6) return null;
    return {
        protocol,
        code: data[offset + 2],
        id: data[offset + 3],
        payload: data.subarray(offset + 6),
        rawPacket: data.subarray(offset),
    };
}

function parsePppOptions(data) {
    const options = [];
    for (let offset = 0; offset + 2 <= data.byteLength;) {
        const type = data[offset];
        const length = data[offset + 1];
        if (length < 2 || offset + length > data.byteLength) break;
        options.push({ type, data: data.subarray(offset + 2, offset + length) });
        offset += length;
    }
    return options;
}

export async function sstpConnect(proxy, targetHost, targetPort, dnsResolver) {
    let buffered = EMPTY;
    let pppIdentifier = 1;
    let socket;
    let reader;
    let writer;
    let closedSettled = false;
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    const settleClosed = (callback, value) => {
        if (closedSettled) return;
        closedSettled = true;
        callback(value);
    };
    const close = () => {
        try { reader?.cancel(); } catch { }
        try { reader?.releaseLock(); } catch { }
        try { writer?.releaseLock(); } catch { }
        try { socket?.close(); } catch { }
        settleClosed(resolveClosed);
    };

    const readSocketChunk = async () => {
        const { value, done } = await reader.read();
        if (done || !value) throw new Error('SSTP socket closed');
        return new Uint8Array(value);
    };
    const readBytes = async (length) => {
        while (buffered.byteLength < length) {
            buffered = concatBytes(buffered, await readSocketChunk());
        }
        const result = buffered.subarray(0, length);
        buffered = buffered.subarray(length);
        return result;
    };
    const readHttpLine = async () => {
        while (true) {
            const lineEnd = buffered.indexOf(10);
            if (lineEnd >= 0) {
                const line = textDecoder.decode(buffered.subarray(0, lineEnd));
                buffered = buffered.subarray(lineEnd + 1);
                return line.replace(/\r$/, '');
            }
            buffered = concatBytes(buffered, await readSocketChunk());
            if (buffered.byteLength > 16 * 1024) throw new Error('SSTP HTTP headers are too large');
        }
    };
    const readPacket = async (timeoutMs = TIMEOUT_MS) => {
        const header = await withTimeout(readBytes(4), 'SSTP read timed out', timeoutMs);
        const length = uint16(header, 2) & 0x0fff;
        if (length < 4 || length > 4095) throw new Error('Invalid SSTP packet length');
        return {
            isControl: (header[1] & 1) !== 0,
            body: length > 4
                ? await withTimeout(readBytes(length - 4), 'SSTP packet body timed out', timeoutMs)
                : EMPTY,
        };
    };

    try {
        socket = connect(
            { hostname: proxy.hostname, port: proxy.port },
            { secureTransport: 'on', allowHalfOpen: true }
        );
        await withTimeout(socket.opened, 'SSTP server connection timed out');
        reader = socket.readable.getReader();
        writer = socket.writable.getWriter();

        const displayHost = proxy.hostname.includes(':') ? `[${proxy.hostname}]` : proxy.hostname;
        const httpRequest = textEncoder.encode(
            'SSTP_DUPLEX_POST /sra_{BA195980-CD49-458b-9E23-C84EE0ADCD75}/ HTTP/1.1\r\n' +
            `Host: ${proxy.port === 443 ? displayHost : `${displayHost}:${proxy.port}`}\r\n` +
            'Content-Length: 18446744073709551615\r\n' +
            `SSTPCORRELATIONID: {${crypto.randomUUID()}}\r\n\r\n`
        );
        const encapsulatedProtocol = new Uint8Array([0, 1]);
        const connectRequest = new Uint8Array(14);
        const connectView = new DataView(connectRequest.buffer);
        connectRequest[0] = 0x10;
        connectRequest[1] = 0x01;
        connectView.setUint16(2, connectRequest.byteLength | 0x8000);
        connectView.setUint16(4, 0x0001);
        connectView.setUint16(6, 1);
        connectRequest[9] = 1;
        connectView.setUint16(10, 6);
        connectRequest.set(encapsulatedProtocol, 12);
        const mru = new Uint8Array([0x05, 0xdc]);
        const lcpRequest = buildDataPacket(buildPppConfigure(
            0xc021,
            1,
            pppIdentifier++,
            [{ type: 1, data: mru }]
        ));
        await withTimeout(
            writer.write(concatBytes(httpRequest, connectRequest, lcpRequest)),
            'SSTP HTTP handshake write timed out'
        );

        const statusLine = await withTimeout(readHttpLine(), 'SSTP HTTP handshake timed out');
        while (await withTimeout(readHttpLine(), 'SSTP HTTP header read timed out')) { }
        if (!/^HTTP\/\d(?:\.\d)?\s+2\d\d\b/i.test(statusLine)) {
            throw new Error(`SSTP HTTP handshake failed: ${statusLine || 'invalid status'}`);
        }

        let localLcpAcked = false;
        let peerLcpAcked = false;
        let papRequired = false;
        let papSent = false;
        let papDone = false;
        let ipcpStarted = false;
        let ipcpFinished = false;
        let sourceIp = null;

        const sendPapIfReady = async () => {
            if (!localLcpAcked || !peerLcpAcked || !papRequired || papSent) return;
            if (!proxy.username || !proxy.password) throw new Error('SSTP server requires PAP credentials');
            const username = textEncoder.encode(proxy.username);
            const password = textEncoder.encode(proxy.password);
            if (username.byteLength > 255 || password.byteLength > 255) {
                throw new Error('SSTP credentials are too long');
            }
            const papLength = 6 + username.byteLength + password.byteLength;
            const frame = new Uint8Array(2 + papLength);
            const view = new DataView(frame.buffer);
            view.setUint16(0, 0xc023);
            frame[2] = 1;
            frame[3] = pppIdentifier++;
            view.setUint16(4, papLength);
            frame[6] = username.byteLength;
            frame.set(username, 7);
            frame[7 + username.byteLength] = password.byteLength;
            frame.set(password, 8 + username.byteLength);
            await withTimeout(writer.write(buildDataPacket(frame)), 'SSTP PAP write timed out');
            papSent = true;
        };
        const startIpcpIfReady = async () => {
            if (!localLcpAcked || !peerLcpAcked || ipcpStarted || (papRequired && !papDone)) return;
            await withTimeout(writer.write(buildDataPacket(buildPppConfigure(
                0x8021,
                1,
                pppIdentifier++,
                [{ type: 3, data: new Uint8Array(4) }]
            ))), 'SSTP IPCP write timed out');
            ipcpStarted = true;
        };

        for (let round = 0; round < 50 && !ipcpFinished; round++) {
            const packet = await readPacket();
            if (packet.isControl) continue;
            const ppp = parsePppFrame(packet.body);
            if (!ppp) continue;
            if (ppp.protocol === 0xc021) {
                if (ppp.code === 1) {
                    const auth = parsePppOptions(ppp.payload).find((option) => option.type === 3);
                    if (auth?.data?.byteLength >= 2) {
                        const protocol = uint16(auth.data);
                        if (protocol !== 0xc023) {
                            throw new Error(`Unsupported SSTP authentication protocol: 0x${protocol.toString(16)}`);
                        }
                        papRequired = true;
                    }
                    const ack = new Uint8Array(ppp.rawPacket);
                    ack[2] = 2;
                    await withTimeout(writer.write(buildDataPacket(ack)), 'SSTP LCP acknowledgement timed out');
                    peerLcpAcked = true;
                    await sendPapIfReady();
                    await startIpcpIfReady();
                } else if (ppp.code === 2) {
                    localLcpAcked = true;
                    await sendPapIfReady();
                    await startIpcpIfReady();
                }
            } else if (ppp.protocol === 0xc023) {
                if (ppp.code === 2) {
                    papDone = true;
                    await startIpcpIfReady();
                } else if (ppp.code === 3) {
                    throw new Error('SSTP PAP authentication failed');
                }
            } else if (ppp.protocol === 0x8021) {
                if (ppp.code === 1) {
                    const ack = new Uint8Array(ppp.rawPacket);
                    ack[2] = 2;
                    await withTimeout(writer.write(buildDataPacket(ack)), 'SSTP IPCP acknowledgement timed out');
                    await startIpcpIfReady();
                } else if (ppp.code === 3) {
                    const address = parsePppOptions(ppp.payload).find((option) => option.type === 3);
                    if (address?.data?.byteLength === 4) {
                        sourceIp = [...address.data].join('.');
                        await withTimeout(writer.write(buildDataPacket(buildPppConfigure(
                            0x8021,
                            1,
                            pppIdentifier++,
                            [{ type: 3, data: address.data }]
                        ))), 'SSTP IPCP address write timed out');
                    }
                } else if (ppp.code === 2) {
                    const address = parsePppOptions(ppp.payload).find((option) => option.type === 3);
                    if (address?.data?.byteLength === 4) sourceIp = [...address.data].join('.');
                    ipcpFinished = true;
                }
            }
        }
        if (!sourceIp) throw new Error('SSTP did not assign an IPv4 address');

        const targetIp = await resolveIPv4(targetHost, dnsResolver);
        const sourcePort = 10_000 + (randomUint16() % 50_000);
        const sourceAddress = new Uint8Array(sourceIp.split('.').map(Number));
        const destinationAddress = new Uint8Array(targetIp.split('.').map(Number));
        let sequence = uint32(crypto.getRandomValues(new Uint8Array(4)));
        let acknowledgement = 0;
        const ipTemplate = new Uint8Array(20);
        ipTemplate.set([0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, 6]);
        ipTemplate.set(sourceAddress, 12);
        ipTemplate.set(destinationAddress, 16);

        const buildTcpFrame = (flags, payload = EMPTY) => {
            const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
            const tcpLength = 20 + bytes.byteLength;
            const ipLength = 20 + tcpLength;
            const sstpLength = 8 + ipLength;
            const frame = new Uint8Array(sstpLength);
            const view = new DataView(frame.buffer);
            frame.set([0x10, 0, ((sstpLength >> 8) & 0x0f) | 0x80, sstpLength & 0xff, 0xff, 0x03, 0, 0x21]);
            frame.set(ipTemplate, 8);
            view.setUint16(10, ipLength);
            view.setUint16(12, randomUint16());
            view.setUint16(18, checksum(frame, 8, 20));
            view.setUint16(28, sourcePort);
            view.setUint16(30, targetPort);
            view.setUint32(32, sequence);
            view.setUint32(36, acknowledgement);
            frame[40] = 0x50;
            frame[41] = flags;
            view.setUint16(42, 65_535);
            if (bytes.byteLength) frame.set(bytes, 48);

            const pseudo = new Uint8Array(12 + tcpLength);
            pseudo.set(sourceAddress);
            pseudo.set(destinationAddress, 4);
            pseudo[9] = 6;
            pseudo[10] = tcpLength >> 8;
            pseudo[11] = tcpLength & 0xff;
            pseudo.set(frame.subarray(28, 28 + tcpLength), 12);
            view.setUint16(44, checksum(pseudo, 0, pseudo.byteLength));
            return frame;
        };
        const matchTcpPacket = (ipPacket) => {
            if (ipPacket.byteLength < 40 || ipPacket[9] !== 6) return null;
            const ipHeaderLength = (ipPacket[0] & 0x0f) * 4;
            if (ipPacket.byteLength < ipHeaderLength + 20) return null;
            if (uint16(ipPacket, ipHeaderLength) !== targetPort ||
                uint16(ipPacket, ipHeaderLength + 2) !== sourcePort) return null;
            return {
                flags: ipPacket[ipHeaderLength + 13],
                sequence: uint32(ipPacket, ipHeaderLength + 4),
                payloadOffset: ipHeaderLength + ((ipPacket[ipHeaderLength + 12] >> 4) & 0x0f) * 4,
            };
        };

        await withTimeout(writer.write(buildTcpFrame(0x02)), 'SSTP inner TCP SYN timed out');
        sequence = (sequence + 1) >>> 0;
        let tcpReady = false;
        for (let attempt = 0; attempt < 30; attempt++) {
            const packet = await readPacket();
            if (packet.isControl) continue;
            const ppp = parsePppFrame(packet.body);
            if (!ppp || ppp.protocol !== 0x0021) continue;
            const incoming = matchTcpPacket(ppp.ipPacket);
            if (!incoming || (incoming.flags & 0x12) !== 0x12) continue;
            acknowledgement = (incoming.sequence + 1) >>> 0;
            await withTimeout(writer.write(buildTcpFrame(0x10)), 'SSTP inner TCP ACK timed out');
            tcpReady = true;
            break;
        }
        if (!tcpReady) throw new Error('SSTP inner TCP handshake timed out');

        let streamController;
        const readable = new ReadableStream({
            start(controller) { streamController = controller; },
            cancel() { close(); },
        });

        void (async () => {
            try {
                while (true) {
                    const packet = await readPacket(60_000);
                    if (packet.isControl) continue;
                    const ppp = parsePppFrame(packet.body);
                    if (!ppp || ppp.protocol !== 0x0021) continue;
                    const incoming = matchTcpPacket(ppp.ipPacket);
                    if (!incoming) continue;
                    if (incoming.payloadOffset < ppp.ipPacket.byteLength) {
                        const payload = ppp.ipPacket.subarray(incoming.payloadOffset);
                        if (payload.byteLength) {
                            acknowledgement = (incoming.sequence + payload.byteLength) >>> 0;
                            streamController.enqueue(new Uint8Array(payload));
                            await writer.write(buildTcpFrame(0x10));
                        }
                    }
                    if (incoming.flags & 0x01) {
                        acknowledgement = (acknowledgement + 1) >>> 0;
                        await writer.write(buildTcpFrame(0x11));
                        streamController.close();
                        close();
                        return;
                    }
                }
            } catch (error) {
                try { streamController.error(error); } catch { }
                settleClosed(rejectClosed, error);
                try { socket?.close(); } catch { }
            }
        })();

        const writable = new WritableStream({
            async write(chunk) {
                const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                for (let offset = 0; offset < bytes.byteLength; offset += TCP_MSS) {
                    const segment = bytes.subarray(offset, Math.min(offset + TCP_MSS, bytes.byteLength));
                    await writer.write(buildTcpFrame(0x18, segment));
                    sequence = (sequence + segment.byteLength) >>> 0;
                }
            },
            async close() {
                try { await writer.write(buildTcpFrame(0x11)); } catch { }
            },
            abort(error) {
                close();
                if (error) settleClosed(rejectClosed, error);
            },
        });
        return {
            readable,
            writable,
            opened: Promise.resolve({}),
            closed,
            close,
        };
    } catch (error) {
        close();
        throw error;
    }
}
