import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { initTables } from '../../WebAdmin/asset/js/src/am2-table.js';

// Only the DOM surface used by the table; the selection handlers run unchanged.
function element(tagName = 'DIV') {
    const listeners = new Map();
    const queries = new Map();
    const classes = new Set();
    return {
        tagName, dataset: {}, hidden: true, checked: false, disabled: false,
        classList: {
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
        },
        querySelectorAll(selector) { return queries.get(selector) || []; },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        bind(selector, ...nodes) { queries.set(selector, nodes); return this; },
        closest(selector) { return this.querySelector(selector); },
        setAttribute() {}, removeAttribute() {},
        focus() { document.activeElement = this; },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        dispatchEvent(event) {
            for (const fn of listeners.get(event.type) || []) fn(event);
        },
    };
}

function fixture(disabled = [false, true, false], allIds = 'a b c offpage') {
    const doc = element();
    const table = element();
    const bar = element();
    const count = element();
    const page = element('INPUT');
    const offer = element();
    const clear = element('BUTTON');
    const bulk = element('BUTTON');
    const search = element('INPUT');
    const menu = element();
    const rows = disabled.map((locked, index) => {
        const row = element('TR');
        row.dataset.rowId = String.fromCharCode(97 + index);
        if (locked !== null) {
            const box = element('INPUT');
            box.disabled = locked;
            box.bind('[data-select]', box).bind('tr[data-row-id]', row);
            row.bind('[data-select]', box);
        }
        return row;
    });
    table.dataset = { total: String(allIds.split(' ').filter(Boolean).length), allIds };
    table.bind('tr[data-row-id]', ...rows).bind('[data-select-page]', page)
        .bind('[data-table-search]', search);
    page.bind('[data-select-page]', page);
    offer.bind('[data-select-all-matching]', offer);
    clear.bind('[data-clear-selection]', clear);
    bar.bind('[data-bulk-more-menu]', menu);
    bulk.dataset.bulk = 'delete';
    doc.bind('[data-am2-table]', table).bind('[data-bulk-bar]', bar)
        .bind('[data-bulk-count]', count).bind('[data-select-all-matching]', offer)
        .bind('[data-bulk]', bulk);
    globalThis.document = doc;
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    globalThis.CustomEvent = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
    const emitted = [];
    table.addEventListener('am2:bulk', (event) => emitted.push(event.detail));
    initTables();
    const click = (host, target, shiftKey = false) => host.dispatchEvent({ type: 'click', target, shiftKey });
    return {
        rows, page, offer, count, bulk, emitted, search,
        row(index, shift = false) {
            const box = rows[index].querySelector('[data-select]');
            box.checked = !box.checked;
            click(table, box, shift);
        },
        selectPage(on = true) { page.checked = on; click(table, page); },
        matching() { click(bar, offer); },
        clear() { click(bar, clear); },
        submit() { click(bulk, bulk); return emitted.at(-1); },
        key(key, options = {}) {
            doc.dispatchEvent({ type: 'keydown', key, target: doc.activeElement || doc,
                preventDefault() {}, ...options });
        },
        selected() { return rows.filter((row) => row.classList.contains('am2-row-selected')).map((row) => row.dataset.rowId); },
    };
}

test('page and matching selection exclude disabled rows in paint, count and bulk payload', () => {
    const f = fixture();
    f.row(0);
    assert.equal(f.page.indeterminate, true);
    f.selectPage();
    assert.deepEqual(f.selected(), ['a', 'c']);
    assert.equal(f.rows[1].querySelector('[data-select]').checked, false);
    assert.equal(f.count.textContent, '2');
    assert.equal(f.page.checked, true);
    assert.equal(f.page.indeterminate, false);
    assert.equal(f.offer.hidden, false);
    assert.deepEqual(f.submit().ids, ['a', 'c']);
    f.matching();
    assert.deepEqual(f.selected(), ['a', 'c']);
    assert.equal(f.count.textContent, '3');
    assert.deepEqual(f.submit().ids, ['a', 'c', 'offpage']);
    assert.equal(f.submit().all, true);
    f.key('j');
    f.key('j');
    f.key('x');
    assert.equal(f.submit().all, true, 'x on a locked row must not clear all-matching');
    f.selectPage(false);
    assert.deepEqual(f.selected(), []);
    assert.equal(f.count.textContent, '0');
});

