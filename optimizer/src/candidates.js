function ipv4ToUint32(value) {
  if (typeof value !== 'string') throw new Error('IPv4 address must be a string');
  const parts = value.trim().split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4 address: ${value}`);
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) throw new Error(`Invalid IPv4 address: ${value}`);
    const octet = Number(part);
    if (octet < 0 || octet > 255) throw new Error(`Invalid IPv4 address: ${value}`);
    out = ((out << 8) | octet) >>> 0;
  }
  return out >>> 0;
}

function uint32ToIpv4(value) {
  const n = value >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function maskForPrefix(prefix) {
  if (prefix === 0) return 0;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function parseCidr(value) {
  const text = String(value || '').trim();
  if (text.includes(':')) throw new Error(`IPv4 CIDR required: ${text}`);
  const match = /^([^/]+)\/(\d{1,2})$/.exec(text);
  if (!match) throw new Error(`Invalid CIDR: ${text}`);
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid CIDR prefix: ${text}`);
  const ip = ipv4ToUint32(match[1]);
  const mask = maskForPrefix(prefix);
  const network = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const first = prefix <= 30 ? (network + 1) >>> 0 : network;
  const lastRaw = network + size - 1;
  const last = prefix <= 30 ? (lastRaw - 1) >>> 0 : lastRaw >>> 0;
  const usable = Math.max(0, last - first + 1);
  return { text: `${uint32ToIpv4(network)}/${prefix}`, prefix, network, first, last, usable };
}

export function parseCidrs(text) {
  const values = Array.isArray(text)
    ? text
    : String(text || '').split(/[\s,]+/).filter(Boolean);
  if (values.length === 0) throw new Error('At least one IPv4 CIDR is required');
  return values.map(parseCidr);
}

function contains(cidr, address) {
  const ip = typeof address === 'number' ? address >>> 0 : ipv4ToUint32(address);
  return ip >= cidr.first && ip <= cidr.last;
}

function isAllowed(address, cidrs) {
  try {
    return cidrs.some((cidr) => contains(cidr, address));
  } catch {
    return false;
  }
}

function boundedUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const fractional = n - Math.floor(n);
  return fractional < 0 ? fractional + 1 : fractional;
}

export function sampleIpv4Cidrs(cidrs, count, rng = Math.random) {
  if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('At least one CIDR is required');
  const target = Math.max(0, Math.floor(Number(count) || 0));
  const totalUsable = cidrs.reduce((sum, cidr) => sum + cidr.usable, 0);
  const wanted = Math.min(target, totalUsable);
  const result = [];
  const seen = new Set();

  for (let i = 0; result.length < wanted && i < Math.max(wanted * 12, 64); i += 1) {
    const cidrUnit = boundedUnit(rng() + i * 0.6180339887498949);
    const cidr = cidrs[Math.min(cidrs.length - 1, Math.floor(cidrUnit * cidrs.length))];
    if (!cidr.usable) continue;
    const hostUnit = boundedUnit(rng() + i * 0.3819660112501051);
    const offset = Math.min(cidr.usable - 1, Math.floor(hostUnit * cidr.usable));
    const ip = uint32ToIpv4((cidr.first + offset) >>> 0);
    if (!seen.has(ip)) {
      seen.add(ip);
      result.push(ip);
    }
  }

  if (result.length < wanted) {
    for (const cidr of cidrs) {
      if (result.length >= wanted) break;
      const scanLimit = Math.min(cidr.usable, wanted * 4 + 64);
      for (let offset = 0; offset < scanLimit && result.length < wanted; offset += 1) {
        const ip = uint32ToIpv4((cidr.first + offset) >>> 0);
        if (!seen.has(ip)) {
          seen.add(ip);
          result.push(ip);
        }
      }
    }
  }
  return result;
}

export function buildCandidateSet({ current = [], seeds = [], cidrs, targetCount, rng = Math.random }) {
  if (!Array.isArray(cidrs) || cidrs.length === 0) throw new Error('CIDRs are required');
  const additionalTarget = Math.max(0, Math.floor(Number(targetCount) || 0));
  const result = [];
  const seen = new Set();
  const retain = (address) => {
    const value = String(address || '').trim();
    if (!value || seen.has(value) || !isAllowed(value, cidrs)) return;
    seen.add(value);
    result.push(value);
  };

  current.forEach(retain);
  seeds.forEach(retain);
  const desiredTotal = result.length + additionalTarget;
  if (additionalTarget === 0) return result;

  const sampled = sampleIpv4Cidrs(cidrs, Math.max(additionalTarget * 3, desiredTotal * 2, additionalTarget + 16), rng);
  for (const address of sampled) {
    retain(address);
    if (result.length >= desiredTotal) break;
  }
  return result;
}

export const ipv4Internals = { ipv4ToUint32, uint32ToIpv4, contains };
