import { forwardDataTCP, forwardDataUDP } from './proxy.js';
import { buildLocal204Response, isSpeedTestSite } from './speedtest.js';
import { GrpcFrameDecoder, encodeGrpcHunk } from '../protocols/grpc.js';
import { readTunnelHandshake } from '../protocols/handshake.js';
import {
    frameTcpDnsQuery,
    TrojanDnsResponseFramer,
    TrojanUdpDecoder,
} from '../protocols/trojan-udp.js';

const OPEN = 1;
const CLOSED = 3;

function createGrpcPayloadReader(bodyReader) {
    const decoder = new GrpcFrameDecoder();
    const queue = [];
    let done = false;
    return {
        async read() {
            while (!queue.length && !done) {
                const result = await bodyReader.read();
                done = result.done;
                if (!done && result.value?.byteLength) queue.push(...decoder.push(result.value));
            }
            if (queue.length) return { done: false, value: queue.shift() };
            if (decoder.buffer.byteLength) throw new Error('Incomplete gRPC frame');
            return { done: true, value: undefined };
        },
        releaseLock() {
            try { bodyReader.releaseLock(); } catch { }
        },
    };
}

function createResponseBridge(controller, encode) {
    let state = OPEN;
    return {
        get readyState() { return state; },
        async send(data) {
            if (state !== OPEN) return;
            const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
            controller.enqueue(encode ? encode(chunk) : chunk);
        },
        close() {
            if (state === CLOSED) return;
            state = CLOSED;
            try { controller.close(); } catch { }
        },
        error(error) {
            if (state === CLOSED) return;
            state = CLOSED;
            try { controller.error(error); } catch { }
        },
    };
}

async function handleHttpTunnel(request, credential, proxyConfig, grpc) {
    if (!request.body) return new Response('Request body is required', { status: 400 });
    const bodyReader = request.body.getReader();
    const reader = grpc ? createGrpcPayloadReader(bodyReader) : bodyReader;
    let handshake;
    try {
        handshake = await readTunnelHandshake(reader, credential);
    } catch (error) {
        try { reader.releaseLock(); } catch { }
        return new Response(error.message, { status: 400 });
    }

    if (isSpeedTestSite(handshake.hostname, proxyConfig.speedTestDomains)) {
        try { reader.releaseLock(); } catch { }
        if (proxyConfig.speedTestMode === 'block' || handshake.isUDP) {
            return new Response('Connectivity test is blocked', { status: 403 });
        }
        const payload = buildLocal204Response(handshake.responseHeader);
        return new Response(grpc ? encodeGrpcHunk(payload) : payload, {
            headers: {
                'Content-Type': grpc ? 'application/grpc' : 'application/octet-stream',
                'Cache-Control': 'no-store',
                ...(grpc ? { 'grpc-status': '0' } : {}),
            },
        });
    }

    if (handshake.isUDP && (handshake.port !== 53 || !proxyConfig.dnsResolver)) {
        try { reader.releaseLock(); } catch { }
        return new Response('Only configured DNS forwarding is supported over this transport', { status: 400 });
    }

    const remote = { socket: null };
    let bridge;
    const response = new ReadableStream({
        async start(controller) {
            bridge = createResponseBridge(controller, grpc ? encodeGrpcHunk : null);
            try {
                let responseHeader = handshake.responseHeader;
                const trojanUdpDecoder = handshake.protocol === 'trojan' && handshake.isUDP
                    ? new TrojanUdpDecoder()
                    : null;
                const forwardUdp = async (data) => {
                    if (!trojanUdpDecoder) {
                        await forwardDataUDP(data, bridge, responseHeader, proxyConfig.dnsResolver);
                        responseHeader = null;
                        return;
                    }
                    for (const packet of trojanUdpDecoder.push(data)) {
                        if (packet.port !== 53) throw new Error('Only Trojan DNS UDP is supported');
                        const framer = new TrojanDnsResponseFramer(packet.addressHeader);
                        const dnsBridge = {
                            get readyState() { return bridge.readyState; },
                            async send(chunk) {
                                for (const frame of framer.push(chunk)) await bridge.send(frame);
                            },
                            close() { },
                        };
                        await forwardDataUDP(
                            frameTcpDnsQuery(packet.payload),
                            dnsBridge,
                            null,
                            proxyConfig.dnsResolver
                        );
                    }
                };
                if (grpc && responseHeader) {
                    await bridge.send(responseHeader);
                    responseHeader = null;
                }
                if (handshake.isUDP) {
                    if (handshake.rawData.byteLength) {
                        await forwardUdp(handshake.rawData);
                    }
                } else {
                    await forwardDataTCP(
                        handshake.hostname,
                        handshake.port,
                        handshake.rawData,
                        bridge,
                        responseHeader,
                        remote,
                        credential,
                        proxyConfig
                    );
                }

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value?.byteLength) continue;
                    if (handshake.isUDP) {
                        await forwardUdp(value);
                    } else {
                        const writer = remote.socket?.writable.getWriter();
                        if (!writer) throw new Error('Remote socket is unavailable');
                        try { await writer.write(value); }
                        finally { writer.releaseLock(); }
                    }
                }

                if (handshake.isUDP) bridge.close();
                else if (remote.socket) {
                    const writer = remote.socket.writable.getWriter();
                    try { await writer.close(); }
                    catch { }
                    finally { try { writer.releaseLock(); } catch { } }
                }
            } catch (error) {
                try { remote.socket?.close(); } catch { }
                bridge.error(error);
            } finally {
                try { reader.releaseLock(); } catch { }
            }
        },
        cancel() {
            try { remote.socket?.close(); } catch { }
            try { reader.releaseLock(); } catch { }
        },
    });

    return new Response(response, {
        status: 200,
        headers: {
            'Content-Type': grpc ? 'application/grpc' : 'application/octet-stream',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
            ...(grpc ? { 'grpc-status': '0' } : {}),
        },
    });
}

export function handleXHttpRequest(request, credential, proxyConfig) {
    return handleHttpTunnel(request, credential, proxyConfig, false);
}

export function handleGrpcRequest(request, credential, proxyConfig) {
    return handleHttpTunnel(request, credential, proxyConfig, true);
}