test('shift ranges skip disabled rows in either direction', () => {
    for (const [start, end] of [[0, 2], [2, 0]]) {
        const f = fixture();
        f.row(start);
        f.row(end, true);
        assert.deepEqual(f.selected(), ['a', 'c']);
        assert.deepEqual([...f.submit().ids].sort(), ['a', 'c']);
    }
});

test('keyboard navigation retains locked rows but x and direct clicks cannot select them', () => {
    const f = fixture();
    f.key('j');
    f.key('j');
    assert.equal(document.activeElement, f.rows[1]);
    f.key('x');
    f.row(1); // Synthetic click must not bypass the shared selection boundary.
    assert.deepEqual(f.selected(), []);
    assert.equal(f.count.textContent, '0');
    f.key('j');
    f.key('x');
    assert.deepEqual(f.submit().ids, ['c']);
    f.key('k');
    f.key('k');
    f.key('x', { ctrlKey: true });
    assert.deepEqual(f.selected(), ['c']);
    f.key('x');
    assert.deepEqual(f.selected(), ['a', 'c']);
    f.key('Escape');
    assert.deepEqual(f.selected(), []);
    f.key('/');
    assert.equal(document.activeElement, f.search);
    f.key('x');
    assert.deepEqual(f.selected(), []);
});

test('empty, fully locked and checkbox-free pages never become selected', () => {
    for (const disabled of [[], [true, true], [null, null]]) {
        const f = fixture(disabled, disabled.length ? 'a b' : '');
        f.selectPage();
        assert.deepEqual(f.selected(), []);
        assert.equal(f.page.checked, false);
        assert.equal(f.page.indeterminate, false);
        assert.equal(f.offer.hidden, true);
        assert.equal(f.count.textContent, '0');
        assert.equal(f.submit(), undefined);
    }
});

test('ordinary tables retain all-matching, deselection and clear behavior', () => {
    const f = fixture([false, false, false]);
    f.selectPage();
    f.matching();
    assert.equal(f.count.textContent, '4');
    assert.deepEqual(f.submit().ids, ['a', 'b', 'c', 'offpage']);
    f.row(1);
    assert.deepEqual(f.submit().ids, ['a', 'c']);
    assert.equal(f.submit().all, false);
    f.clear();
    assert.equal(f.count.textContent, '0');
});

test('bulk submission rechecks disabled rows for events and endpoint requests', async (t) => {
    const previousFetch = globalThis.fetch;
    const previousCSS = globalThis.CSS;
    t.after(() => { globalThis.fetch = previousFetch; globalThis.CSS = previousCSS; });
    for (const matching of [false, true]) {
        const f = fixture([false, false, false]);
        f.selectPage();
        if (matching) f.matching();
        f.rows[1].querySelector('[data-select]').disabled = true;
        const expected = matching ? ['a', 'c', 'offpage'] : ['a', 'c'];
        assert.deepEqual(f.submit().ids, expected);
        assert.equal(f.rows[1].querySelector('[data-select]').checked, false);
        const posted = [];
        globalThis.CSS = { escape: (id) => id };
        window.location = { pathname: '/table.php' };
        globalThis.fetch = async (_url, { body }) => {
            posted.push(body.get('u_id'));
            return { json: async () => ({ success: true }) };
        };
        Object.assign(f.bulk.dataset, { endpoint: 'update_feature', reload: 'false' });
        f.submit();
        await setImmediate();
        assert.deepEqual(posted, expected);
    }
});
