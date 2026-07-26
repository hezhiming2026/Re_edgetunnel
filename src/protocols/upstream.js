const DEFAULT_PORTS = Object.freeze({
    socks5: 1080,
    http: 8080,
    https: 443,
    turn: 3478,
    turns: 5349,
    sstp: 443,
});

export function parseUpstreamProxy(value) {
    if (value == null || String(value).trim() === '') return null;
    let url;
    try {
        url = new URL(String(value).trim());
    } catch {
        throw new Error('UPSTREAM_PROXY must be an absolute proxy URL');
    }
    const type = url.protocol.slice(0, -1).toLowerCase();
    if (!Object.hasOwn(DEFAULT_PORTS, type)) {
        throw new Error(`Unsupported upstream proxy protocol: ${type}`);
    }
    if (!url.hostname || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
        throw new Error('UPSTREAM_PROXY must contain only scheme, credentials, host, and port');
    }
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[type];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('UPSTREAM_PROXY port is invalid');
    }
    return {
        type,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        tls: type === 'https' || type === 'turns' || type === 'sstp',
    };
}
