/**
 * The roster tables: selection, keyboard, optimistic toggles, bulk dispatch.
 *
 * One implementation for users.php, channels.php and user_access.php. A page
 * supplies markup and data attributes; it writes no JavaScript of its own, so
 * a behaviour fixed here is fixed on all three.
 *
 * The rule this module exists to enforce: a control that changes state writes
 * its own DOM. The bug it replaces bound `:class` and `x-text` to
 * `$el.dataset`, which Alpine does not observe -- the write reached the
 * database and the screen never moved until a reload.
 *
 * Markup contract
 *   [data-am2-table]            the wrapper, with data-total = rows matching the filter
 *   tr[data-row-id]             one row
 *   [data-select]               row checkbox
 *   [data-select-page]          header checkbox: this page only
 *   [data-select-all-matching]  the offer to extend to the whole filter
 *   [data-bulk-bar]             the floating bar
 *   [data-bulk-count]           where the count is written
 *   [data-bulk="<verb>"]        a verb; simple ones declare their own request
 *   [data-row-result]           where a row's outcome is written
 *   [data-toggle]               a control that flips one field
 */

const csrf = () => document.querySelector('input[name="_csrf"]')?.value ?? '';

/** Paint a toggle. Both appearances live on the element, so either can be put back. */
function paintToggle(btn, on) {
    btn.dataset.on = on ? '1' : '0';
    btn.className = `${btn.dataset.baseClass || ''} ${on ? btn.dataset.onClass : btn.dataset.offClass}`.trim();
    if (btn.dataset.onLabel) {
        btn.textContent = on ? btn.dataset.onLabel : btn.dataset.offLabel;
    }
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

async function postFields(fields) {
    const body = new FormData();
    body.append('_csrf', csrf());
    for (const [k, v] of Object.entries(fields)) {
        if (Array.isArray(v)) v.forEach((item) => body.append(k, item));
        else body.append(k, v);
    }
    const res = await fetch(window.location.pathname, {
        method: 'POST',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body,
    });
    return res.json();
}

/** The request a toggle or a simple bulk verb declares on itself. */
function fieldsFor(el, rowId, on) {
    const fields = { [el.dataset.endpoint]: '1', u_id: rowId };
    if (el.dataset.field) fields.feature = el.dataset.field;
    fields.val = el.dataset.value !== undefined
        ? el.dataset.value
        : (on ? 'true' : 'false');
    return fields;
}

async function runToggle(btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const was = btn.dataset.on === '1';

    // Paint first: an interface that waits for the network to answer before
    // acknowledging a click reads as broken on any connection worth the name.
    paintToggle(btn, !was);
    btn.setAttribute('aria-busy', 'true');

    try {
        const r = await postFields(fieldsFor(btn, btn.dataset.rowId, !was));
        if (!r || r.success === false) throw new Error(r?.msg || '');
        window.AM2?.toast(btn.dataset.okMessage || '');
    } catch (err) {
        // Back to where it was, and say why. A silent rollback is
        // indistinguishable from the click never having registered.
        paintToggle(btn, was);
        window.AM2?.toast(err.message || btn.dataset.failMessage || '', false);
    } finally {
        btn.removeAttribute('aria-busy');
    }
}

function setupTable(table) {
    const state = { ids: new Set(), all: false, anchor: null };

    const rows = () => [...table.querySelectorAll('tr[data-row-id]')];
    const bar = table.querySelector('[data-bulk-bar]');
    const offer = table.querySelector('[data-select-all-matching]');
    const total = () => Number(table.dataset.total || 0);

    const selected = () => (state.all ? total() : state.ids.size);

    function paint() {
        for (const tr of rows()) {
            const on = state.all || state.ids.has(tr.dataset.rowId);
            tr.classList.toggle('am2-row-selected', on);
            const box = tr.querySelector('[data-select]');
            if (box) box.checked = on;
        }
        const n = selected();
        const count = table.querySelector('[data-bulk-count]');
        if (count) count.textContent = String(n);
        if (bar) bar.hidden = n === 0;

        const pageBox = table.querySelector('[data-select-page]');
        if (pageBox) {
            const onPage = rows().filter((tr) => state.ids.has(tr.dataset.rowId)).length;
            pageBox.checked = state.all || (rows().length > 0 && onPage === rows().length);
            pageBox.indeterminate = !state.all && onPage > 0 && onPage < rows().length;
        }

        // Only worth offering when the page is full and the filter holds more:
        // otherwise "select all matching" and "select this page" are the same
        // act, and offering both invites the belief that they differ.
        if (offer) {
            offer.hidden = state.all
                || rows().length === 0
                || state.ids.size !== rows().length
                || total() <= rows().length;
        }
    }

    function toggleRow(id, on) {
        state.all = false;
        if (on) state.ids.add(id); else state.ids.delete(id);
        paint();
    }

    function clearSelection() {
        state.ids.clear();
        state.all = false;
        paint();
    }

    table.addEventListener('click', (e) => {
        const box = e.target.closest('[data-select]');
        if (box) {
            const tr = box.closest('tr[data-row-id]');
            const list = rows();
            const index = list.indexOf(tr);

            // Shift extends from the last row touched, which is the gesture a
            // file manager taught everyone.
            if (e.shiftKey && state.anchor !== null) {
                const [from, to] = [state.anchor, index].sort((a, b) => a - b);
                state.all = false;
                for (let i = from; i <= to; i += 1) state.ids.add(list[i].dataset.rowId);
                paint();
            } else {
                toggleRow(tr.dataset.rowId, box.checked);
            }
            state.anchor = index;
            return;
        }

        const pageBox = e.target.closest('[data-select-page]');
        if (pageBox) {
            state.all = false;
            if (pageBox.checked) rows().forEach((tr) => state.ids.add(tr.dataset.rowId));
            else state.ids.clear();
            paint();
            return;
        }

        if (e.target.closest('[data-select-all-matching]')) {
            state.all = true;
            paint();
            return;
        }

        if (e.target.closest('[data-clear-selection]')) {
            clearSelection();
            return;
        }

        const toggle = e.target.closest('[data-toggle]');
        if (toggle && !toggle.disabled) runToggle(toggle);
    });

    /**
     * Bulk. N units is N requests against endpoints that already exist, which
     * is why this inherits their tenant checks rather than restating them.
     * The outcome is written per row: one spinner that turns into a tick says
     * nothing about the three that failed.
     */
    async function runBulk(btn) {
        // "All matching" has to mean all matching, not the twenty on screen --
        // that confusion is the whole reason the offer is a separate act. The
        // page renders every matching id into data-all-ids; two hundred call
        // signs is under two kilobytes, and the alternative is an endpoint
        // that exists only to answer a question the page already knows.
        const ids = state.all
            ? (table.dataset.allIds || '').split(' ').filter(Boolean)
            : [...state.ids];
        if (!ids.length) return;

        // A verb the page owns -- a channel picker, a typed confirmation, an
        // export -- says so by not declaring an endpoint.
        if (!btn.dataset.endpoint) {
            table.dispatchEvent(new CustomEvent('am2:bulk', {
                bubbles: true,
                detail: { verb: btn.dataset.bulk, ids, all: state.all, clear: clearSelection },
            }));
            return;
        }

        btn.setAttribute('aria-busy', 'true');
        let ok = 0;
        const failed = [];
        for (const id of ids) {
            const cell = table.querySelector(`tr[data-row-id="${CSS.escape(id)}"] [data-row-result]`);
            if (cell) { cell.textContent = '·'; cell.className = 'text-ink-subtle'; }
            try {
                const r = await postFields(fieldsFor(btn, id, btn.dataset.value === 'true'));
                if (!r || r.success === false) throw new Error(r?.msg || '');
                ok += 1;
                if (cell) { cell.textContent = '✓'; cell.className = 'text-ok'; }
            } catch (err) {
                failed.push(id);
                if (cell) { cell.textContent = '✕'; cell.className = 'text-bad'; }
            }
        }
        btn.removeAttribute('aria-busy');

        const say = (btn.dataset.doneMessage || '')
            .replace(':ok', String(ok))
            .replace(':failed', String(failed.length));
        window.AM2?.toast(say, failed.length === 0);

        // The rows the page is showing are now stale in one field; reload
        // rather than guess which cells moved.
        if (ok > 0 && btn.dataset.reload !== 'false') {
            setTimeout(() => window.location.reload(), failed.length ? 2500 : 900);
        }
    }

    table.querySelectorAll('[data-bulk]').forEach((btn) => {
        btn.addEventListener('click', () => runBulk(btn));
    });

    /**
     * Keyboard. A dispatcher's hands are on the keyboard, and a table that can
     * only be worked with a mouse is a table they will not use under load.
     */
    let cursor = -1;
    function focusRow(next) {
        const list = rows();
        if (!list.length) return;
        cursor = Math.max(0, Math.min(list.length - 1, next));
        const tr = list[cursor];
        tr.setAttribute('tabindex', '-1');
        tr.focus({ preventScroll: false });
    }

    document.addEventListener('keydown', (e) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
            || e.target.isContentEditable;

        if (e.key === '/' && !typing) {
            e.preventDefault();
            table.querySelector('[data-table-search]')?.focus();
            return;
        }
        if (e.key === 'Escape') {
            if (selected() > 0) { e.preventDefault(); clearSelection(); }
            return;
        }
        if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

        if (e.key === 'j') { e.preventDefault(); focusRow(cursor + 1); }
        if (e.key === 'k') { e.preventDefault(); focusRow(cursor - 1); }
        if (e.key === 'x' && cursor >= 0) {
            e.preventDefault();
            const tr = rows()[cursor];
            if (tr) toggleRow(tr.dataset.rowId, !state.ids.has(tr.dataset.rowId));
        }
    });

    paint();
}

export function initTables(root = document) {
    root.querySelectorAll('[data-am2-table]').forEach(setupTable);
}
