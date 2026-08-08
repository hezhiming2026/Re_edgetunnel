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

async function readJson(kv, key) {
    const value = await kv.get(key);
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        throw new PoolStoreError(`Invalid JSON stored at ${key}`, 500);
    }
}

function requireKv(env) {
    if (!env?.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function') {
        throw new PoolStoreError('KV binding is required', 503);
    }
    return env.KV;
}

function assertExpectedRevision(requestBody, current) {
    if (!requestBody || typeof requestBody !== 'object' || !Object.hasOwn(requestBody, 'expected_current_revision')) {
        throw new PoolStoreError('expected_current_revision is required', 400);
    }
    const expected = requestBody.expected_current_revision;
    if (expected !== null && typeof expected !== 'string') {
        throw new PoolStoreError('expected_current_revision must be a string or null', 400);
    }
    if ((current ?? null) !== expected) {
        throw new PoolStoreError('Current optimizer revision changed', 409);
    }
}

export async function publishPool(env, requestBody, allowedCidrs) {
    const kv = requireKv(env);
    const current = await kv.get('optimizer:current');
    assertExpectedRevision(requestBody, current);

    let entries;
    try {
        entries = validatePoolEntries(requestBody.entries, allowedCidrs);
    } catch (error) {
        throw new PoolStoreError(error.message, 400);
    }

    const canonical = canonicalPoolJson(entries);
    const checksum = await sha256Hex(canonical);
    const revision = `${compactUtcTimestamp()}-${checksum.slice(0, 12)}`;
    const createdAt = new Date().toISOString();
    const snapshot = { revision, checksum, created_at: createdAt, entries };

    await kv.put(`optimizer:pool:${revision}`, JSON.stringify(snapshot));
    if (current) await kv.put('optimizer:previous', current);
    await kv.put('optimizer:current', revision);
    await kv.put('ADD.txt', formatAddTxt(entries));
    await kv.put('optimizer:status', JSON.stringify({
        mutation: 'publish',
        at: createdAt,
        revision,
        previous: current || null,
        checksum,
    }));

    return { revision, checksum, previous: current || null };
}

export async function rollbackPool(env, expectedCurrentRevision) {
    const kv = requireKv(env);
    const current = await kv.get('optimizer:current');
    if (typeof expectedCurrentRevision !== 'string' || !expectedCurrentRevision) {
        throw new PoolStoreError('expected_current_revision is required', 400);
    }
    if (current !== expectedCurrentRevision) throw new PoolStoreError('Current optimizer revision changed', 409);

    const previous = await kv.get('optimizer:previous');
    if (!previous) throw new PoolStoreError('No previous optimizer revision is available', 409);
    const snapshot = await readJson(kv, `optimizer:pool:${previous}`);
    if (!snapshot || !Array.isArray(snapshot.entries) || typeof snapshot.checksum !== 'string') {
        throw new PoolStoreError('Previous optimizer snapshot is unavailable', 500);
    }

    const at = new Date().toISOString();
    await kv.put('optimizer:previous', current);
    await kv.put('optimizer:current', previous);
    await kv.put('ADD.txt', formatAddTxt(snapshot.entries));
    await kv.put('optimizer:status', JSON.stringify({
        mutation: 'rollback',
        at,
        revision: previous,
        previous: current,
        checksum: snapshot.checksum,
    }));

    return { revision: previous, checksum: snapshot.checksum };
}

export async function readPoolStatus(env) {
    const kv = requireKv(env);
    const [current, previous, status] = await Promise.all([
        kv.get('optimizer:current'),
        kv.get('optimizer:previous'),
        readJson(kv, 'optimizer:status'),
    ]);
    return { current: current || null, previous: previous || null, status };
}
