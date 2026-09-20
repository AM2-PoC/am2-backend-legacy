import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const page = readFileSync(new URL('../../WebAdmin/admin_panel.php', import.meta.url), 'utf8');
const start = page.indexOf("    document.querySelector('[data-delete-apply]')?.addEventListener('click', async () => {");
const end = page.indexOf("    const sheet = $('am2-admin-sheet');", start);
assert.ok(start >= 0 && end > start, 'bulk handler not found');
const handler = page.slice(start, end);

async function bulk(replies) {
    let click;
    let notice;
    let reloaded = false;
    const sent = [];
    const cells = [];
    const context = {
        document: { querySelector(selector) {
            if (selector === '[data-delete-apply]') return { addEventListener(_, fn) { click = fn; } };
            return { value: 'fixture-csrf' };
        } },
        scope: { ids: replies.map((_, i) => String(i + 4)) },
        table: { querySelector() { const cell = {}; cells.push(cell); return cell; } },
        CSS: { escape: String },
        FormData,
        T: { done: ':ok succeeded, :failed failed', unconfirmed: 'Refresh before retrying.' },
        location: { pathname: '/admin_panel.php' },
        fetch: async (url, options) => {
            sent.push({ url, body: Object.fromEntries(options.body) });
            const reply = replies[sent.length - 1];
            if (reply instanceof Error) throw reply;
            return { json: async () => reply };
        },
        window: {
            AM2: { handoff(text, ok) { notice = { text, ok }; } },
            location: { reload() { assert.ok(notice, 'handoff must precede reload'); reloaded = true; } },
        },
    };
    vm.runInNewContext(handler, context);
    await click();
    return { notice, sent, cells, reloaded };
}

test('bulk carries server refusal reasons across reload as text, with accurate totals', async () => {
    const reason = 'Move the 2 owned units first. <b>not markup</b>';
    const result = await bulk([{ success: true }, { success: false, msg: reason }, { success: false, msg: reason }]);
    assert.equal(result.notice.ok, false);
    assert.match(result.notice.text, /^1 succeeded, 2 failed/);
    assert.ok(result.notice.text.includes(reason));
    assert.equal(result.notice.text.split(reason).length - 1, 1, 'repeat reasons need only be shown once');
    assert.deepEqual(result.cells.map(c => c.textContent), ['✓', '✕', '✕']);
    assert.equal(result.reloaded, true);
    assert.deepEqual(result.sent[0], { url: '/admin_panel.php', body: { _csrf: 'fixture-csrf', delete_admin_id: '4', ajax: '1' } });
});

test('network and malformed replies fail closed without displaying exception internals', async () => {
    const result = await bulk([new Error('private transport detail'), {}, null, { success: false }, { success: 'true' }]);
    assert.equal(result.notice.ok, false);
    assert.match(result.notice.text, /^0 succeeded, 5 failed/);
    assert.ok(result.notice.text.includes('Refresh before retrying.'));
    assert.ok(!result.notice.text.includes('private transport detail'));
});

test('successful bulk deletion keeps the existing summary', async () => {
    const result = await bulk([{ success: true }, { success: true }]);
    assert.deepEqual(result.notice, { text: '2 succeeded, 0 failed', ok: true });
});

test('a transport failure after a refusal retains both explanations', async () => {
    const result = await bulk([{ success: false, msg: 'Review owned units.' }, new Error('private')]);
    assert.ok(result.notice.text.includes('Review owned units.'));
    assert.ok(result.notice.text.includes('Refresh before retrying.'));
    assert.equal(result.notice.ok, false);
});
