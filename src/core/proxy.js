
import { connect } from "cloudflare:sockets";
import { socks5Connect, httpConnect } from "../protocols/socks5.js";
import { base64ToArray, getSocks5Account, isSafeConnectTarget } from "../utils/helpers.js";
import { parseProxyAddress } from "../utils/ip.js";
import { parseConcurrentDialCount, raceSocketCandidates } from "./dialer.js";
import { isSpeedTestSite, LocalSpeedTestSession } from "./speedtest.js";
import {
    ShadowsocksAeadDecoder,
    ShadowsocksAeadEncoder,
    tryParseShadowsocksTarget,
} from "../protocols/shadowsocks.js";
import { turnConnect } from "../protocols/turn.js";
import { sstpConnect } from "../protocols/sstp.js";
import {
    frameTcpDnsQuery,
    TrojanDnsResponseFramer,
    TrojanUdpDecoder,
} from "../protocols/trojan-udp.js";
import { tryParseTunnelHandshake } from "../protocols/handshake.js";

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_SESSION_MS = 60 * 60_000;
const MAX_INITIAL_REQUEST_BYTES = 8192;

async function connectWithTimeout(options) {
    const socket = connect(options);
    let timeoutId;
    try {
        await Promise.race([
            socket.opened,
            new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error('TCP connection timed out')), CONNECT_TIMEOUT_MS); }),
        ]);
        return socket;
    } catch (error) {
        try { socket.close(); } catch { }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

function closeSocketQuietly(socket) {
    try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
            socket.close();
        }
    } catch (error) { }
}

function makeReadableStr(socket, earlyDataHeader) {
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            socket.addEventListener('message', (event) => {
                if (!cancelled) controller.enqueue(event.data);
            });
            socket.addEventListener('close', () => {
                if (!cancelled) {
                    closeSocketQuietly(socket);
                    controller.close();
                }
            });
            socket.addEventListener('error', (err) => controller.error(err));
            const { earlyData, error } = base64ToArray(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            cancelled = true;
            closeSocketQuietly(socket);
        }
    });
}

export async function connectStreams(remoteSocket, webSocket, headerData, retryFunc) {
    let header = headerData, hasData = false;
    await remoteSocket.readable.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                hasData = true;
                if (webSocket.readyState !== WebSocket.OPEN) controller.error('ws.readyState is not open');
                if (header) {
                    const response = new Uint8Array(header.length + chunk.byteLength);
                    response.set(header, 0);
                    response.set(chunk, header.length);
                    await webSocket.send(response.buffer);
                    header = null;
                } else {
                    await webSocket.send(chunk);
                }
            },
            abort() { },
        })
    ).catch((err) => {
        closeSocketQuietly(webSocket);
    });
    if (!hasData && retryFunc) {
        await retryFunc();
    } else if (hasData) {
        closeSocketQuietly(webSocket);
    }
}

export async function forwardDataUDP(udpChunk, webSocket, respHeader, dnsResolver) {
    let tcpSocket;
    try {
        if (!dnsResolver || !isSafeConnectTarget(dnsResolver.hostname, dnsResolver.port)) throw new Error('DNS resolver is not configured');
        tcpSocket = await connectWithTimeout({ hostname: dnsResolver.hostname.replace(/^\[|\]$/g, ''), port: dnsResolver.port });
        let vlessHeader = respHeader;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(udpChunk);
        writer.releaseLock();
        const queryBytes = udpChunk instanceof Uint8Array ? udpChunk : new Uint8Array(udpChunk);
        let queryCursor = 0;
        let expectedResponses = 0;
        while (queryCursor + 2 <= queryBytes.byteLength) {
            const length = (queryBytes[queryCursor] << 8) | queryBytes[queryCursor + 1];
            if (queryCursor + 2 + length > queryBytes.byteLength) break;
            expectedResponses++;
            queryCursor += 2 + length;
        }
        if (!expectedResponses || queryCursor !== queryBytes.byteLength) throw new Error('Invalid TCP DNS query framing');

        const reader = tcpSocket.readable.getReader();
        let responseBuffer = new Uint8Array(0);
        let completedResponses = 0;
        try {
            while (completedResponses < expectedResponses) {
                let timeout;
                const { done, value } = await Promise.race([
                    reader.read(),
                    new Promise((_, reject) => {
                        timeout = setTimeout(() => reject(new Error('DNS response timed out')), CONNECT_TIMEOUT_MS);
                    }),
                ]).finally(() => clearTimeout(timeout));
                if (done || !value) throw new Error('DNS resolver closed before completing the response');
                const chunk = new Uint8Array(value);
                if (webSocket.readyState === WebSocket.OPEN) {
                    if (vlessHeader) {
                        const response = new Uint8Array(vlessHeader.length + chunk.byteLength);
                        response.set(vlessHeader);
                        response.set(chunk, vlessHeader.length);
                        await webSocket.send(response);
                        vlessHeader = null;
                    } else {
                        await webSocket.send(chunk);
                    }
                }
                const joined = new Uint8Array(responseBuffer.byteLength + chunk.byteLength);
                joined.set(responseBuffer);
                joined.set(chunk, responseBuffer.byteLength);
                responseBuffer = joined;
                let cursor = 0;
                while (cursor + 2 <= responseBuffer.byteLength) {
                    const length = (responseBuffer[cursor] << 8) | responseBuffer[cursor + 1];
                    if (cursor + 2 + length > responseBuffer.byteLength) break;
                    completedResponses++;
                    cursor += 2 + length;
                }
                responseBuffer = responseBuffer.slice(cursor);
            }
        } finally {
            try { reader.releaseLock(); } catch { }
        }
    } catch (error) {
        // console.error('UDP forward error:', error);
    } finally {
        try { tcpSocket?.close(); } catch { }
    }
}

