import { ipv4Prefix24, isIPv4InCidrs, parseIPv4, parseIPv4Cidr } from './cidr.js';

const MAX_POOL_ENTRIES = 16;
const MAX_LABEL_BYTES = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function parseAllowedCidrs(value) {
    if (typeof value !== 'string') throw new Error('Allowed CIDRs are required');
    const entries = value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
    if (!entries.length) throw new Error('Allowed CIDRs are required');
    return entries.map(parseIPv4Cidr);
}

function validateLabel(value, fallback) {
    const name = typeof value === 'string' && value.length ? value : fallback;
    if (CONTROL_CHARACTERS.test(name)) throw new Error('Pool label contains control characters');
    if (new TextEncoder().encode(name).byteLength > MAX_LABEL_BYTES) throw new Error('Pool label is too long');
    return name;
}

export function validatePoolEntries(entries, allowedCidrs) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('Pool entries are required');
    if (entries.length > MAX_POOL_ENTRIES) throw new Error('Pool contains too many entries');
    if (!Array.isArray(allowedCidrs) || allowedCidrs.length === 0) throw new Error('Allowed CIDRs are required');

    const seen = new Set();
    const per24 = new Map();

    return entries.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid pool entry');
        const { canonical: address } = parseIPv4(entry.address);
        if (!isIPv4InCidrs(address, allowedCidrs)) throw new Error('Pool address is outside allowed CIDRs');
        if (Number(entry.port) !== 443) throw new Error('Optimizer pool port must be 443');
        if (seen.has(address)) throw new Error('Duplicate pool address');
        seen.add(address);

        const prefix24 = ipv4Prefix24(address);
        const count = (per24.get(prefix24) || 0) + 1;
        if (count > 2) throw new Error('Too many pool addresses in one /24');
        per24.set(prefix24, count);

        return {
            address,
            port: 443,
            name: validateLabel(entry.name, address),
        };
    });
}

export function formatAddTxt(entries) {
    if (!Array.isArray(entries) || !entries.length) throw new Error('Validated pool entries are required');
    return `${entries.map(({ address, name }) => `${address}:443#${name}`).join('\n')}\n`;
}
