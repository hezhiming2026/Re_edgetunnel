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
        fireTimer() { const fn = scheduled; scheduled = null; fn?.(); },
    };
}

test('records direct open and first byte with bounded metadata only', () => {
    const h = harness();
    h.observer.openOk();
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

test('records direct open error as terminal event', () => {
    const h = harness();
    h.advance(12);
    h.observer.openError(new Error('ignored detail'));
    h.observer.firstByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_error', elapsedMs: 12 },
    ]);
});

test('records close before first byte', () => {
    const h = harness();
    h.observer.openOk();
    h.advance(40);
    h.observer.closedBeforeByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_closed_before_byte', elapsedMs: 40 },
    ]);
});

test('records timeout after 8000 ms without invoking route behavior', () => {
    const h = harness();
    h.observer.openOk();
    h.advance(8000);
    h.fireTimer();
    h.observer.firstByte();
    assert.deepEqual(h.events, [
        { targetKey: 'target-a', event: 'direct_open_ok', elapsedMs: 0 },
        { targetKey: 'target-a', event: 'direct_first_byte_timeout', elapsedMs: 8000 },
    ]);
});
