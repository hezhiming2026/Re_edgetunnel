import { connect } from 'cloudflare:sockets';

export async function directDiagnosticDial(target, timeoutMs = 3000) {
    const socket = connect({ hostname: target.hostname, port: target.port });
    let timeoutId;
    try {
        await Promise.race([
            socket.opened,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('Diagnostic TCP connection timed out')), timeoutMs);
            }),
        ]);
        return socket;
    } catch (error) {
        try { socket.close(); } catch { }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
