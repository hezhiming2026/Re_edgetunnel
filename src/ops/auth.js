const MIN_MACHINE_TOKEN_LENGTH = 24;

async function digestToken(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function constantTimeEqual(left, right) {
    let diff = left.length ^ right.length;
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index++) {
        diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    return diff === 0;
}

export async function authenticateMachineRequest(request, env) {
    const expected = typeof env?.OPTIMIZER_TOKEN === 'string' ? env.OPTIMIZER_TOKEN : '';
    const match = request.headers.get('Authorization')?.match(/^Bearer ([^\s]+)$/);
    if (!match || expected.length < MIN_MACHINE_TOKEN_LENGTH) return false;

    const [providedDigest, expectedDigest] = await Promise.all([
        digestToken(match[1]),
        digestToken(expected),
    ]);
    return constantTimeEqual(providedDigest, expectedDigest);
}

export function machineUnauthorized() {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
            'Content-Type': 'application/json;charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
