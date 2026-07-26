export const MAX_CONCURRENT_DIALS = 4;

export function parseConcurrentDialCount(value, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return fallback;
    return Math.min(parsed, MAX_CONCURRENT_DIALS);
}

export async function raceSocketCandidates(candidates, openCandidate) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('No dial candidates were provided');
    }

    if (candidates.length === 1) {
        const candidate = candidates[0];
        return { socket: await openCandidate(candidate), candidate };
    }

    const attempts = candidates.map(async (candidate) => ({
        socket: await openCandidate(candidate),
        candidate,
    }));

    let winner;
    try {
        winner = await Promise.any(attempts);
        return winner;
    } finally {
        if (winner) {
            for (const attempt of attempts) {
                void attempt.then(({ socket }) => {
                    if (socket !== winner.socket) {
                        try { socket.close(); } catch { }
                    }
                }).catch(() => { });
            }
        }
    }
}
