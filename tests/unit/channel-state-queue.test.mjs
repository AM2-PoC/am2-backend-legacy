import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { serializeChannelState } = createRequire(import.meta.url)('../../server/lib/state');

test('channel state work is serialized per socket and continues after failure', async () => {
    const ws = {};
    const events = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const first = serializeChannelState(ws, async () => {
        events.push('first:start');
        await gate;
        events.push('first:end');
        throw new Error('expected');
    });
    const second = serializeChannelState(ws, async () => events.push('second'));

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['first:start']);
    release();
    await assert.rejects(first, /expected/);
    await second;
    assert.deepEqual(events, ['first:start', 'first:end', 'second']);
});
