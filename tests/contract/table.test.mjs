// The roster table: the bug it was rebuilt to stop repeating, and the budget
// it has to stay inside.
//
// The reported symptom was that clicking a feature or duplex toggle changed
// the database and not the screen -- the new state only appeared after a
// reload. The cause was in the template, not the handler:
//
//     data-full="0"
//     :class="$el.dataset.full === '1' ? … : …"
//
// element.dataset is not one of Alpine's reactive proxies, so writing
// el.dataset.full produced no signal and nothing re-rendered. The write
// succeeded, which is why PHP showed the new state on the next request.
//
// The rule that came out of it: a control that changes state writes its own
// DOM, and nothing binds appearance to a data attribute expecting a framework
// to notice. These tests hold both ends of that.
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { asSuper, asBranchA, get, postForm, json, readSrc, sqlOne, guardCtTarget } from './helpers.mjs';

let sup, branchA;
before(async () => { sup = await asSuper(); branchA = await asBranchA(); });

describe('a toggle cannot leave the row lying', () => {
    test('a refused change leaves the database exactly as it was', async () => {
        // A branch admin reaching for another branch's unit. The optimistic
        // paint has to be rolled back by the page, and the row has to be
        // untouched underneath -- this is the half the server owns.
        // The per-unit flags live in user_app_permissions, not on the unit
        // row -- users.duplex_mode does not exist.
        guardCtTarget('CT_B1');
        const read = () => sqlOne(
            "SELECT duplex_mode FROM public.user_app_permissions WHERE user_id = 'CT_B1'")[0];
        const before = read();

        const body = await json(await postForm('/users.php', branchA, {
            update_feature: '1', u_id: 'CT_B1', feature: 'duplex_mode', val: 'FULL DUPLEX',
        }));

        assert.equal(body.success, false, "a branch admin changed another branch's unit");
        assert.equal(read(), before, 'the row moved despite the refusal');
    });

    test('appearance is never bound to a data attribute', () => {
        // This is the bug itself, as a source assertion: Alpine does not
        // observe element.dataset, so a binding through it is a control that
        // can never redraw.
        const src = readSrc('users.php');
        assert.ok(!/:class="\$el\.dataset/.test(src),
            ':class bound to $el.dataset -- Alpine does not observe it, so the control never redraws');
        assert.ok(!/x-text="\$el\.dataset/.test(src),
            'x-text bound to $el.dataset -- same bug, on the label');
    });

    test('the toggle carries what it needs to repaint itself', async () => {
        // Mechanism-agnostic on purpose: what matters is that the control
        // holds both appearances, so the page can put either one back without
        // asking anything else.
        const html = await (await get('/users.php', sup)).text();
        assert.match(html, /data-toggle/, 'no toggle is declared for the table runtime');
        for (const attr of ['data-on-class', 'data-off-class']) {
            assert.ok(html.includes(attr),
                `${attr} missing: a rollback would have nothing to paint back to`);
        }
    });
});

describe('the roster renders a page, not the whole fleet', () => {
    test('one page of rows, not two hundred', async () => {
        const html = await (await get('/users.php', sup)).text();
        const rows = (html.match(/data-row-id=/g) ?? []).length;
        assert.ok(rows > 0, 'no rows carry data-row-id; the table runtime has nothing to select');
        assert.ok(rows <= 20, `${rows} rows in one response; the page size is 20`);
    });

    test('the response stays under a third of a megabyte', async () => {
        // It was 1,475kB, which is what made this the slowest page in the
        // panel: 4,508 DOM nodes and 1.5s to DOMContentLoaded on a slow CPU.
        const html = await (await get('/users.php', sup)).text();
        assert.ok(html.length < 300_000,
            `${Math.round(html.length / 1024)}kB of markup for one page of twenty`);
    });
});
