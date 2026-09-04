// The parts of the source and the rendered markup that are load-bearing.
//
// Dispatch in this codebase is by form field name, not by route: a page runs a
// branch because a POST field is present. Renaming a submit button therefore
// disables a feature silently, with no error and no visible change. These
// assertions make that loud.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, get, readSrc, SRC, serverSrc, SERVER_JS } from './helpers.mjs';
import fs from 'node:fs';
import path from 'node:path';

let sup;
before(async () => { sup = await asSuper(); });

describe('form field names are the API', () => {
    // Dispatch fields that come from a real form control. Both ends must exist:
    // the PHP branch reading $_POST['x'] and the markup emitting name="x".
    // Asserting only one end lets a rename of the other pass unnoticed.
    const submitted = {
        'users.php':        ['add_user', 'edit_user'],
        'channels.php':     ['add_channel', 'edit_channel', 'delete_channel'],
        'user_access.php':  ['update_multi_access'],
        'admin_panel.php':  ['save_admin', 'update_delegation'],
        // `upload_apk` was here. The APK upload path is gone: the panel writes
        // no uploaded file to disk at all now, and its absence is asserted by
        // update-channel-surface.test.mjs.
        'settings.php':     ['update_password', 'export_db', 'import_db'],
    };

    // Dispatch fields appended to a FormData in JS. There is no name= for these,
    // so the second end to check is the append call.
    const scripted = {
        // `save_user_channels` was here and is deliberately gone. It backed a
        // second channel picker on this page whose checkboxes opened cleared,
        // so granting one channel revoked the rest -- the production log caught
        // it twice on one unit. Channel access is decided on user_access.php,
        // which paints current state before anyone changes it.
        'users.php': ['update_feature'],
        // The access roster left the form when the page moved onto the shared
        // table frame: one dialogue now serves a single channel and a
        // selection, and a selection cannot be a form submit. Same field name,
        // same PHP branch, different end to check.
        'channels.php': ['save_channel_access', 'export_selected'],
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
                // Either an explicit append or an object key handed to a
                // helper that appends. What matters is that the literal field
                // name still appears in the code that builds the request, so
                // renaming one side of the pair breaks this.
                // append(), the local add() that wraps it, or an object key
                // handed to a helper that appends. An export answers with a
                // file, so it is built as a real form and never touches
                // FormData -- pinning only append() would have left that
                // branch unpinned.
                const built = new RegExp(
                    `(?:append|add)\\(\\s*['"\`]${n}['"\`]|['"\`]?${n}['"\`]?\\s*:`).test(src);
                assert.ok(built,
                    `${file}: nothing posts ${n} — the branch is now unreachable`);
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
        // channels.php builds its unit list in the browser, so the bracket
        // lives in the object handed to the request rather than in a name=
        // attribute. Same field, same PHP branch reading $_POST['users'],
        // different end to check.
        assert.match(readSrc('channels.php'), /['"`]users\[\]['"`]\s*:/);
        assert.match(readSrc('user_access.php'), /name=["']channels\[\]["']/);
        // permissions[<channelId>] is a keyed array, read as $permissions_input[$ch_id].
        assert.match(readSrc('user_access.php'), /name=["']permissions\[/);
        assert.match(readSrc('admin_panel.php'), /name=["']channels\[\]["']/);
    });

    test('GET dispatch parameters survive', () => {
        // users.php had a get_user_channels branch asserted here. Nothing in
        // the page ever called it -- it was written and never wired -- and the
        // dialogue it should have filled read no state at all. Removed with the
        // dialogue; api_users.php serves the Admin APK and is unaffected.
        assert.match(readSrc('channels.php'), /ajax_action/);
        assert.match(readSrc('user_access.php'), /db_force_logout/);
    });

    test('deleting is a POST, not a link', () => {
        // Moved off GET deliberately: a link that deletes can be followed by a
        // prefetch or a crawler, and the only guard was a client-side confirm().
        // These are panel-internal, so no external client is affected.
        assert.match(readSrc('users.php'), /\$_POST\['delete_user'\]/);
        assert.match(readSrc('channels.php'), /\$_POST\['delete_channel'\]/);
        assert.match(readSrc('admin_panel.php'), /\$_POST\['delete_admin_id'\]/);
        for (const f of ['users.php', 'channels.php', 'admin_panel.php']) {
            assert.ok(!/href="\?delete/.test(readSrc(f)), `${f} still deletes via a link`);
        }
    });
});

describe('the node relay contract', () => {
    const src = serverSrc();

    test('every admin route still exists', () => {
        for (const r of ['sync-channels', 'refresh-branch-permissions',
                         'update-permissions', 'force-logout']) {
            assert.ok(src.includes(`/api/admin/${r}`), `route ${r} disappeared`);
        }
        assert.ok(src.includes('/api/check-update'));
    });

    test('the admin routes nothing called stay gone', () => {
        // Ten routes were reachable from the internet with no credential. A key
        // now gates them and the six nothing called were removed outright --
        // an unused write path is a hole with no upside. Asserted by absence so
        // one cannot drift back in behind the key.
        //
        // Comments stripped first: two of the removed names survive in prose
        // explaining why the live-push they drove no longer happens, and a
        // guard that trips on its own explanation is one people route around.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        for (const r of ['set-app-version', 'update-user-profile', 'update-channel',
                         'assign-channel', 'remove-channel', 'set-permission']) {
            assert.ok(!code.includes(`/api/admin/${r}`),
                `route ${r} is back; it was removed as an uncalled write path`);
        }
    });

    test('the relay console speaks English', () => {
        // Scoped to console.* lines, which end up in journalctl and are read by
        // whoever is holding the server, not by anyone holding a radio. Code
        // comments are not in scope -- protocol.js and routes.js still narrate
        // their own logic in Indonesian, which nobody but the next reader sees.
        const src = serverSrc();
        const words = /\b(yang|dan|atau|tidak|sudah|telah|akan|dengan|untuk|dari|harap|gagal|berhasil|diperbarui|dikeluarkan|instansi|salah|nonaktif|kembali|masa aktif)\b/i;

        const bad = [];
        for (const m of src.matchAll(/console\.(log|error|warn)\([^)]*\)/g)) {
            if (words.test(m[0])) bad.push(m[0].slice(0, 70));
        }

        assert.deepEqual(bad, [],
            `Indonesian text reached a console line:\n${bad.join('\n')}`);
    });

    test('every operator-facing message is one we chose', () => {
        /*
         * This half used to demand English on the wire, and the wire never
         * complied: `data.message` is displayed verbatim by the handset, whose
         * own fallback for a missing one is "Permintaan Gagal". Two strings
         * were English and six Indonesian, from the same handlers, under a test
         * that had been red for weeks.
         *
         * The strings now live in server/lib/messages.js, so this pins an
         * object rather than scanning for a language -- a scan is exactly how
         * six of them sat there unnoticed. A new message fails here, which is
         * the moment to decide what it says.
         */
        const catalogue = fs.readFileSync(
            path.join(path.dirname(SERVER_JS), 'lib', 'messages.js'), 'utf8');
        const strings = [...catalogue.matchAll(/^\s{4}[A-Z_]+:\s*'([^']+)'/gm)].map((m) => m[1]);

        assert.deepEqual(strings.sort(), [
            'Bukan anggota channel ini',
            'Panggilan privat tidak tersedia',
            'Panggilan privat tidak tersedia untuk personel ini',
            'Panggilan video privat tidak tersedia',
            'Panggilan video privat tidak tersedia untuk personel ini',
            'Personel sedang dalam panggilan lain',
            'Personel sedang offline',
            // Moved out of protocol.js, where it was written inline and in
            // English beside handlers that answered in Indonesian.
            'Status login berubah. Silakan masuk lagi.',
            'Tidak ada undangan panggilan yang menunggu',
        ], 'an operator-facing message changed; decide what it says, then pin it here');
    });

    test('operator-facing messages are not written inline', () => {
        // The catalogue only helps while it is the only place they live. One
        // sentence used to appear three times in protocol.js, and two copies
        // drifted into another language before anyone noticed.
        const protocol = fs.readFileSync(
            path.join(path.dirname(SERVER_JS), 'lib', 'protocol.js'), 'utf8');
        const inline = [...protocol.matchAll(/message:\s*'([^']+)'/g)].map((m) => m[1]);

        assert.deepEqual(inline, [],
            `these belong in lib/messages.js:\n${inline.join('\n')}`);
    });

    test('the relay stays split by concern', () => {
        // 1048 lines held the protocol, the state, the database and the
        // routes. Each of those grew into the others because there was no
        // edge to stop at; this is the edge.
        const wiring = fs.readFileSync(SERVER_JS, 'utf8');

        assert.ok(!/app\.(get|post|put|delete)\s*\(/.test(wiring),
            'a route handler is back in server.js — endpoints belong in lib/routes.js');
        assert.ok(!/wss\.on\s*\(\s*['"`]connection/.test(wiring),
            'the connection handler is back in server.js — the protocol belongs in lib/protocol.js');
        assert.ok(!/new Pool\s*\(/.test(wiring),
            'the pool is back in server.js — persistence belongs in lib/db.js');
        assert.ok(!/new Map\s*\(\)/.test(wiring),
            'in-process state is back in server.js — it belongs in lib/state.js');

        // Wiring only: requiring, mounting, listening.
        const lines = wiring.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
        assert.ok(lines < 200,
            `server.js is ${lines} lines of code; it is meant to be wiring, not a place to put things`);
    });

    test('websocket message types the field app depends on still exist', () => {
        // `user_profile_update` was here. It was the only thing
        // /api/admin/update-user-profile emitted, and that route went with the
        // five other uncalled write paths, so nothing can produce the message
        // any more.
        for (const t of ['login_success', 'login_error', 'channels_updated', 'permission_update',
                         'users_online', 'join_channel_success', 'ptt_active_status', 'ptt_error',
                         'video_stream_status', 'ptp_invitation', 'ptp_confirmed', 'ptp_failed',
                         'ptp_cancelled', 'force_logout']) {
            assert.ok(src.includes(`'${t}'`) || src.includes(`"${t}"`),
                `server -> client message type ${t} disappeared`);
        }
        for (const t of ['app_login', 'update_location', 'join_channel', 'ptt_audio_start',
                         'ptt_audio_end', 'ptt_video_start', 'ptt_video_end', 'request_ptp',
                         'accept_ptp', 'cancel_ptp']) {
            assert.ok(src.includes(`'${t}'`) || src.includes(`"${t}"`),
                `client -> server message type ${t} disappeared`);
        }
        assert.match(src,
            /WHERE\s+LOWER\(u\.id\)\s*=\s*LOWER\(\$1\)\s+OR\s+UPPER\(u\.name\)\s*=\s*UPPER\(\$1\)/s,
            'Client uppercases the login identity, but relay user-id lookup remains case-sensitive');
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
        for (const c of ['custom-marker', 'marker-label', 'pulse-dot']) {
            assert.ok(html.includes(c), `${c} is a divIcon className, not styling — markers break without it`);
        }
        const model = fs.readFileSync(`${SRC}/asset/js/src/livetrack-model.js`, 'utf8');
        assert.match(model, /`entity-\$\{entityType\}`/,
            'the presentation model no longer emits an identity class');
        assert.match(model, /`freshness-\$\{freshness\}`/,
            'the presentation model no longer emits a freshness class');
        assert.ok(model.includes('speaking-marker'),
            'the presentation model no longer emits the TX class');
        for (const id of ['map', 'unitList', 'unitSearch', 'tx-indicator', 'count-online',
                          'count-fresh', 'feed-status']) {
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

describe('untrusted text is not rendered as markup', () => {
    test('logs.php never builds markup from a log field', () => {
        // keterangan is free text an admin typed, and a database trigger also
        // writes it. The page renders through x-text now, which escapes, so the
        // stronger property to hold is that no HTML is assembled from these
        // values at all: no innerHTML, no template literal, and no manual
        // escaper anyone can forget to call.
        const src = readSrc('logs.php');
        // Assignment, not the word: a comment explaining why it is absent is not a use.
        assert.ok(!/\binnerHTML\s*=/.test(src), 'log rows must not be assigned as HTML');
        const interpolated = [...src.matchAll(/\$\{\s*(?:row|log)\.[a-z_]+/g)].map((m) => m[0]);
        assert.deepEqual(interpolated, [],
            `log fields interpolated into a string: ${interpolated.join(', ')}`);
        // Mechanism-agnostic: Alpine's x-text and a textContent assignment are
        // both fine, and pinning the test to one of them made it fail the
        // moment the page stopped using Alpine rather than when it stopped
        // being safe.
        assert.ok(!/\b(?:outerHTML\s*=|insertAdjacentHTML)/.test(src),
            'log rows must not be inserted as markup');
        assert.match(src, /x-text="row\.target"|textContent\s*=\s*(?:r|row)\.target/,
            'the detail column must reach the DOM as text');
    });

    test('livetrack.php does not build a handler argument from a raw id', () => {
        const src = readSrc('livetrack.php');
        assert.ok(!/gotoUnit\(\$\{u\.lat\}, \$\{u\.lng\}, '\$\{u\.id\}'\)/.test(src),
            "an id containing a quote used to break out of the onclick attribute");
    });

    test('no page echoes exception text', () => {
        for (const f of ['users.php', 'channels.php', 'settings.php', 'admin_panel.php',
                         'user_access.php', 'dashboard.php', 'api_users.php',
                         'api_channels.php', 'api_settings.php', 'api_login.php']) {
            const src = readSrc(f);
            for (const line of src.split('\n')) {
                if (line.includes('error_log')) continue;
                assert.ok(!line.includes('$e->getMessage()'),
                    `${f} still echoes PDO exception text, which carries the failing SQL`);
            }
        }
    });
});

describe('one shared guard, not ten copies', () => {
    test('no page hand-rolls the session check', () => {
        for (const f of ['dashboard.php', 'users.php', 'channels.php', 'logs.php',
                         'settings.php', 'user_access.php', 'livetrack.php', 'admin_panel.php']) {
            const src = readSrc(f);
            assert.match(src, /require_once 'auth\.php'/, `${f} does not use the shared guard`);
            assert.ok(!/header\("Location: login\.php"\)/.test(src),
                `${f} still redirects to login itself`);
        }
    });

    test('auth.php runs before config.php', () => {
        // config.php expires idle sessions and checks the CSRF token, both of
        // which need a started session. livetrack.php used to load it first.
        for (const f of ['dashboard.php', 'users.php', 'livetrack.php', 'admin_panel.php']) {
            const src = readSrc(f);
            assert.ok(src.indexOf("auth.php") < src.indexOf("config.php"),
                `${f} loads config.php before the session exists`);
        }
    });
});

describe('one relay client, not eleven copies', () => {
    const HELPERS = ['syncUserChannels', 'notifyPermissionUpdate',
                     'notifyForceLogout', 'notifyNodeServerToRefresh'];

    test('only node_client.php defines the relay helpers', () => {
        for (const f of ['users.php', 'channels.php', 'user_access.php', 'admin_panel.php',
                         'api_users.php', 'api_channels.php', 'api_user_access.php']) {
            const src = readSrc(f);
            for (const h of HELPERS) {
                assert.ok(!new RegExp(`function\\s+${h}\\s*\\(`).test(src),
                    `${f} redefines ${h}; the copies drifted last time`);
            }
        }
        const client = readSrc('node_client.php');
        for (const h of HELPERS) {
            assert.match(client, new RegExp(`function\\s+${h}\\s*\\(`));
        }
    });

    test('every relay call carries the api key', () => {
        // Three of the six old syncUserChannels copies omitted it, so channel
        // sync would have failed silently the moment enforcement was turned on.
        const client = readSrc('node_client.php');
        const calls = (client.match(/am2_node_call\(/g) ?? []).length;
        assert.ok(calls >= 4, 'each helper should route through the one transport');
        // Count the calls that actually send, not the feature probe:
        // function_exists('curl_init') mentions the name without using it.
        assert.equal((client.match(/@curl_exec\(/g) ?? []).length, 1);
        assert.equal((client.match(/@file_get_contents\(/g) ?? []).length, 1);
        assert.match(client, /am2_node_auth_header\(\)/);
    });

    test('the duplex fallback is the restrictive one', () => {
        // The two old copies disagreed: FULL in users.php, HALF in api_users.php.
        assert.match(readSrc('node_client.php'),
            /\$duplex = 'HALF DUPLEX'/,
            'the fallback must match the column default');
    });
});

describe('alpine expressions in attributes', () => {
    // json_encode emits double quotes, which terminate the attribute they sit
    // in. The tag then parses as garbage and Alpine throws — and a server
    // rendered fallback keeps the element looking correct, so it survives a
    // screenshot review. js() escapes the quotes; json_encode stays correct
    // inside a <script> block.
    // Detected, not listed: a hand-written list silently stops covering the
    // next page that migrates, which is exactly how this slipped through once.
    const MIGRATED = ['login.php', 'partials/shell.php', 'partials/shell_end.php'].concat(
        fs.readdirSync(SRC)
          .filter((f) => f.endsWith('.php'))
          .filter((f) => /include\s+'partials\/shell\.php'/.test(readSrc(f)))
    );

    for (const f of MIGRATED) {
        test(`${f} does not put raw json_encode in an attribute`, () => {
            const src = readSrc(f);
            const withoutScripts = src.replace(/<script[\s\S]*?<\/script>/g, '');
            const bad = [...withoutScripts.matchAll(/<\?=\s*json_encode\(t\(/g)];
            assert.equal(bad.length, 0,
                `${f}: use js('key') in attributes; json_encode belongs in <script>`);
        });
    }

    // This guard has caught the json_encode-in-an-attribute bug three times, so
    // it follows the migration rather than being pinned to one page. It asserts
    // over whichever pages still render an Alpine expression into an attribute,
    // and once none do -- which is the end state this work walks towards -- it
    // asserts that instead, so it never quietly passes on an empty set.
    const ALPINE_ATTR = /(?:x-text|x-show|:class|:disabled)="([^"]*)"/g;

    test('a rendered attribute keeps its quotes escaped', async () => {
        const sup = await asSuper();
        const pages = ['/login.php', ...fs.readdirSync(SRC)
            .filter((f) => f.endsWith('.php'))
            .filter((f) => /include\s+'partials\/shell\.php'/.test(readSrc(f)))
            .map((f) => '/' + f)];

        let checked = 0;
        for (const path of pages) {
            const html = await (await get(path, path === '/login.php' ? null : sup)).text();
            for (const attr of html.match(ALPINE_ATTR) ?? []) {
                checked++;
                // json_encode in an attribute terminates it at the first inner
                // quote, leaving a fragment ending in `?` or `:` that still
                // renders its server-side fallback and so looks fine.
                assert.ok(!/[?:]\s*$/.test(attr),
                    `${path}: attribute truncated at a quote: ${attr.slice(0, 70)}`);
                // An attribute delimited by " cannot contain a raw " -- the
                // parser ends it there. Truncation above is therefore the whole
                // observable signal, and checking for inner quotes here would
                // only ever match the attribute's own delimiters.
            }
        }

        if (checked === 0) {
            // Alpine is gone. Prove it rather than pass on an empty loop.
            const html = await (await get('/dashboard.php', sup)).text();
            assert.ok(!/\sx-(data|show|text|cloak)[=\s]/.test(html),
                'no Alpine attributes were checked, but Alpine markup is still rendered');
            return;
        }
        assert.ok(checked > 0);
    });
});

describe('login background artwork', () => {
    test('geometric artwork decorates the form-side background, not the card', () => {
        const login = readSrc('login.php');
        const mainStart = login.indexOf('<main class="am2-login-stage');
        const cardStart = login.indexOf('<div id="am2-login-card"');
        assert.ok(mainStart >= 0 && cardStart > mainStart, 'login form-side stage or card is missing');

        const beforeCard = login.slice(mainStart, cardStart);
        assert.match(beforeCard, /class="am2-login-geometry" aria-hidden="true"/,
            'geometric artwork is missing from the form-side background or exposed to assistive technology');
        assert.ok(!login.slice(cardStart).includes('am2-login-geometry'),
            'geometric artwork leaked inside the login card');
    });

    test('geometric artwork is non-interactive and theme-aware', () => {
        const css = fs.readFileSync(`${SRC}/asset/css/tailwind.src.css`, 'utf8');
        assert.match(css, /\.am2-login-geometry\s*\{[^}]*pointer-events:\s*none/s);
        assert.match(css, /\[data-theme="dark"\]\s+\.am2-login-geometry/);
        const reducedMotionBlocks = [...css.matchAll(
            /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g
        )].map((match) => match[1]);
        assert.ok(reducedMotionBlocks.some((block) => /\.am2-login-geometry/.test(block)),
            'login geometry is not disabled by its reduced-motion media block');
        assert.doesNotMatch(css, /var\(--color-background\)/,
            'login geometry uses an undefined background token; use --color-bg');
    });

    test('decorations stay outside the unchanged login form contract', () => {
        const login = readSrc('login.php');
        const forms = [...login.matchAll(/<form\b[\s\S]*?<\/form>/g)];
        assert.equal(forms.length, 1, 'login must keep exactly one form');
        const form = forms[0][0];
        assert.match(form, /method="POST"/);
        assert.match(form, /id="username"\s+name="username"[^>]*required/);
        assert.match(form, /id="password"\s+name="password"[^>]*required/);
        assert.doesNotMatch(form, /am2-(?:login|brand)-geometry/,
            'decorative geometry must stay outside the login form');
    });

    test('brand panel has a separate radial signal system behind its content', () => {
        const login = readSrc('login.php');
        const panelStart = login.indexOf('<aside class="am2-brand-panel');
        const panelEnd = login.indexOf('</aside>');
        assert.ok(panelStart >= 0 && panelEnd > panelStart, 'brand panel is missing');

        const panel = login.slice(panelStart, panelEnd);
        assert.match(panel, /class="am2-brand-geometry" aria-hidden="true"/,
            'brand-side signal geometry is missing or exposed to assistive technology');
        assert.match(panel, /class="[^"]*\bam2-signal-core\b[^"]*"/,
            'logo has no technical signal frame');
        assert.match(panel, /class="am2-brand-facts/,
            'operator facts are not visually grouped');
    });

    test('brand-side signal system cannot intercept login interaction', () => {
        const css = fs.readFileSync(`${SRC}/asset/css/tailwind.src.css`, 'utf8');
        assert.match(css, /\.am2-brand-geometry\s*\{[^}]*pointer-events:\s*none/s);
        assert.match(css, /\[data-theme="dark"\]\s+\.am2-brand-geometry/);
    });
});

describe('js() and json_encode belong in different places', () => {
    // The pair fails in both directions and each failure looks different.
    // json_encode in an attribute terminates it at the first quote, and the
    // element keeps rendering its fallback so it looks fine. js() inside a
    // <script> emits &quot;, which is a syntax error that kills the block.
    const FILES = ['login.php', 'partials/shell_end.php'].concat(
        fs.readdirSync(SRC)
          .filter((f) => f.endsWith('.php'))
          .filter((f) => /include\s+'partials\/shell\.php'/.test(readSrc(f)))
    );

    for (const f of FILES) {
        test(`${f} keeps js() out of script blocks`, () => {
            const scripts = readSrc(f).match(/<script[\s\S]*?<\/script>/g) ?? [];
            for (const block of scripts) {
                const bad = [...block.matchAll(/<\?=\s*js\(/g)];
                assert.equal(bad.length, 0,
                    `${f}: js() emits &quot; which is invalid JavaScript; use json_encode here`);
            }
        });
    }
});

describe('the shell actually serves its stylesheets', () => {
    // A mutation that deleted the stylesheet link escaped the suite: every
    // assertion was about markup, so the app could lose all of its CSS and
    // still be reported green.
    test('every stylesheet the dashboard links resolves and is not empty', async () => {
        const cookie = await asSuper();
        const html = await (await get('/dashboard.php', cookie)).text();
        const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)]
            .map((m) => m[1]);

        assert.ok(hrefs.length >= 1, 'the shell must link at least one stylesheet');
        assert.ok(hrefs.some((h) => /tailwind/.test(h)),
            'the built Tailwind sheet is what the redesigned pages are styled with');

        for (const href of hrefs) {
            const res = await get('/' + href.replace(/^\//, ''), cookie);
            assert.strictEqual(res.status, 200, `${href} must resolve`);
            const body = await res.text();
            assert.ok(body.length > 1000, `${href} came back with ${body.length} bytes`);
        }
    });
});

describe('motion rules that decay quietly', () => {
    const pages = () => fs.readdirSync(SRC).filter((f) => f.endsWith('.php'))
        .concat(fs.readdirSync(`${SRC}/partials`).map((f) => `partials/${f}`))
        .filter((f) => f.endsWith('.php'));

    // Comments are stripped first: a note explaining why Preline's own example
    // was rewritten is not markup, and a guard that trips on prose is a guard
    // people learn to route around.
    const markupOf = (f) => readSrc(f)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    test('nothing animates with transition-all', () => {
        // transition-all animates properties nobody chose, including layout
        // ones, which is how a hover ends up repainting a table.
        const offenders = pages().filter((f) => /transition-all/.test(markupOf(f)));
        assert.deepEqual(offenders, [], 'declare the properties being animated');
    });

    test('table rows change colour and nothing else', () => {
        // A row that lifts or scales pulls the eye off the column being read
        // down. Rows are scanned, not browsed.
        for (const f of pages()) {
            const src = readSrc(f);
            for (const m of src.matchAll(/<tr[^>]*>/g)) {
                assert.ok(!/hover:(scale|-?translate)/.test(m[0]),
                    `${f}: a table row must not lift or scale on hover`);
            }
        }
    });

    test('every dialog states its own enter and leave', () => {
        // Alpine's bare x-transition is one linear curve for everything, so a
        // backdrop and a panel crossing the viewport move identically.
        for (const f of pages()) {
            const src = readSrc(f);
            assert.ok(!/x-transition(?![:.\w-])/.test(markupOf(f)),
                `${f}: bare x-transition, give it enter and leave`);
        }
    });

    test('the built stylesheet carries the motion tokens', () => {
        const css = fs.readFileSync(`${SRC}/asset/css/am2-tailwind.css`, 'utf8');
        // --duration-modal is deliberately absent: Motion owns the dialogue
        // timing, and the token's only readers were the x-transition
        // attributes on the pages that have since been rebuilt.
        for (const token of ['--ease-enter', '--ease-exit', '--duration-drawer',
                             '--duration-micro', 'am2-skeleton', 'prefers-reduced-motion']) {
            assert.ok(css.includes(token), `the build dropped ${token}`);
        }
    });

    test('reduced motion is honoured, not just declared', () => {
        const css = fs.readFileSync(`${SRC}/asset/css/am2-tailwind.css`, 'utf8');
        const block = css.slice(css.indexOf('prefers-reduced-motion'));
        // The pulse and the skeleton shimmer are the two loops in the app;
        // both have to stop, not merely slow down.
        assert.ok(/am2-live/.test(block) && /am2-skeleton/.test(block),
            'the looping animations must be switched off under reduced motion');
    });
});

describe('probes may only name fixtures', () => {
    // Staging holds a copy of production. A probe that hardcoded admin_id=1
    // overwrote the real superadmin's password hash, because it was run against
    // a build where the guard it was testing for did not exist yet. The
    // assertion ran afterwards and could not undo it.
    const TESTS = '/home/am2deploy/am2-main/tests/contract';
    // Panel pages dispatch on the presence of a field name, not an `action`
    // value, so the gate has to know both shapes -- it skipped the file that
    // actually caused a cross-file collision.
    const MUTATING = new RegExp([
        'new_password',
        "action:\\s*'(save|delete|update_password|update_feature|force_logout)'",
        '(save_user_channels|update_multi_access|save_channel_access|update_feature):',
    ].join('|'));

    test('no mutating probe hardcodes a database id', () => {
        for (const f of fs.readdirSync(TESTS).filter((n) => n.endsWith('.test.mjs'))) {
            const src = fs.readFileSync(`${TESTS}/${f}`, 'utf8');
            if (!MUTATING.test(src)) continue;
            const literals = [
                ...src.matchAll(/admin_id:\s*['"`](\d+)['"`]/g),
                // A literal channel id names whatever real channel holds
                // that sequence value on the production copy.
                ...src.matchAll(/channels:\s*JSON\.stringify\(\[\s*\d/g),
            ];
            assert.deepEqual(literals.map((m) => m[0]), [],
                `${f}: resolve the target with ctAdminId('ct_...') instead of a literal id`);
        }
    });

    test('the fixture guard refuses a real account', async () => {
        const { guardCtTarget } = await import('./helpers.mjs');
        for (const real of ['superadmin', 'am²', '1', '']) {
            assert.throws(() => guardCtTarget(real), /only ct_\* rows may be mutated/,
                `guardCtTarget let "${real}" through`);
        }
        assert.equal(guardCtTarget('ct_super'), 'ct_super');
    });
});

describe('translated strings arrive substituted', () => {
    // t() prepends the colon itself, so the caller passes 'n' and not ':n'.
    // Passing ':n' produces '::n', which matches nothing and renders the
    // placeholder to the operator. It looked fine in every test until someone
    // read the page.
    test('no unsubstituted placeholder reaches a rendered page', async () => {
        const sup = await asSuper();
        for (const path of ['/dashboard.php', '/users.php', '/channels.php',
                            '/user_access.php', '/logs.php', '/settings.php']) {
            const html = await (await get(path, sup)).text();
            const body = html.replace(/<script[\s\S]*?<\/script>/g, '')
                             .replace(/<[^>]+>/g, ' ');
            const left = [...body.matchAll(/(?:^|\s):([a-z][a-z0-9_]{0,14})(?=\s|%|\b)/gi)]
                .map((m) => m[0].trim());
            assert.deepEqual(left, [], `${path}: placeholder never substituted`);
        }
    });
});
