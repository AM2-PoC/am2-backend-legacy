// The parts of the source and the rendered markup that are load-bearing.
//
// Dispatch in this codebase is by form field name, not by route: a page runs a
// branch because a POST field is present. Renaming a submit button therefore
// disables a feature silently, with no error and no visible change. These
// assertions make that loud.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, get, readSrc, SERVER_JS } from './helpers.mjs';
import fs from 'node:fs';

let sup;
before(async () => { sup = await asSuper(); });

describe('form field names are the API', () => {
    // Dispatch fields that come from a real form control. Both ends must exist:
    // the PHP branch reading $_POST['x'] and the markup emitting name="x".
    // Asserting only one end lets a rename of the other pass unnoticed.
    const submitted = {
        'users.php':        ['add_user', 'edit_user'],
        'channels.php':     ['add_channel', 'save_channel_access', 'edit_channel'],
        'user_access.php':  ['update_multi_access'],
        'admin_panel.php':  ['save_admin', 'update_delegation'],
        'settings.php':     ['update_password', 'export_db', 'import_db', 'upload_apk'],
    };

    // Dispatch fields appended to a FormData in JS. There is no name= for these,
    // so the second end to check is the append call.
    const scripted = {
        'users.php': ['save_user_channels', 'update_feature'],
    };

    for (const [file, names] of Object.entries(submitted)) {
        test(`${file} still dispatches on ${names.join(', ')}`, () => {
            const src = readSrc(file);
            for (const n of names) {
                assert.ok(src.includes(`'${n}'`),
                    `${file}: PHP no longer reads the field ${n}`);
                assert.ok(new RegExp(`name=["']${n}["']`).test(src),
                    `${file}: no form control is named ${n}`);
            }
        });
    }

    for (const [file, names] of Object.entries(scripted)) {
        test(`${file} still posts ${names.join(', ')} from script`, () => {
            const src = readSrc(file);
            for (const n of names) {
                assert.ok(src.includes(`'${n}'`),
                    `${file}: PHP no longer reads the field ${n}`);
                assert.ok(new RegExp(`append\\(\\s*['"\`]${n}['"\`]`).test(src),
                    `${file}: nothing appends ${n} to a FormData — the branch is now unreachable`);
            }
        });
    }

    test('user_access.php dispatches force-logout on a field value, not a field name', () => {
        // fd.append('action', 'db_force_logout') — the name is `action` and the
        // branch is selected by the value, unlike everywhere else in the panel.
        const src = readSrc('user_access.php');
        assert.ok(src.includes("'db_force_logout'"), 'PHP no longer compares against the value');
        assert.ok(/append\(\s*['"`]action['"`]\s*,\s*['"`]db_force_logout['"`]/.test(src),
            'nothing posts action=db_force_logout — the branch is unreachable');
    });

    test('array-shaped fields keep their bracket syntax', () => {
        assert.match(readSrc('channels.php'), /name=["']users\[\]["']/);
        assert.match(readSrc('user_access.php'), /name=["']channels\[\]["']/);
        // permissions[<channelId>] is a keyed array, read as $permissions_input[$ch_id].
        assert.match(readSrc('user_access.php'), /name=["']permissions\[/);
        assert.match(readSrc('admin_panel.php'), /name=["']channels\[\]["']/);
    });

    test('GET dispatch parameters survive', () => {
        assert.match(readSrc('users.php'), /\$_GET\['get_user_channels'\]/);
        assert.match(readSrc('users.php'), /\$_GET\['delete'\]/);
        assert.match(readSrc('channels.php'), /ajax_action/);
        assert.match(readSrc('channels.php'), /\$_GET\['delete'\]/);
        assert.match(readSrc('admin_panel.php'), /\$_GET\['delete_id'\]/);
        assert.match(readSrc('user_access.php'), /db_force_logout/);
    });
});

describe('the node relay contract', () => {
    const src = fs.readFileSync(SERVER_JS, 'utf8');

    test('every admin route still exists', () => {
        for (const r of ['set-app-version', 'sync-channels', 'refresh-branch-permissions',
                         'update-user-profile', 'update-channel', 'assign-channel',
                         'remove-channel', 'update-permissions', 'set-permission',
                         'force-logout']) {
            assert.ok(src.includes(`/api/admin/${r}`), `route ${r} disappeared`);
        }
        assert.ok(src.includes('/api/check-update'));
    });

    test('websocket message types the field app depends on still exist', () => {
        for (const t of ['login_success', 'login_error', 'channels_updated', 'permission_update',
                         'users_online', 'join_channel_success', 'ptt_active_status', 'ptt_error',
                         'video_stream_status', 'ptp_invitation', 'ptp_confirmed', 'ptp_failed',
                         'ptp_cancelled', 'force_logout', 'user_profile_update']) {
            assert.ok(src.includes(`'${t}'`) || src.includes(`"${t}"`),
                `server -> client message type ${t} disappeared`);
        }
        for (const t of ['app_login', 'update_location', 'join_channel', 'ptt_audio_start',
                         'ptt_audio_end', 'ptt_video_start', 'ptt_video_end', 'request_ptp',
                         'accept_ptp', 'cancel_ptp']) {
            assert.ok(src.includes(`'${t}'`) || src.includes(`"${t}"`),
                `client -> server message type ${t} disappeared`);
        }
    });

    test('binary frame tags stay 1 for audio and 2 for video', () => {
        assert.match(src, /binaryType\s*===?\s*1|message\[0\]\s*===?\s*1/);
        assert.match(src, /binaryType\s*===?\s*2|message\[0\]\s*===?\s*2/);
    });
});

describe('rendered markup that the CSS and JS depend on', () => {
    // Below 768px the stylesheet turns table rows into cards using
    // content: attr(data-label). A cell without one renders as an unlabelled
    // value on a phone, which is the primary device for this panel.
    const pages = ['/users.php', '/channels.php', '/user_access.php', '/admin_panel.php'];

    for (const p of pages) {
        test(`${p} labels every data cell`, async () => {
            const html = await (await get(p, sup)).text();
            const table = html.match(/<table[\s\S]*?<\/table>/g) ?? [];
            assert.ok(table.length, `${p} rendered no table`);
            let cells = 0, unlabelled = 0;
            for (const t of table) {
                for (const td of t.match(/<td\b[^>]*>/g) ?? []) {
                    cells++;
                    if (!/data-label=/.test(td) && !/colspan=/i.test(td)) unlabelled++;
                }
            }
            assert.ok(cells > 0, `${p} rendered no cells`);
            assert.equal(unlabelled, 0, `${p} has ${unlabelled}/${cells} cells without data-label`);
        });
    }

    test('user_access.php keeps the id families queried by prefix selector', async () => {
        const html = await (await get('/user_access.php', sup)).text();
        // querySelectorAll('[id^="def_label_"]') makes the naming convention itself an API.
        for (const prefix of ['check_', 'item_', 'def_label_', 'rx_']) {
            assert.match(html, new RegExp(`id=["']${prefix}\\d+`),
                `no element matching id^="${prefix}" — the prefix selector will find nothing`);
        }
    });

    test('livetrack.php keeps the class names leaflet uses as divIcon markers', async () => {
        const html = await (await get('/livetrack.php', sup)).text();
        for (const c of ['custom-marker', 'speaking-marker', 'marker-label', 'pulse-dot']) {
            assert.ok(html.includes(c), `${c} is a divIcon className, not styling — markers break without it`);
        }
        for (const id of ['map', 'unitList', 'unitSearch', 'tx-indicator', 'count-online']) {
            assert.match(html, new RegExp(`id=["']${id}["']`), `#${id} missing`);
        }
    });

    test('logs.php keeps the ids its polling loop writes into', async () => {
        const html = await (await get('/logs.php', sup)).text();
        for (const id of ['log-table-body', 'logSearchInput', 'last-update-time',
                          'btn-all', 'btn-ptt', 'btn-adm']) {
            assert.match(html, new RegExp(`id=["']${id}["']`), `#${id} missing`);
        }
    });

    test('every page still loads the shared stylesheet', async () => {
        for (const p of ['/dashboard.php', '/users.php', '/channels.php', '/logs.php',
                         '/settings.php', '/user_access.php', '/livetrack.php', '/admin_panel.php']) {
            const html = await (await get(p, sup)).text();
            assert.ok(html.includes('asset/css/am2-ui.css'), `${p} lost the stylesheet`);
        }
    });
});
