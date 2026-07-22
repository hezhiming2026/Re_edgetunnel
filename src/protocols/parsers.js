import { formatIdentifier, sha224 } from '../utils/helpers.js';

export function parseVlessRequest(chunk, token) {
    if (chunk.byteLength < 24) return { hasError: true, message: 'Invalid data' };
    const version = new Uint8Array(chunk.slice(0, 1));
    if (formatIdentifier(new Uint8Array(chunk.slice(1, 17))) !== token) return { hasError: true, message: 'Invalid uuid' };
    const optLen = new Uint8Array(chunk.slice(17, 18))[0];
    if (19 + optLen > chunk.byteLength) return { hasError: true, message: 'Invalid option length' };
    const cmd = new Uint8Array(chunk.slice(18 + optLen, 19 + optLen))[0];
    let isUDP = false;
    if (cmd === 1) { } else if (cmd === 2) { isUDP = true; } else { return { hasError: true, message: 'Invalid command' }; }
    const portIdx = 19 + optLen;
    if (portIdx + 3 > chunk.byteLength) return { hasError: true, message: 'Truncated request' };
    const port = new DataView(chunk.slice(portIdx, portIdx + 2)).getUint16(0);
    if (port === 0) return { hasError: true, message: 'Invalid port' };
    let addrIdx = portIdx + 2, addrLen = 0, addrValIdx = addrIdx + 1, hostname = '';
    const addressType = new Uint8Array(chunk.slice(addrIdx, addrValIdx))[0];
    switch (addressType) {
        case 1:
            addrLen = 4;
            if (addrValIdx + addrLen > chunk.byteLength) return { hasError: true, message: 'Truncated IPv4 address' };
            hostname = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + addrLen)).join('.');
            break;
        case 2:
            if (addrValIdx >= chunk.byteLength) return { hasError: true, message: 'Truncated domain' };
            addrLen = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + 1))[0];
            addrValIdx += 1;
            hostname = new TextDecoder().decode(chunk.slice(addrValIdx, addrValIdx + addrLen));
            break;
        case 3:
            addrLen = 16;
            if (addrValIdx + addrLen > chunk.byteLength) return { hasError: true, message: 'Truncated IPv6 address' };
            const ipv6 = [];
            const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen));
            for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16));
            hostname = ipv6.join(':');
            break;
        default:
            return { hasError: true, message: `Invalid address type: ${addressType}` };
    }
    if (addrValIdx + addrLen > chunk.byteLength) return { hasError: true, message: 'Truncated address' };
    if (!hostname) return { hasError: true, message: `Invalid address: ${addressType}` };
    return { hasError: false, addressType, port, hostname, isUDP, rawIndex: addrValIdx + addrLen, version };
}

export function parseTrojanRequest(buffer, passwordPlainText) {
    const sha224Password = sha224(passwordPlainText);
    if (buffer.byteLength < 58) return { hasError: true, message: "invalid data" };
    let crLfIndex = 56;
    if (new Uint8Array(buffer.slice(56, 57))[0] !== 0x0d || new Uint8Array(buffer.slice(57, 58))[0] !== 0x0a) return { hasError: true, message: "invalid header format" };
    const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
    if (password !== sha224Password) return { hasError: true, message: "invalid password" };

    const socks5DataBuffer = buffer.slice(crLfIndex + 2);
    if (socks5DataBuffer.byteLength < 6) return { hasError: true, message: "invalid S5 request data" };

    const view = new DataView(socks5DataBuffer);
    const cmd = view.getUint8(0);
    if (cmd !== 1) return { hasError: true, message: "unsupported command, only TCP is allowed" };

    const atype = view.getUint8(1);
    let addressLength = 0;
    let addressIndex = 2;
    let address = "";
    switch (atype) {
        case 1: // IPv4
            addressLength = 4;
            if (addressIndex + addressLength > socks5DataBuffer.byteLength) return { hasError: true, message: 'truncated IPv4 address' };
            address = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join(".");
            break;
        case 3: // Domain
            if (addressIndex >= socks5DataBuffer.byteLength) return { hasError: true, message: 'truncated domain' };
            addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            address = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            break;
        case 4: // IPv6
            addressLength = 16;
            if (addressIndex + addressLength > socks5DataBuffer.byteLength) return { hasError: true, message: 'truncated IPv6 address' };
            const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            address = ipv6.join(":");
            break;
        default:
            return { hasError: true, message: `invalid addressType is ${atype}` };
    }

    if (addressIndex + addressLength + 2 > socks5DataBuffer.byteLength) return { hasError: true, message: 'truncated address' };

    if (!address) {
        return { hasError: true, message: `address is empty, addressType is ${atype}` };
    }

    const portIndex = addressIndex + addressLength;
    const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    if (portRemote === 0) return { hasError: true, message: 'invalid port' };
    const trailingCrLf = new Uint8Array(socks5DataBuffer.slice(portIndex + 2, portIndex + 4));
    if (trailingCrLf.length !== 2 || trailingCrLf[0] !== 0x0d || trailingCrLf[1] !== 0x0a) {
        return { hasError: true, message: 'invalid request terminator' };
    }

    return {
        hasError: false,
        addressType: atype,
        port: portRemote,
        hostname: address,
        rawClientData: socks5DataBuffer.slice(portIndex + 4)
    };
}
