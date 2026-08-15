function normalizeExpected(value) {
    return value === undefined ? null : value;
}

function normalizeLegacyManualAddTxt(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

export function publishAuthoritativePool(storage, request, legacyManualAddTxt = null) {
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
        const legacyManual = normalizeLegacyManualAddTxt(legacyManualAddTxt);
        const manualInitialized = storage.kv.get('manual_add_initialized') === true;
        if (!current && legacyManual && !manualInitialized) {
            storage.kv.put('manual_add_initialized', true);
            if (!storage.kv.get('manual_add_txt')) storage.kv.put('manual_add_txt', legacyManual);
        }
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

export function resetAuthoritativePoolToEmpty(storage, expectedCurrentRevision, now = new Date().toISOString()) {
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
        if (previous) {
            result = { ok: false, status: 409, error: 'Previous optimizer revision exists; use rollback' };
            return;
        }

        storage.kv.delete('current');
        storage.kv.delete('previous');
        storage.kv.delete('add_txt');
        storage.kv.put('status', {
            mutation: 'reset_empty',
            at: now,
            revision: null,
            previous: current,
            checksum: null,
        });
        result = {
            ok: true,
            revision: null,
            checksum: null,
            previous: current,
            snapshot: null,
            add_txt: null,
        };
    });
    return result;
}

export function setManualAuthoritativeAddTxt(storage, value) {
    const text = typeof value === 'string' ? value : '';
    storage.transactionSync(() => {
        storage.kv.put('manual_add_initialized', true);
        if (text.trim()) storage.kv.put('manual_add_txt', text);
        else storage.kv.delete('manual_add_txt');
    });
    return readAuthoritativeAddTxt(storage);
}

export function readAuthoritativePoolStatus(storage) {
    return {
        current: storage.kv.get('current') ?? null,
        previous: storage.kv.get('previous') ?? null,
        status: storage.kv.get('status') ?? null,
    };
}

export function readAuthoritativeAddState(storage) {
    const manualAddTxt = storage.kv.get('manual_add_txt');
    const optimizerAddTxt = storage.kv.get('add_txt');
    const current = storage.kv.get('current') ?? null;
    const initialized = storage.kv.get('manual_add_initialized') === true
        || current !== null
        || manualAddTxt !== undefined
        || optimizerAddTxt !== undefined;
    const source = manualAddTxt !== undefined
        ? 'manual'
        : optimizerAddTxt !== undefined || current !== null
            ? 'optimizer'
            : 'none';

    return {
        initialized,
        add_txt: manualAddTxt ?? optimizerAddTxt ?? null,
        source,
    };
}

export function readAuthoritativeAddTxt(storage) {
    return readAuthoritativeAddState(storage).add_txt;
}
