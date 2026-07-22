import { isValidBase64, base64Decode } from './helpers.js';

export async function organizeToArray(content) {
    var replaced = content.replace(/[	"'\r\n]+/g, ',').replace(/,+/g, ',');
    if (replaced.charAt(0) == ',') replaced = replaced.slice(1);
    if (replaced.charAt(replaced.length - 1) == ',') replaced = replaced.slice(0, replaced.length - 1);
    const addressArray = replaced.split(',');
    return addressArray;
}

const LOCAL_ADDRESS_PATTERN = /^(\[[\da-fA-F:]+\]|[\d.]+|[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*)(?::(\d+))?(?:#(.+))?$/;

export function parseLocalAddressEntry(input, defaultPort = 443) {
    if (typeof input !== 'string' || input.length > 512) return null;
    const match = input.trim().match(LOCAL_ADDRESS_PATTERN);
    if (!match) return null;
    const port = match[2] ? Number(match[2]) : Number(defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { address: match[1], port, name: match[3] || match[1] };
}

export function parseLocalAddressList(content, defaultPort = 443, maxEntries = 4096) {
    if (typeof content !== 'string' || !content.trim() || content.trim() === 'null') return [];
    return content.split(/\r?\n/)
        .map((line) => parseLocalAddressEntry(line, defaultPort))
        .filter(Boolean)
        .slice(0, maxEntries);
}

export async function generateRandomIP(request, count = 16, designatedPort = -1) {
    const asnMap = { '9808': 'cmcc', '4837': 'cu', '4134': 'ct' };
    const asn = request.cf?.asn;
    const cfname = { '9808': 'CF移动优选', '4837': 'CF联通优选', '4134': 'CF电信优选' }[asn] || 'CF官方优选';
    const cfport = [443, 2053, 2083, 2087, 2096, 8443];
    let cidrList = [];
    // Keep this default self-contained. Operators who need a curated list can
    // place addresses in ADD.txt through the authenticated admin endpoint.
    cidrList = ['104.16.0.0/13'];

    const generateRandomIPFromCIDR = (cidr) => {
        const [baseIP, prefixLength] = cidr.split('/'), prefix = parseInt(prefixLength), hostBits = 32 - prefix;
        const ipInt = baseIP.split('.').reduce((a, p, i) => a | (parseInt(p) << (24 - i * 8)), 0);
        const randomOffset = Math.floor(Math.random() * Math.pow(2, hostBits));
        const mask = (0xFFFFFFFF << hostBits) >>> 0, randomIP = (((ipInt & mask) >>> 0) + randomOffset) >>> 0;
        return [(randomIP >>> 24) & 0xFF, (randomIP >>> 16) & 0xFF, (randomIP >>> 8) & 0xFF, randomIP & 0xFF].join('.');
    };

    const randomIPs = Array.from({ length: count }, () => {
        const ip = generateRandomIPFromCIDR(cidrList[Math.floor(Math.random() * cidrList.length)]);
        return `${ip}:${designatedPort === -1 ? cfport[Math.floor(Math.random() * cfport.length)] : designatedPort}#${cfname}`;
    });
    return [randomIPs, randomIPs.join('\n')];
}

export async function requestOptimalAPI(urls, defaultPort = '443', timeout = 3000) {
    if (!urls?.length) return [[], [], []];
    const results = new Set();
    let linkContent = '', needSubConversionURLs = [];
    await Promise.allSettled(urls.map(async (url) => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            let text = '';
            try {
                const buffer = await response.arrayBuffer();
                const contentType = (response.headers.get('content-type') || '').toLowerCase();
                const charset = contentType.match(/charset=([^\s;]+)/i)?.[1]?.toLowerCase() || '';

                let decoders = ['utf-8', 'gb2312'];
                if (charset.includes('gb') || charset.includes('gbk') || charset.includes('gb2312')) {
                    decoders = ['gb2312', 'utf-8'];
                }

                let decodeSuccess = false;
                for (const decoder of decoders) {
                    try {
                        const decoded = new TextDecoder(decoder).decode(buffer);
                        if (decoded && decoded.length > 0 && !decoded.includes('\ufffd')) {
                            text = decoded;
                            decodeSuccess = true;
                            break;
                        } else if (decoded && decoded.length > 0) {
                            continue;
                        }
                    } catch (e) {
                        continue;
                    }
                }

                if (!decodeSuccess) {
                    text = await response.text();
                }

                if (!text || text.trim().length === 0) {
                    return;
                }
            } catch (e) {
                console.error('Failed to decode response:', e);
                return;
            }

            const processedContent = isValidBase64(text) ? base64Decode(text) : text;
            if (processedContent.split('#')[0].includes('://')) {
                linkContent += processedContent + '\n';
                return;
            }

            const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l);
            const isCSV = lines.length > 1 && lines[0].includes(',');
            const IPV6_PATTERN = /^[^\[\]]*:[^\[\]]*:[^\[\]]/;
            if (!isCSV) {
                lines.forEach(line => {
                    const hashIndex = line.indexOf('#');
                    const [hostPart, remark] = hashIndex > -1 ? [line.substring(0, hashIndex), line.substring(hashIndex)] : [line, ''];
                    let hasPort = false;
                    if (hostPart.startsWith('[')) {
                        hasPort = /\]:(\d+)$/.test(hostPart);
                    } else {
                        const colonIndex = hostPart.lastIndexOf(':');
                        hasPort = colonIndex > -1 && /^\d+$/.test(hostPart.substring(colonIndex + 1));
                    }
                    const port = new URL(url).searchParams.get('port') || defaultPort;
                    results.add(hasPort ? line : `${hostPart}:${port}${remark}`);
                });
            } else {
                const headers = lines[0].split(',').map(h => h.trim());
                const dataLines = lines.slice(1);
                if (headers.includes('IP地址') && headers.includes('端口') && headers.includes('数据中心')) {
                    const ipIdx = headers.indexOf('IP地址'), portIdx = headers.indexOf('端口');
                    const remarkIdx = headers.indexOf('国家') > -1 ? headers.indexOf('国家') :
                        headers.indexOf('城市') > -1 ? headers.indexOf('城市') : headers.indexOf('数据中心');
                    const tlsIdx = headers.indexOf('TLS');
                    dataLines.forEach(line => {
                        const cols = line.split(',').map(c => c.trim());
                        if (tlsIdx !== -1 && cols[tlsIdx]?.toLowerCase() !== 'true') return;
                        const wrappedIP = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
                        results.add(`${wrappedIP}:${cols[portIdx]}#${cols[remarkIdx]}`);
                    });
                } else if (headers.some(h => h.includes('IP')) && headers.some(h => h.includes('延迟')) && headers.some(h => h.includes('下载速度'))) {
                    const ipIdx = headers.findIndex(h => h.includes('IP'));
                    const delayIdx = headers.findIndex(h => h.includes('延迟'));
                    const speedIdx = headers.findIndex(h => h.includes('下载速度'));
                    const port = new URL(url).searchParams.get('port') || defaultPort;
                    dataLines.forEach(line => {
                        const cols = line.split(',').map(c => c.trim());
                        const wrappedIP = IPV6_PATTERN.test(cols[ipIdx]) ? `[${cols[ipIdx]}]` : cols[ipIdx];
                        results.add(`${wrappedIP}:${port}#CF优选 ${cols[delayIdx]}ms ${cols[speedIdx]}MB/s`);
                    });
                }
            }
        } catch (e) { }
    }));
    const linkArray = linkContent.trim() ? [...new Set(linkContent.split(/\r?\n/).filter(line => line.trim() !== ''))] : [];
    return [Array.from(results), linkArray, needSubConversionURLs];
}

export async function getCloudflareUsage(Email, GlobalAPIKey, AccountID, APIToken) {
    const API = "https://api.cloudflare.com/client/v4";
    const sum = (a) => a?.reduce((t, i) => t + (i?.sum?.requests || 0), 0) || 0;
    const cfg = { "Content-Type": "application/json" };

    try {
        if (!AccountID && (!Email || !GlobalAPIKey)) return { success: false, pages: 0, workers: 0, total: 0, max: 100000 };

        if (!AccountID) {
            const r = await fetch(`${API}/accounts`, {
                method: "GET",
                headers: { ...cfg, "X-AUTH-EMAIL": Email, "X-AUTH-KEY": GlobalAPIKey }
            });
            if (!r.ok) throw new Error(`账户获取失败: ${r.status}`);
            const d = await r.json();
            if (!d?.result?.length) throw new Error("未找到账户");
            const idx = d.result.findIndex(a => a.name?.toLowerCase().startsWith(Email.toLowerCase()));
            AccountID = d.result[idx >= 0 ? idx : 0]?.id;
        }

        const now = new Date();
        now.setUTCHours(0, 0, 0, 0);
        const hdr = APIToken ? { ...cfg, "Authorization": `Bearer ${APIToken}` } : { ...cfg, "X-AUTH-EMAIL": Email, "X-AUTH-KEY": GlobalAPIKey };

        const res = await fetch(`${API}/graphql`, {
            method: "POST",
            headers: hdr,
            body: JSON.stringify({
                query: `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
                    viewer { accounts(filter: {accountTag: $AccountID}) {
                        pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
                        workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
                    } }
                }`,
                variables: { AccountID, filter: { datetime_geq: now.toISOString(), datetime_leq: new Date().toISOString() } }
            })
        });

        if (!res.ok) throw new Error(`查询失败: ${res.status}`);
        const result = await res.json();
        if (result.errors?.length) throw new Error(result.errors[0].message);

        const acc = result?.data?.viewer?.accounts?.[0];
        if (!acc) throw new Error("未找到账户数据");

        const pages = sum(acc.pagesFunctionsInvocationsAdaptiveGroups);
        const workers = sum(acc.workersInvocationsAdaptive);
        const total = pages + workers;
        const max = 100000;
        console.log(`统计结果 - Pages: ${pages}, Workers: ${workers}, 总计: ${total}, 上限: 100000`);
        return { success: true, pages, workers, total, max };

    } catch (error) {
        console.error('获取使用量错误:', error.message);
        return { success: false, pages: 0, workers: 0, total: 0, max: 100000 };
    }
}

export async function parseProxyAddress(proxyAddress) {
    if (typeof proxyAddress !== 'string' || !proxyAddress.trim()) return [];
    const value = proxyAddress.trim().toLowerCase();
    let hostname = value;
    let port = 443;

    if (value.startsWith('[')) {
        const match = value.match(/^(\[[0-9a-f:]+\])(?::(\d+))?$/i);
        if (!match) return [];
        hostname = match[1];
        port = match[2] ? Number(match[2]) : port;
    } else {
        const match = value.match(/^([^:]+)(?::(\d+))?$/);
        if (!match) return [];
        hostname = match[1];
        port = match[2] ? Number(match[2]) : port;
    }

    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return [];
    // cloudflare:sockets resolves operator-provided hostnames itself. Avoid a
    // hidden DoH dependency and let the platform perform normal DNS lookup.
    return [[hostname, port]];
}