export async function forwardDataTCP(host, portNum, rawData, ws, respHeader, remoteConnWrapper, yourUUID, proxyConfig) {
    // proxyConfig contains: proxyIP, enableProxyFallback, socks5 (type, account, global), whiteList
    // This is passed from the main worker to avoid global state issues.

    // unpack proxyConfig
    let {
        proxyIP,
        enableProxyFallback,
        socks5Type,
        socks5Account,
        socks5Global,
        socks5Whitelist,
        cachedProxyIndexRef, // This is an object { value: 0 } so we can update it
        tcpConcurrentDial,
        proxyConcurrentDial,
        upstreamProxy,
    } = proxyConfig;

    // Note: parsedSocks5Address should be parsed once at request level if possible, 
    // or we parse it here if needed. Ideally passed in proxyConfig if it's static for the request.
    // Assuming socks5Account is the string.

    // console.log(`[TCP转发] 目标: ${host}:${portNum} | 反代IP: ${proxyIP} | ...`);

    async function connectDirect(address, port, data, proxyList = null, useFallback = true) {
        let remoteSock;
        if (proxyList && proxyList.length > 0) {
            const concurrency = parseConcurrentDialCount(proxyConcurrentDial);
            for (let offset = 0; offset < proxyList.length; offset += concurrency) {
                const candidates = proxyList
                    .slice(offset, offset + concurrency)
                    .map((_, index) => {
                        const candidateIndex = (cachedProxyIndexRef.value + offset + index) % proxyList.length;
                        const [hostname, candidatePort] = proxyList[candidateIndex];
                        return { hostname, port: candidatePort, index: candidateIndex };
                    });
                try {
                    // console.log(`[反代连接] ...`);
                    const winner = await raceSocketCandidates(candidates, (candidate) =>
                        connectWithTimeout({ hostname: candidate.hostname, port: candidate.port })
                    );
                    remoteSock = winner.socket;
                    const testWriter = remoteSock.writable.getWriter();
                    await testWriter.write(data);
                    testWriter.releaseLock();
                    cachedProxyIndexRef.value = winner.candidate.index;
                    return remoteSock;
                } catch (err) {
                    try { remoteSock?.close?.(); } catch (e) { }
                }
            }
        }

        if (useFallback) {
            const concurrency = parseConcurrentDialCount(tcpConcurrentDial);
            const candidates = Array.from({ length: concurrency }, (_, attempt) => ({
                hostname: address,
                port,
                attempt,
            }));
            const winner = await raceSocketCandidates(candidates, (candidate) =>
                connectWithTimeout({ hostname: candidate.hostname, port: candidate.port })
            );
            remoteSock = winner.socket;
            const writer = remoteSock.writable.getWriter();
            await writer.write(data);
            writer.releaseLock();
            return remoteSock;
        } else {
            closeSocketQuietly(ws);
            throw new Error('[反代连接] All proxy connections failed and fallback is disabled.');
        }
    }

    async function connectToProxy() {
        let newSocket;
        if (upstreamProxy?.type === 'socks5') {
            newSocket = await socks5Connect(host, portNum, rawData, upstreamProxy);
        } else if (upstreamProxy?.type === 'http' || upstreamProxy?.type === 'https') {
            newSocket = await httpConnect(
                host,
                portNum,
                rawData,
                upstreamProxy,
                { tls: upstreamProxy.type === 'https' }
            );
        } else if (upstreamProxy?.type === 'turn' || upstreamProxy?.type === 'turns') {
            newSocket = await turnConnect(upstreamProxy, host, portNum, proxyConfig.dnsResolver);
            const writer = newSocket.writable.getWriter();
            try { await writer.write(rawData); }
            finally { writer.releaseLock(); }
        } else if (upstreamProxy?.type === 'sstp') {
            newSocket = await sstpConnect(upstreamProxy, host, portNum, proxyConfig.dnsResolver);
            const writer = newSocket.writable.getWriter();
            try { await writer.write(rawData); }
            finally { writer.releaseLock(); }
        } else if (socks5Type === 'socks5') {
            const parsed = await getSocks5Account(socks5Account); // TODO: handle error or pre-parse
            newSocket = await socks5Connect(host, portNum, rawData, parsed);
        } else if (socks5Type === 'http' || socks5Type === 'https') {
            const parsed = await getSocks5Account(socks5Account);
            newSocket = await httpConnect(host, portNum, rawData, parsed);
        } else {
            if (!proxyIP) throw new Error('No proxy fallback is configured');
            const proxyList = await parseProxyAddress(proxyIP, host, yourUUID);
            newSocket = await connectDirect(proxyIP, 443, rawData, proxyList, enableProxyFallback);
        }
        remoteConnWrapper.socket = newSocket;
        newSocket.closed.catch(() => { }).finally(() => closeSocketQuietly(ws));
        void connectStreams(newSocket, ws, respHeader, null).catch(() => closeSocketQuietly(ws));
    }

    const checkSocks5Whitelist = (addr) => socks5Whitelist.some(p => new RegExp(`^${p.replace(/\*/g, '.*')}$`, 'i').test(addr));

    if (upstreamProxy || (socks5Type && (socks5Global || checkSocks5Whitelist(host)))) {
        await connectToProxy();
    } else {
        try {
            const initialSocket = await connectDirect(host, portNum, rawData);
            remoteConnWrapper.socket = initialSocket;
            initialSocket.closed.catch(() => { }).finally(() => closeSocketQuietly(ws));
            void connectStreams(initialSocket, ws, respHeader, proxyIP ? connectToProxy : null).catch(() => closeSocketQuietly(ws));
        } catch (err) {
            if (!proxyIP) {
                console.warn(`TCP connection failed: ${err.message}`);
                closeSocketQuietly(ws);
                return;
            }
            try {
                await connectToProxy();
            } catch (proxyError) {
                console.warn(`TCP proxy fallback failed: ${proxyError.message}`);
                closeSocketQuietly(ws);
            }
        }
    }
}

