// The parts of the source and the rendered markup that are load-bearing.
//
// Dispatch in this codebase is by form field name, not by route: a page runs a
// branch because a POST field is present. Renaming a submit button therefore
// disables a feature silently, with no error and no visible change. These
// assertions make that loud.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, get, readSrc, SRC, SERVER_JS } from './helpers.mjs';
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
                // Either an explicit append or an object key handed to a
                // helper that appends. What matters is that the literal field
                // name still appears in the code that builds the request, so
                // renaming one side of the pair breaks this.
                const built = new RegExp(
                    `append\\(\\s*['"\`]${n}['"\`]|['"\`]?${n}['"\`]?\\s*:`).test(src);
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
        assert.match(readSrc('channels.php'), /name=["']users\[\]["']/);
        assert.match(readSrc('user_access.php'), /name=["']channels\[\]["']/);
        // permissions[<channelId>] is a keyed array, read as $permissions_input[$ch_id].
        assert.match(readSrc('user_access.php'), /name=["']permissions\[/);
        assert.match(readSrc('admin_panel.php'), /name=["']channels\[\]["']/);
    });

    test('GET dispatch parameters survive', () => {
        assert.match(readSrc('users.php'), /\$_GET\['get_user_channels'\]/);
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
        assert.match(src, /x-text="row\.target"/, 'the detail column must render as text');
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
    // and once none do -- which is the end state R7 is walking towards -- it
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
        for (const token of ['--ease-enter', '--ease-exit', '--duration-drawer',
                             '--duration-modal', 'am2-skeleton', 'prefers-reduced-motion']) {
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
    const MUTATING = /new_password|action:\s*'(save|delete|update_password|update_feature|force_logout)'/;

    test('no mutating probe hardcodes a database id', () => {
        for (const f of fs.readdirSync(TESTS).filter((n) => n.endsWith('.test.mjs'))) {
            const src = fs.readFileSync(`${TESTS}/${f}`, 'utf8');
            if (!MUTATING.test(src)) continue;
            const literals = [...src.matchAll(/admin_id:\s*['"`](\d+)['"`]/g)];
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
                            '/user_access.php', '/logs.php']) {
            const html = await (await get(path, sup)).text();
            const body = html.replace(/<script[\s\S]*?<\/script>/g, '')
                             .replace(/<[^>]+>/g, ' ');
            const left = [...body.matchAll(/(?:^|\s):([a-z][a-z0-9_]{0,14})(?=\s|%|\b)/gi)]
                .map((m) => m[0].trim());
            assert.deepEqual(left, [], `${path}: placeholder never substituted`);
        }
    });
});
