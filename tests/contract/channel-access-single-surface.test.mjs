// Channel access is granted on one screen, not two.
//
// users.php carried a second channel picker beside the one on
// user_access.php, and it silently revoked. Its checkboxes were never filled
// from what the unit already held -- worse, opening it ran
//
//     document.querySelectorAll('[data-channel-pick]').forEach(c => c.checked = false)
//
// so the dialogue actively cleared itself. The save then sent the ticked boxes
// as the complete new set, and am2_set_user_channels deletes whatever is not
// in that set. Tick one channel, lose the rest.
//
// The production log caught it happening, twice, on the same unit:
//
//     08:27  access.update  [ODIE COMMUNICATION]
//     08:33  access.revoke  ()                          <- wiped
//     08:33  access.update  [ODIE COMMUNICATION]        <- put back
//     08:34  access.update  [AM², ODIE COMMUNICATION]
//     07:13  access.update  [ODIE COMMUNICATION]        <- AM² gone again
//     10:06  access.update  [AM², ODIE COMMUNICATION]   <- put back again
//
// A per-unit prefill was not the fix: the same dialogue is a bulk action over
// a selection, and there is no single unit whose channels it could show. Two
// screens for one decision is the defect. user_access.php renders current
// state from the server on every open and stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const users = readFileSync(new URL('../../WebAdmin/users.php', import.meta.url), 'utf8');
const access = readFileSync(new URL('../../WebAdmin/user_access.php', import.meta.url), 'utf8');

test('users.php no longer grants channels', () => {
    for (const marker of ['data-channel-pick', 'data-channels-apply', 'save_user_channels']) {
        assert.ok(
            !users.includes(marker),
            `users.php still carries ${marker}: a second channel picker that replaces the whole set`,
        );
    }
});

test('users.php has no unreachable channel endpoint left behind', () => {
    assert.ok(
        !users.includes("get_user_channels"),
        'users.php kept an endpoint nothing calls; it was written and never wired, '
        + 'which is how the dialogue ended up reading no state at all',
    );
});

test('the surviving surface paints current state when it opens', () => {
    assert.ok(access.includes('data-state'), 'user_access.php must render current access from the server');
    assert.ok(access.includes('m.ids = new Set('), 'user_access.php must seed the dialogue from that state');
    assert.ok(access.includes('paintAccess()'), 'user_access.php must paint the controls from the seeded state');
});

test('units reach channel access from the unit list', () => {
    assert.ok(
        users.includes('user_access.php'),
        'users.php must link to the surface that grants channels, or the action simply disappears',
    );
});
