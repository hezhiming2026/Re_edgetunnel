const MAX_POLICY_SUFFIXES = 32;
const MAX_DIAGNOSTIC_TARGETS = 32;
const TARGET_KEY_PATTERN = /^[a-z0-9_-]{1,32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function normalizeHostname(value) {
    if (typeof value !== 'string') return null;
    const hostname = value.trim().toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname.length > 253 || CONTROL_CHARACTERS.test(hostname)) return null;
    if (hostname.includes('://') || /[\/@?#]/.test(hostname) || hostname === '*' || IPV4_PATTERN.test(hostname)) return null;
    const labels = hostname.split('.');
    if (labels.length < 2) return null;
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return hostname;
}

export function parseDomainSuffixList(value) {
    if (value == null || String(value).trim() === '') return [];
    const suffixes = [];
    const seen = new Set();
    for (const raw of String(value).split(/[\s,]+/)) {
        const hostname = normalizeHostname(raw);
        if (!hostname || seen.has(hostname)) continue;
        seen.add(hostname);
        suffixes.push(hostname);
        if (suffixes.length >= MAX_POLICY_SUFFIXES) break;
    }
    return suffixes;
}

export function matchDomainSuffix(hostname, suffixes) {
    const normalized = normalizeHostname(hostname);
    if (!normalized || !Array.isArray(suffixes)) return false;
    return suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

export function parseDiagnosticTargets(value) {
    const targets = new Map();
    if (value == null || String(value).trim() === '') return targets;

    for (const raw of String(value).split(/[\s,]+/)) {
        if (!raw) continue;
        const separator = raw.indexOf('=');
        if (separator <= 0 || raw.indexOf('=', separator + 1) !== -1) continue;
        const key = raw.slice(0, separator).trim().toLowerCase();
        const target = raw.slice(separator + 1).trim();
        if (!TARGET_KEY_PATTERN.test(key) || targets.has(key)) continue;

        const portSeparator = target.lastIndexOf(':');
        if (portSeparator <= 0) continue;
        const hostname = normalizeHostname(target.slice(0, portSeparator));
        const portText = target.slice(portSeparator + 1);
        if (!hostname || !/^\d{1,5}$/.test(portText)) continue;
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

        targets.set(key, { hostname, port });
        if (targets.size >= MAX_DIAGNOSTIC_TARGETS) break;
    }
    return targets;
}

export function resolveEgressPolicy(hostname, config = {}) {
    if (matchDomainSuffix(hostname, config.forceEgressDomains || [])) return 'force';
    if (matchDomainSuffix(hostname, config.fallbackDomains || [])) return 'fallback';
    return 'direct';
}

export function parseEgressRuntimeConfig(env = {}) {
    const timeout = Number(env.EGRESS_FIRST_BYTE_TIMEOUT_MS || 8000);
    return {
        diagnosticTargets: parseDiagnosticTargets(env.DIAGNOSTIC_TARGETS),
        fallbackDomains: parseDomainSuffixList(env.FALLBACK_DOMAINS),
        forceEgressDomains: parseDomainSuffixList(env.FORCE_EGRESS_DOMAINS),
        egressFirstByteTimeoutMs: Number.isInteger(timeout) && timeout >= 1000 && timeout <= 30000 ? timeout : 8000,
        egressRoutingEnabled: false,
    };
}
