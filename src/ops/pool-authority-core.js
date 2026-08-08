function normalizeExpected(value) {
    return value === undefined ? null : value;
}

export function publishAuthoritativePool(storage, request) {
    let result;
    storage.transactionSync(() => {
        const current = storage.kv.get('current') ?? null;
        const expected = normalizeExpected(request.expected_current_revision);
        if (expected !== current) {
            result = { ok: false, status: 409, error: 'Current optimizer revision changed' };
            return;
        }

        const snapshot = request.snapshot;
        const previous = current;
        storage.kv.put(`pool:${snapshot.revision}`, snapshot);
        if (previous) storage.kv.put('previous', previous);
        else storage.kv.delete('previous');
        storage.kv.put('current', snapshot.revision);
        storage.kv.put('add_txt', request.add_txt);
        storage.kv.put('status', {
            mutation: 'publish',
            at: snapshot.created_at,
            revision: snapshot.revision,
            previous,
            checksum: snapshot.checksum,
        });
        result = {
            ok: true,
            revision: snapshot.revision,
            checksum: snapshot.checksum,
            previous,
            snapshot,
            add_txt: request.add_txt,
        };
    });
    return result;
}

export function rollbackAuthoritativePool(storage, expectedCurrentRevision, now = new Date().toISOString()) {
    let result;
    storage.transactionSync(() => {
        const current = storage.kv.get('current') ?? null;
        if (typeof expectedCurrentRevision !== 'string' || !expectedCurrentRevision) {
            result = { ok: false, status: 400, error: 'expected_current_revision is required' };
            return;
        }
        if (current !== expectedCurrentRevision) {
            result = { ok: false, status: 409, error: 'Current optimizer revision changed' };
            return;
        }

        const previous = storage.kv.get('previous') ?? null;
        if (!previous) {
            result = { ok: false, status: 409, error: 'No previous optimizer revision is available' };
            return;
        }
        const snapshot = storage.kv.get(`pool:${previous}`);
        if (!snapshot || !Array.isArray(snapshot.entries) || typeof snapshot.checksum !== 'string') {
            result = { ok: false, status: 500, error: 'Previous optimizer snapshot is unavailable' };
            return;
        }

        const addTxt = snapshot.entries.map(({ address, name }) => `${address}:443#${name}`).join('\n') + '\n';
        storage.kv.put('previous', current);
        storage.kv.put('current', previous);
        storage.kv.put('add_txt', addTxt);
        storage.kv.put('status', {
            mutation: 'rollback',
            at: now,
            revision: previous,
            previous: current,
            checksum: snapshot.checksum,
        });
        result = {
            ok: true,
            revision: previous,
            checksum: snapshot.checksum,
            previous: current,
            snapshot,
            add_txt: addTxt,
        };
    });
    return result;
}

export function readAuthoritativePoolStatus(storage) {
    return {
        current: storage.kv.get('current') ?? null,
        previous: storage.kv.get('previous') ?? null,
        status: storage.kv.get('status') ?? null,
    };
}

export function readAuthoritativeAddTxt(storage) {
    return storage.kv.get('manual_add_txt') ?? storage.kv.get('add_txt') ?? null;
}
