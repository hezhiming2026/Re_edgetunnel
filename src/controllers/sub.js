
import { MD5MD5, batchReplaceDomain, buildProxyUri, buildShadowsocksUri, normalizeTransport } from "../utils/helpers.js";
import { generateRandomIP, parseLocalAddressList } from "../utils/ip.js";
import { SingboxPatch, ClashPatch, SurgePatch } from "../utils/patches.js";
import { logRequest } from "../config.js";

async function getECH(host, dohUrl) {
    if (!dohUrl) return '';
    try {
        const resolver = new URL(dohUrl);
        if (resolver.protocol !== 'https:') return '';
        resolver.searchParams.set('name', host);
        resolver.searchParams.set('type', '65');
        const res = await fetch(resolver, { headers: { 'accept': 'application/dns-json' } });
        const data = await res.json();
        if (!data.Answer?.length) return '';
        for (let ans of data.Answer) {
            if (ans.type !== 65 || !ans.data) continue;
            const match = ans.data.match(/ech=([^\s]+)/);
            if (match) return match[1].replace(/"/g, '');
            // Simple hex parsing if needed, assumed string for now or skip complex parsing for brevity
            // The full impl has complex parsing.
        }
        return '';
    } catch { return ''; }
}

export async function handleSub(request, env, config, ctx) {
    const url = new URL(request.url);
    const host = config.HOST;
    const userID = config.UUID;
    const subToken = await MD5MD5(host + userID);

    if (url.searchParams.get('token') !== subToken) {
        // Double check against MD5(hostname + userID) vs just url param
        return new Response(JSON.stringify({ success: false, msg: "Invalid Token" }), { status: 403 });
    }

    if (env.KV) ctx.waitUntil(logRequest(env, request, request.headers.get('CF-Connecting-IP') || 'Unknown', 'Get_SUB', config));

    const ua = (request.headers.get('User-Agent') || '').toLowerCase();
    const expire = 4102329600;

    const responseHeaders = {
        "content-type": "text/plain; charset=utf-8",
        "Profile-Update-Interval": config.优选订阅生成.SUBUpdateTime,
        "Subscription-Userinfo": `upload=0; download=0; total=107374182400; expire=${expire}`,
        "Cache-Control": "no-store",
    };

    const isSubConverter = url.searchParams.has('b64') || url.searchParams.has('base64') || ua.includes('subconverter');
    const type = isSubConverter ? 'mixed' :
        (url.searchParams.has('clash') || ua.includes('clash') ? 'clash' :
            (url.searchParams.has('sb') || url.searchParams.has('singbox') || ua.includes('singbox') ? 'singbox' :
                (url.searchParams.has('surge') || ua.includes('surge') ? 'surge&ver=4' :
                    (url.searchParams.has('quanx') || ua.includes('quantumult') ? 'quanx' :
                        (url.searchParams.has('loon') || ua.includes('loon') ? 'loon' : 'mixed')))));

    if (!ua.includes('mozilla')) responseHeaders["Content-Disposition"] = `attachment; filename*=utf-8''${encodeURIComponent(config.优选订阅生成.SUBNAME)}`;
    let content = '';

    if (type === 'mixed') {
        let links = '';
        const path = config.PATH;
        const tlsFragment = config.TLS分片 == 'Shadowrocket' ? '1,40-60,30-50,tlshello' : config.TLS分片 == 'Happ' ? '3,1,tlshello' : null;
        const echValue = config.ECH && config.ECHConfig?.DNS ? (config.ECHConfig.SNI ? config.ECHConfig.SNI + '+' : '') + config.ECHConfig.DNS : null;

        if (config.优选订阅生成.local) {
            const savedAddresses = parseLocalAddressList(await env.KV.get('ADD.txt'));
            let addressEntries = savedAddresses;
            if (!addressEntries.length) {
                const [generatedAddresses] = await generateRandomIP(request, config.优选订阅生成.本地IP库.随机数量, config.优选订阅生成.本地IP库.指定端口);
                addressEntries = parseLocalAddressList(generatedAddresses.join('\n'));
            }
            const transports = Array.isArray(config.TRANSPORTS)
                ? [...new Set(config.TRANSPORTS.map(normalizeTransport))]
                : [normalizeTransport(config.传输协议)];
            const protocols = (url.searchParams.has('surge') || ua.includes('surge'))
                ? ['trojan']
                : ['vless', 'trojan'];
            links = addressEntries.flatMap(({ address, port, name }) => {
                const nodePath = config.随机路径 ? '/' : path;
                const proxyLinks = protocols.flatMap(protocol =>
                    transports.map(transport => buildProxyUri({
                        protocol,
                        credential: userID,
                        address,
                        port,
                        host,
                        transport,
                        path: transport === 'ws' && config.启用0RTT ? `${nodePath}${nodePath.includes('?') ? '&' : '?'}ed=2560` : nodePath,
                        fingerprint: config.Fingerprint,
                        name: `${name}-${protocol}-${transport}`,
                        skipCertificateVerification: config.跳过证书验证,
                        ech: echValue,
                        fragment: tlsFragment,
                    }))
                );
                if (config.SHADOWSOCKS?.enabled && !url.searchParams.has('surge') && !ua.includes('surge')) {
                    proxyLinks.push(buildShadowsocksUri({
                        method: config.SHADOWSOCKS.method,
                        password: userID,
                        address,
                        port,
                        host,
                        path: nodePath,
                        name: `${name}-shadowsocks-ws`,
                        tls: config.SHADOWSOCKS.tls !== false,
                    }));
                }
                return proxyLinks;
            }).join('\n');
        } else {
            // Fetch from SUB
            // Simplified: just return empty if remote not implemented in this plan
            // The original used `优选订阅生成器HOST`
        }
        content = links;
    } else {
        // Subconverter
        const subApi = config.订阅转换配置.SUBAPI;
        const subConfig = config.订阅转换配置.SUBCONFIG;
        if (!subApi || !subConfig) {
            return new Response('Remote subscription conversion is disabled. Configure an operator-owned SUBAPI and SUBCONFIG to enable it.', { status: 501 });
        }
        let subApiUrl;
        let subConfigUrl;
        try {
            subApiUrl = new URL(subApi);
            subConfigUrl = new URL(subConfig);
            if (subApiUrl.protocol !== 'https:' || subConfigUrl.protocol !== 'https:') throw new Error('Remote conversion endpoints must use HTTPS');
        } catch {
            return new Response('Invalid remote subscription conversion configuration', { status: 500 });
        }
        const subUrl = `${subApiUrl.origin}${subApiUrl.pathname.replace(/\/$/, '')}/sub?target=${type}&url=${encodeURIComponent(url.protocol + '//' + url.host + '/sub?target=mixed&token=' + subToken)}&config=${encodeURIComponent(subConfigUrl.href)}&emoji=${config.订阅转换配置.SUBEMOJI}&scv=${config.跳过证书验证}`;
        try {
            const res = await fetch(subUrl, { headers: { 'User-Agent': 'Subconverter...' } });
            if (res.ok) {
                content = await res.text();
                if (type.includes('surge')) content = SurgePatch(content, url.href, config);
            }
        } catch (e) {
            return new Response('Subconverter Error', { status: 500 });
        }
    }

    if (!ua.includes('subconverter')) content = batchReplaceDomain(content.replace(new RegExp("00000000-0000-4000-8000-000000000000", 'g'), config.UUID), config.HOSTS);

    if (type === 'mixed' && (!ua.includes('mozilla') || url.searchParams.has('base64'))) content = btoa(content);

    if (type === 'singbox') {
        const echVal = config.ECH ? await getECH(config.ECHConfig.SNI || host, config.ECHConfig?.DNS) : null;
        content = SingboxPatch(content, config.UUID, config.Fingerprint, echVal, config.本地规则集URL);
        responseHeaders["content-type"] = 'application/json; charset=utf-8';
    } else if (type === 'clash') {
        content = ClashPatch(content, config.UUID, config.ECH, config.HOSTS, config.ECHConfig.SNI, config.ECHConfig.DNS, config.客户端DNS);
        responseHeaders["content-type"] = 'application/x-yaml; charset=utf-8';
    }

    return new Response(content, { status: 200, headers: responseHeaders });
}
