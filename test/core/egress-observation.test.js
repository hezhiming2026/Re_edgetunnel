import test from 'node:test';
import assert from 'node:assert/strict';
import { createEgressObserver } from '../../src/ops/egress-diagnostics.js';

function harness() {
    let clock = 0;
    let scheduled = null;
    const events = [];
    const observer = createEgressObserver({
        targetKey: 'target-a',
        now: () => clock,
        timeoutMs: 8000,
        record: (event) => events.push(event),
        setTimer: (fn) => { scheduled = fn; return 1; },
        clearTimer: () => { scheduled = null; },
    });
    return {
        observer,
        events,
        advance(ms) { clock += ms; },
        hasTimer() { return scheduled !== null; },
        fireTimer() { const fn = scheduled; scheduled = null; fn?.(); },
    };
}

test('records direct open and first byte with bounded metadata only', () => {
    const h = harness();
    h.observer.openOk();
    h.observer.clientData(517);
    h.advance(25);
    h.observer.firstByte();

    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_first_byte_ok', elapsedMs: 25 },
    ]);
    for (const event of h.events) {
        assert.deepEqual(Object.keys(event).sort(), ['elapsedMs', 'event', 'targetKey']);
    }
});

test('direct open and empty client data do not arm first-byte timer', () => {
    const h = harness();
    h.observer.openOk();
    h.observer.clientData(0);
    h.advance(9000);
    h.fireTimer();

    assert.equal(h.hasTimer(), false);
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
    ]);
});

test('later nonempty client payload arms timer after zero-payload handshake', () => {
    const h = harness();
    h.observer.openOk();
    h.advance(2500);
    assert.equal(h.hasTimer(), false);

    h.observer.clientData(128);
    assert.equal(h.hasTimer(), true);
    h.advance(8000);
    h.fireTimer();

    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_first_byte_timeout', elapsedMs: 10500 },
    ]);
});

test('records direct open error as terminal event', () => {
    const h = harness();
    h.advance(12);
    h.observer.openError(new Error('ignored detail'));
    h.observer.clientData(10);
    h.observer.firstByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_error', elapsedMs: 12 },
    ]);
});

test('records close before first byte', () => {
    const h = harness();
    h.observer.openOk();
    h.observer.clientData(32);
    h.advance(40);
    h.observer.closedBeforeByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_closed_before_byte', elapsedMs: 40 },
    ]);
});

test('records timeout 8000 ms after first nonempty client payload without route behavior', () => {
    const h = harness();
    h.observer.openOk();
    h.advance(700);
    h.observer.clientData(64);
    h.advance(8000);
    h.fireTimer();
    h.observer.firstByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_first_byte_timeout', elapsedMs: 8700 },
    ]);
});
