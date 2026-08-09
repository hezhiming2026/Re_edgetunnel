export function parseIPv4(value) {
    if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
        throw new Error('Invalid IPv4 address');
    }
    const octets = value.split('.').map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        throw new Error('Invalid IPv4 address');
    }
    const canonical = octets.join('.');
    const number = (
        ((octets[0] << 24) >>> 0) |
        (octets[1] << 16) |
        (octets[2] << 8) |
        octets[3]
    ) >>> 0;
    return { number, canonical, octets };
}

export function parseIPv4Cidr(value) {
    if (typeof value !== 'string') throw new Error('Invalid IPv4 CIDR');
    const match = value.match(/^([^/]+)\/(\d{1,2})$/);
    if (!match) throw new Error('Invalid IPv4 CIDR');
    const { number } = parseIPv4(match[1]);
    const prefix = Number(match[2]);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error('Invalid IPv4 CIDR prefix');
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (number & mask) >>> 0;
    return { network, mask, prefix };
}

export function isIPv4InCidrs(value, cidrs) {
    const { number } = parseIPv4(value);
    return cidrs.some(({ network, mask }) => ((number & mask) >>> 0) === network);
}

export function ipv4Prefix24(value) {
    const { octets } = parseIPv4(value);
    return `${octets[0]}.${octets[1]}.${octets[2]}`;
}
