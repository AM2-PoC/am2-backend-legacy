import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    disconnectRecord,
    markCloseCause,
} from '../../server/lib/disconnect-observability.js';

describe('disconnect observability behavior', () => {
    test('classifies normal and abnormal peer closes without inventing a network cause', () => {
        const normal = disconnectRecord({
            disconnectUserId: 'A71',
            closeCause: null,
            connectedAtNs: 1_000_000_000n,
        }, 1000, 11_900_000_000n);
        assert.equal(normal,
            'event=client_disconnect user=A71 cause=peer_close code=1000 held_seconds=10');

        const abnormal = disconnectRecord({
            disconnectUserId: 'A71',
            closeCause: null,
            connectedAtNs: 1_000_000_000n,
        }, 1006, 11_900_000_000n);
        assert.equal(abnormal,
            'event=client_disconnect user=A71 cause=abnormal_close code=1006 held_seconds=10');
    });

    test('preserves a known server-side cause and sanitizes the identity token', () => {
        const ws = {
            disconnectUserId: 'A71\nevent=forged',
            closeCause: null,
            connectedAtNs: 5_000_000_000n,
        };
        markCloseCause(ws, 'ping_timeout');
        const record = disconnectRecord(ws, 1006, 8_900_000_000n);
        assert.equal(record,
            'event=client_disconnect user=A71_event_forged cause=ping_timeout code=1006 held_seconds=3');
        assert.equal(record.split('\n').length, 1);
    });

    test('does not log public unauthenticated probes', () => {
        assert.equal(disconnectRecord({
            disconnectUserId: null,
            closeCause: null,
            connectedAtNs: 0n,
        }, 1006, 5_000_000_000n), null);
    });

    test('fails closed on an unsupported internal cause', () => {
        assert.throws(() => markCloseCause({}, 'anything supplied at runtime'),
            /unsupported WebSocket close cause/);
    });
});
