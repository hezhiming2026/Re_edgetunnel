import { ipv4Prefix24, isIPv4InCidrs, parseIPv4, parseIPv4Cidr } from './cidr.js';

const MAX_POOL_ENTRIES = 16;
const MAX_LABEL_BYTES = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class PoolStoreError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'PoolStoreError';
        this.status = status;
    }
}

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
        if (entry.port !== 443) throw new Error('Optimizer pool port must be 443');
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

function canonicalPoolJson(entries) {
    return JSON.stringify(entries.map(({ address, port, name }) => ({ address, port, name })));
}

async function sha256Hex(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function compactUtcTimestamp(date = new Date()) {
    return date.toISOString().replace(/[-:.]/g, '');
}

export async function buildPoolSnapshot(entries, date = new Date()) {
    const canonical = canonicalPoolJson(entries);
    const checksum = await sha256Hex(canonical);
    return {
        revision: `${compactUtcTimestamp(date)}-${checksum.slice(0, 12)}`,
        checksum,
        created_at: date.toISOString(),
        entries,
    };
}

export function getOptimizerCoordinator(env) {
    const namespace = env?.OPTIMIZER_COORDINATOR;
    if (!namespace || typeof namespace.getByName !== 'function') {
        throw new PoolStoreError('Optimizer coordinator binding is required', 503);
    }
    return namespace.getByName('optimizer-pool-v1');
}

export async function readOptimizerAddTxt(env) {
    const namespace = env?.OPTIMIZER_COORDINATOR;
    if (!namespace || typeof namespace.getByName !== 'function') return null;
    const value = await namespace.getByName('optimizer-pool-v1').getAddTxt();
    return typeof value === 'string' && value.trim() ? value : null;
}