export async function handleWSRequest(request, yourUUID, proxyConfig) {
    const wssPair = new WebSocketPair();
    const [clientSock, serverSock] = Object.values(wssPair);
    // Recent Workers compatibility dates deliver binary frames as Blob by
    // default. The protocol parsers require ArrayBuffer/Uint8Array input.
    serverSock.binaryType = 'arraybuffer';
    serverSock.accept();
    let remoteConnWrapper = { socket: null };
    let isDnsQuery = false;
    let trojanUdpDecoder = null;
    let localSpeedTestSession = null;
    const shadowsocksMethod = new URL(request.url).searchParams.get('enc');
    const shadowsocksDecoder = shadowsocksMethod
        ? new ShadowsocksAeadDecoder(shadowsocksMethod, yourUUID)
        : null;
    const shadowsocksEncoder = shadowsocksMethod
        ? new ShadowsocksAeadEncoder(shadowsocksMethod, yourUUID)
        : null;
    let shadowsocksTargetBuffer = new Uint8Array(0);
    let shadowsocksSendChain = Promise.resolve();
    const dnsResolver = proxyConfig.dnsResolver || null;
    const earlyData = request.headers.get('sec-websocket-protocol') || '';
    const readable = makeReadableStr(serverSock, earlyData);
    let handshakeBuffer = new Uint8Array(0);
    let idleTimer;
    const closeSession = () => {
        try { remoteConnWrapper.socket?.close(); } catch { }
        closeSocketQuietly(serverSock);
    };
    const shadowsocksBridge = shadowsocksEncoder ? {
        get readyState() { return serverSock.readyState; },
        send(data) {
            const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
            shadowsocksSendChain = shadowsocksSendChain.then(async () => {
                const encrypted = await shadowsocksEncoder.encode(chunk);
                if (encrypted.byteLength && serverSock.readyState === WebSocket.OPEN) {
                    serverSock.send(encrypted);
                }
            });
            return shadowsocksSendChain;
        },
        close: closeSession,
    } : null;
    const forwardTrojanDns = async (data, responseSocket = serverSock) => {
        trojanUdpDecoder ||= new TrojanUdpDecoder();
        for (const packet of trojanUdpDecoder.push(data)) {
            if (packet.port !== 53) throw new Error('Only Trojan DNS UDP is supported');
            const framer = new TrojanDnsResponseFramer(packet.addressHeader);
            const dnsBridge = {
                get readyState() { return responseSocket.readyState; },
                async send(chunk) {
                    for (const frame of framer.push(chunk)) await responseSocket.send(frame);
                },
                close() { },
            };
            await forwardDataUDP(frameTcpDnsQuery(packet.payload), dnsBridge, null, dnsResolver);
        }
    };
    const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(closeSession, IDLE_TIMEOUT_MS);
    };
    const maxSessionTimer = setTimeout(closeSession, MAX_SESSION_MS);
    serverSock.addEventListener('close', () => {
        clearTimeout(idleTimer);
        clearTimeout(maxSessionTimer);
        try { remoteConnWrapper.socket?.close(); } catch { }
    });
    resetIdleTimer();

    readable.pipeTo(new WritableStream({
        async write(chunk) {
            resetIdleTimer();
            if (shadowsocksDecoder) {
                const plaintextChunks = await shadowsocksDecoder.push(chunk);
                for (const plaintext of plaintextChunks) {
                    if (localSpeedTestSession) {
                        await localSpeedTestSession.push(plaintext);
                        continue;
                    }
                    if (remoteConnWrapper.socket) {
                        const writer = remoteConnWrapper.socket.writable.getWriter();
                        try { await writer.write(plaintext); }
                        finally { writer.releaseLock(); }
                        continue;
                    }

                    const joined = new Uint8Array(shadowsocksTargetBuffer.byteLength + plaintext.byteLength);
                    joined.set(shadowsocksTargetBuffer);
                    joined.set(plaintext, shadowsocksTargetBuffer.byteLength);
                    shadowsocksTargetBuffer = joined;
                    const target = tryParseShadowsocksTarget(shadowsocksTargetBuffer);
                    if (target.status === 'need-more') continue;
                    if (target.status !== 'ok') throw new Error('Invalid Shadowsocks target header');
                    shadowsocksTargetBuffer = new Uint8Array(0);
                    if (isSpeedTestSite(target.hostname, proxyConfig.speedTestDomains)) {
                        if (proxyConfig.speedTestMode === 'block') return closeSession();
                        localSpeedTestSession = new LocalSpeedTestSession((response) => shadowsocksBridge.send(response));
                        await localSpeedTestSession.push(target.rawData);
                        continue;
                    }
                    await forwardDataTCP(
                        target.hostname,
                        target.port,
                        target.rawData,
                        shadowsocksBridge,
                        null,
                        remoteConnWrapper,
                        yourUUID,
                        proxyConfig
                    );
                }
                return;
            }
            if (trojanUdpDecoder) return forwardTrojanDns(chunk);
            if (isDnsQuery) return await forwardDataUDP(chunk, serverSock, null, dnsResolver);
            if (localSpeedTestSession) return localSpeedTestSession.push(chunk);
            if (remoteConnWrapper.socket) {
                const writer = remoteConnWrapper.socket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            if (handshakeBuffer.byteLength + incoming.byteLength > MAX_INITIAL_REQUEST_BYTES) {
                closeSession();
                return;
            }
            const joined = new Uint8Array(handshakeBuffer.byteLength + incoming.byteLength);
            joined.set(handshakeBuffer);
            joined.set(incoming, handshakeBuffer.byteLength);
            handshakeBuffer = joined;
            const handshake = tryParseTunnelHandshake(handshakeBuffer, yourUUID);
            if (handshake.status === 'need-more') return;
            if (handshake.status !== 'ok') return closeSession();
            handshakeBuffer = new Uint8Array(0);

            if (isSpeedTestSite(handshake.hostname, proxyConfig.speedTestDomains)) {
                if (proxyConfig.speedTestMode === 'block' || handshake.isUDP) return closeSession();
                localSpeedTestSession = new LocalSpeedTestSession(
                    (response) => serverSock.send(response),
                    handshake.responseHeader
                );
                return localSpeedTestSession.push(handshake.rawData);
            }
            if (handshake.isUDP) {
                if (!dnsResolver || handshake.port !== 53) return closeSession();
                isDnsQuery = true;
                if (handshake.protocol === 'trojan') return forwardTrojanDns(handshake.rawData);
                return forwardDataUDP(
                    handshake.rawData,
                    serverSock,
                    handshake.responseHeader,
                    dnsResolver
                );
            }
            await forwardDataTCP(
                handshake.hostname,
                handshake.port,
                handshake.rawData,
                serverSock,
                handshake.responseHeader,
                remoteConnWrapper,
                yourUUID,
                proxyConfig
            );
        },
    })).catch((err) => {
        // console.error('Pipe error', err);
        closeSession();
    });

    return new Response(null, { status: 101, webSocket: clientSock });
}
