import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../server/lib/protocol.js', import.meta.url), 'utf8');
const joinStart = source.indexOf("case 'join_channel':");
const joinEnd = source.indexOf("case 'ptt_audio_start':", joinStart);
const join = source.slice(joinStart, joinEnd);

test('every async join phase is followed by a generation guard before room mutation', () => {
    assert.ok(joinStart >= 0 && joinEnd > joinStart, 'join_channel handler was not found');

    const firstMutation = join.indexOf('channelRooms.get(data.new_channel_slug).add(ws)');
    assert.ok(firstMutation >= 0, 'room mutation was not found');

    for (const awaitExpression of [
        'await channelPermission(',
        'await redisClient.sMembers(`speakers:',
        'await redisClient.sMembers(`video:',
    ]) {
        const at = join.indexOf(awaitExpression);
        assert.ok(at >= 0, `${awaitExpression} was not found`);
        const guard = join.indexOf('if (ws.channelJoinGeneration !== joinGeneration) break;', at);
        assert.ok(guard > at && guard < firstMutation,
            `${awaitExpression} can reach room mutation without a generation guard`);
    }
});

test('a stale join cannot announce success after its database transaction', () => {
    const commit = join.indexOf("await client.query('COMMIT')");
    const staleGuard = join.indexOf('if (ws.channelJoinGeneration !== joinGeneration)', commit);
    const success = join.indexOf("type: 'join_channel_success'", commit);

    assert.ok(commit >= 0, 'join transaction commit was not found');
    assert.ok(staleGuard > commit && staleGuard < success,
        'stale join can announce success after a later join supersedes it');
    assert.match(join.slice(staleGuard, success),
        /channelRooms\.get\(data\.new_channel_slug\)\?\.delete\(ws\)/,
        'stale in-memory room membership is not removed');
});
