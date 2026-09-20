
import { playExit } from './am2-exit.js';

const csrf = () => document.querySelector('input[name="_csrf"]')?.value ?? '';

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

function fieldsFor(el, rowId, on) {
    const fields = { [el.dataset.endpoint]: '1', u_id: rowId };
    if (el.dataset.field) fields.feature = el.dataset.field;

    if (el.dataset.value !== undefined) {
        fields.val = el.dataset.value;
    } else if (el.dataset.onValue !== undefined) {
        fields.val = on ? el.dataset.onValue : el.dataset.offValue;
    } else {
        fields.val = on ? 'true' : 'false';
    }
    return fields;
}

async function runToggle(btn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    const was = btn.dataset.on === '1';

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
    const selectable = (tr) => {
        const box = tr.querySelector('[data-select]');
        return !!box && !box.disabled;
    };
    const selectableRows = () => rows().filter(selectable);
    const matchingIds = () => {
        const blocked = new Set(rows().filter((tr) => !selectable(tr)).map((tr) => tr.dataset.rowId));
        return (table.dataset.allIds || '').split(' ').filter((id) => id && !blocked.has(id));
    };

    const bar = document.querySelector('[data-bulk-bar]');
    const offer = document.querySelector('[data-select-all-matching]');

    const selected = () => (state.all ? matchingIds().length : state.ids.size);

    function paint() {
        const eligible = selectableRows();
        for (const tr of rows()) {
            if (!selectable(tr)) state.ids.delete(tr.dataset.rowId);
            const on = selectable(tr) && (state.all || state.ids.has(tr.dataset.rowId));
            tr.classList.toggle('am2-row-selected', on);
            const box = tr.querySelector('[data-select]');
            if (box) box.checked = on;
        }
        const n = selected();
        const count = document.querySelector('[data-bulk-count]');
        if (count) count.textContent = String(n);

        if (bar) {
            if (n === 0 && !bar.hidden) {
                playExit(bar).then(() => {

                    if (selected() === 0) bar.hidden = true;
                });
            } else if (n > 0) {
                bar.hidden = false;
            }
        }

        const pageBox = table.querySelector('[data-select-page]');
        if (pageBox) {
            const onPage = eligible.filter((tr) => state.ids.has(tr.dataset.rowId)).length;
            pageBox.checked = eligible.length > 0 && (state.all || onPage === eligible.length);
            pageBox.indeterminate = !state.all && onPage > 0 && onPage < eligible.length;
        }

        if (offer) {
            offer.hidden = state.all
                || eligible.length === 0
                || state.ids.size !== eligible.length
                || matchingIds().length <= eligible.length;
        }
    }

    function toggleRow(id, on) {
        if (!selectableRows().some((tr) => tr.dataset.rowId === id)) return;
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
            if (!tr || !selectable(tr)) { paint(); return; }
            const list = rows();
            const index = list.indexOf(tr);

            if (e.shiftKey && state.anchor !== null) {
                const [from, to] = [state.anchor, index].sort((a, b) => a - b);
                state.all = false;
                for (let i = from; i <= to; i += 1) {
                    if (selectable(list[i])) state.ids.add(list[i].dataset.rowId);
                }
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
            if (pageBox.checked) selectableRows().forEach((tr) => state.ids.add(tr.dataset.rowId));
            else state.ids.clear();
            paint();
            return;
        }

    });

    /**
     * Bulk. N units is N requests against endpoints that already exist, which
     * is why this inherits their tenant checks rather than restating them.
     * The outcome is written per row: one spinner that turns into a tick says
     * nothing about the three that failed.
     */
    async function runBulk(btn) {
        paint();
        const ids = state.all
            ? matchingIds()
            : [...state.ids];
        if (!ids.length) return;

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

        if (ok > 0 && btn.dataset.reload !== 'false') {
            setTimeout(() => window.location.reload(), failed.length ? 2500 : 900);
        }
    }

    function closeBulkMore({ restoreFocus = false } = {}) {
        const more = bar?.querySelector('[data-bulk-more]');
        const menu = bar?.querySelector('[data-bulk-more-menu]');
        if (!more || !menu || menu.hidden) return;
        menu.hidden = true;
        more.setAttribute('aria-expanded', 'false');
        if (restoreFocus) more.focus();
    }

    bar?.addEventListener('click', (e) => {
        if (e.target.closest('[data-select-all-matching]')) { state.all = true; paint(); return; }
        if (e.target.closest('[data-clear-selection]')) { clearSelection(); return; }

        const more = e.target.closest('[data-bulk-more]');
        if (!more) return;
        const menu = bar.querySelector('[data-bulk-more-menu]');
        if (!menu) return;
        const opens = menu.hidden;
        menu.hidden = !opens;
        more.setAttribute('aria-expanded', String(opens));
        if (opens) menu.querySelector('[data-bulk]')?.focus();
    });

    document.addEventListener('pointerdown', (e) => {
        if (bar && !bar.contains(e.target)) closeBulkMore();
    });

    document.querySelectorAll('[data-bulk]').forEach((btn) => {
        btn.addEventListener('click', () => runBulk(btn));
    });

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
            if (!bar?.querySelector('[data-bulk-more-menu]')?.hidden) {
                e.preventDefault();
                closeBulkMore({ restoreFocus: true });
            } else if (selected() > 0) {
                e.preventDefault();
                clearSelection();
            }
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

let toggleBound = false;

export function initTables(root = document) {
    if (!toggleBound) {
        document.addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-toggle]');
            if (toggle && !toggle.disabled) runToggle(toggle);
        });
        toggleBound = true;
    }
    root.querySelectorAll('[data-am2-table]').forEach(setupTable);
}
