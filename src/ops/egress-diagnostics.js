function defaultNow() {
    return Date.now();
}

function defaultRecord(event) {
    console.log(JSON.stringify({ type: 'egress_diagnostic', ...event }));
}

export function findDiagnosticTargetKey(hostname, port, diagnosticTargets) {
    if (!(diagnosticTargets instanceof Map) || typeof hostname !== 'string') return null;
    const normalized = hostname.trim().toLowerCase().replace(/\.$/, '');
    for (const [key, target] of diagnosticTargets.entries()) {
        if (target?.hostname === normalized && target?.port === port) return key;
    }
    return null;
}

export function recordEgressDiagnosticEvent(event) {
    defaultRecord(event);
}

export function createEgressObserver({
    targetKey,
    now = defaultNow,
    timeoutMs = 8000,
    record = defaultRecord,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
}) {
    if (typeof targetKey !== 'string' || !targetKey) return null;
    const startedAt = now();
    let timer = null;
    let terminal = false;
    let opened = false;

    const emit = (event) => {
        record({
            targetKey,
            event,
            elapsedMs: Math.max(0, Math.round(now() - startedAt)),
        });
    };

    const clear = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    return {
        openOk() {
            if (terminal || opened) return;
            opened = true;
            emit('direct_open_ok');
            timer = setTimer(() => {
                if (terminal) return;
                terminal = true;
                timer = null;
                emit('direct_first_byte_timeout');
            }, timeoutMs);
        },
        openError() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_open_error');
        },
        firstByte() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_first_byte_ok');
        },
        closedBeforeByte() {
            if (terminal) return;
            terminal = true;
            clear();
            emit('direct_closed_before_byte');
        },
        finish() {
            clear();
            terminal = true;
        },
    };
}
