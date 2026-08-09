<?php
require_once 'auth.php';
date_default_timezone_set('Asia/Jakarta');

require_once 'config.php';
?>
<?php
$pageTitle = t('logs.heading');
$pageLede  = t('logs.lede');

include 'partials/head.php';
include 'partials/shell.php';

/** Page size. 20 rows of 44px fills a screen without needing two scrolls. */
const AM2_LOG_PAGE = 20;
?>

<section class="am2-surface flex flex-col rounded-card">

    <!--
        Filter toolbar. Category first: it narrows the set, and search then
        works within it. The button ids are the contract this page has always
        exposed.
    -->
    <div class="flex flex-wrap items-center gap-3 border-b border-edge px-4 py-3 lg:px-5">
        <div class="flex gap-1.5" role="group" aria-label="<?= e('logs.filter') ?>">
            <?php foreach ([['ALL', 'btn-all', 'logs.all'], ['PTT', 'btn-ptt', 'logs.ptt'],
                            ['ADM', 'btn-adm', 'logs.adm']] as [$cat, $id, $key]): ?>
                <button type="button" id="<?= $id ?>" data-cat="<?= $cat ?>"
                        aria-pressed="<?= $cat === 'ALL' ? 'true' : 'false' ?>"
                        class="am2-cat h-11 rounded-control border px-3 font-mono text-[11px]
                               uppercase tracking-[0.15em] transition-colors
                               duration-[var(--duration-micro)]
                               <?= $cat === 'ALL'
                                   ? 'border-brand bg-brand/10 text-brand'
                                   : 'border-edge text-ink-subtle hover:border-brand hover:text-brand' ?>">
                    <?= e($key) ?>
                </button>
            <?php endforeach; ?>
        </div>

        <div class="relative min-w-0 flex-1 sm:max-w-xs">
            <input id="logSearchInput" type="search" autocomplete="off"
                   aria-label="<?= e('logs.search') ?>"
                   class="h-11 w-full rounded-control border border-edge bg-card px-3 text-sm text-ink
                          transition-colors duration-[var(--duration-micro)]
                          hover:border-edge-strong focus:border-brand focus:outline-none
                          focus:ring-2 focus:ring-brand/25"
                   placeholder="<?= e('logs.search') ?>">
        </div>

        <div class="ml-auto flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.15em]">
            <span id="loading-indicator" hidden class="text-brand">•••</span>
            <span id="logStale" hidden class="text-warn"><?= e('rail.stale') ?></span>
            <!-- Live is a state, so it is shown as one. Paused says why. -->
            <span id="logPaused" hidden
                  class="flex items-center gap-1.5 rounded-control bg-warn/10 px-2 py-1 text-warn">
                <span aria-hidden="true">❙❙</span><span id="logPausedWhy"></span>
            </span>
            <span class="text-ink-subtle">
                <?= e('logs.updated') ?> <span id="last-update-time">--:--:--</span>
            </span>
        </div>
    </div>

    <!--
        The wrapper scrolls in both directions, and the header sticks to it.
        An overflow container is what sticky positions against, so a thead
        sticking to the viewport inside an overflow-x wrapper does nothing at
        all -- it scrolls away with the rest of the table, which is what this
        did until it was measured.
    -->
    <div class="max-h-[calc(100dvh-19rem)] overflow-auto">
        <table class="data-table am2-roster am2-roster-log w-full text-sm lg:min-w-[48rem]">
            <thead class="sticky top-0 z-10 bg-card">
                <tr class="border-b border-edge text-left font-mono text-[11px] uppercase
                           tracking-[0.15em] text-ink-subtle">
                    <th scope="col" class="px-4 py-2.5 font-normal lg:px-5"><?= e('logs.time') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.event') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.detail') ?></th>
                    <th scope="col" class="px-4 py-2.5 font-normal"><?= e('logs.actor') ?></th>
                </tr>
            </thead>
            <!-- id is the contract. -->
            <tbody id="log-table-body" class="divide-y divide-edge"></tbody>
        </table>
    </div>

    <div id="logEmpty" hidden></div>
    <div id="logError" hidden></div>

    <!--
        Footer. The count is of what is held, not of what exists: the endpoint
        answers a page at a time, and "load older" asks for the one before it
        until the server says there is nothing left. It used to stop at the
        newest 200 and say so, which was honest but was also the whole log
        anybody could reach.
    -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-edge px-4 py-3 lg:px-5">
        <p id="logCount" class="font-mono text-[11px] uppercase tracking-[0.15em] text-ink-subtle"></p>
        <div class="flex items-center gap-3">
            <!--
                The endpoint pages backwards from the oldest row held, so the
                log is no longer whatever fitted in the first two hundred.
                Hidden once the server says there is nothing older, rather than
                left to be pressed for no result.
            -->
            <button type="button" id="logMore" hidden
                    class="am2-chip inline-flex items-center border-edge text-ink-muted
                           hover:text-brand">
                <?= e('logs.load_older') ?>
            </button>
            <nav id="logPager" class="flex items-center gap-1" aria-label="<?= e('logs.pagination') ?>"></nav>
        </div>
    </div>
</section>

<?php include 'partials/shell_end.php'; ?>

<script>
(() => {
    'use strict';

    const PAGE = <?= AM2_LOG_PAGE ?>;
    const LABEL = {
        login:  <?= json_encode(t('logs.badge_login')) ?>,
        logout: <?= json_encode(t('logs.badge_logout')) ?>,
        empty:  <?= json_encode(t('logs.empty')) ?>,
        noMatch:<?= json_encode(t('logs.no_match')) ?>,
        count:  <?= json_encode(t('logs.count')) ?>,
        pausedBrowsing: <?= json_encode(t('logs.paused_browsing')) ?>,
    };
    const ADM = <?= json_encode([
        'CREATE_USER'    => t('logs.badge_create'),
        'UPDATE_USER'    => t('logs.badge_update'),
        'DELETE_USER'    => t('logs.badge_delete'),
        'UPDATE_FEATURE' => t('logs.badge_feature'),
        'UPDATE_ACCESS'  => t('logs.badge_access'),
        'CREATE'         => t('logs.badge_create'),
        'UPDATE'         => t('logs.badge_update'),
        'DELETE'         => t('logs.badge_delete'),
    ]) ?>;
    const LOCALE = <?= json_encode(am2_locale() === 'id' ? 'id-ID' : 'en-GB') ?>;

    const $ = (id) => document.getElementById(id);
    const body = $('log-table-body');
    const pager = $('logPager');

    let rows = [], category = 'ALL', query = '', page = 1;

    const visible = () => {
        const q = query.trim().toLowerCase();
        return rows.filter((r) => {
            if (category !== 'ALL' && r.kategori !== category) return false;
            if (!q) return true;
            // Searches the fields, not the rendered text: matching on innerText
            // meant a change of column count silently changed what a search found.
            return [r.target, r.pelaksana, r.pelaksana_id, r.aksi]
                .some((v) => String(v ?? '').toLowerCase().includes(q));
        });
    };

    function badge(row) {
        const t = String(row.aksi ?? '').toUpperCase();
        if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'bg-bad/10 text-bad';
        if (t === 'LOGIN') return 'bg-ok/10 text-ok';
        if (t === 'FORCE_LOGOUT') return 'bg-warn/10 text-warn';
        if (row.kategori === 'ADM') return 'bg-accent/10 text-accent';
        return 'bg-card-muted text-ink-subtle';
    }

    function label(row) {
        const t = String(row.aksi ?? '').toUpperCase();
        if (['PUSH', 'PUSH_PRIVATE'].includes(t)) return 'TX';
        if (['RELEASE', 'RELEASE_PRIVATE'].includes(t)) return 'RX';
        if (t === 'LOGIN') return LABEL.login;
        if (t === 'LOGOUT' || t === 'FORCE_LOGOUT') return LABEL.logout;
        // Admin actions have long names. Truncating them produced
        // "UPDATE_FEATU", which reads as a rendering fault rather than a label.
        return ADM[t] ?? t.slice(0, 10);
    }

    /**
     * textContent throughout: keterangan is free text an admin typed.
     *
     * data-cell is the roster contract the shared CSS reads. Below lg every
     * cell but the summary is hidden, so the four columns built with this are
     * the desktop table and nothing else.
     */
    function cell(name, cls) {
        const td = document.createElement('td');
        td.setAttribute('data-cell', name);
        td.className = cls;
        return td;
    }

    /**
     * The card a narrow screen gets.
     *
     * An event is read as a sentence -- when, what, to whom, by whom -- not as
     * four labelled fields, which is what the generic card transform made of it
     * and why the log was unreadable on a phone. It borrows data-cell="unit"
     * because that is the one cell the roster CSS reveals below lg; `hidden`
     * keeps it out of the desktop table, where the four real columns already
     * say all of this.
     */
    function summaryCell(r) {
        const td = cell('unit', 'hidden');

        const head = document.createElement('span');
        head.className = 'flex items-center gap-2';
        const b = document.createElement('span');
        b.className = 'shrink-0 rounded-control px-1.5 py-0.5 font-mono text-[11px] '
                    + 'uppercase tracking-[0.1em] ' + badge(r);
        b.textContent = label(r);
        const when = document.createElement('span');
        when.className = 'font-mono text-[11px] tabular-nums text-ink';
        when.textContent = r.jam ?? '';
        const day = document.createElement('span');
        day.className = 'font-mono text-[11px] text-ink-subtle';
        day.textContent = r.tanggal ?? '';
        head.append(b, when, day);

        // The target is the longest string on the row and the reason anyone
        // opened this page. It wraps rather than truncates.
        const what = document.createElement('span');
        what.className = 'mt-1 block break-words text-sm text-ink';
        what.textContent = r.target ?? '';

        const by = document.createElement('span');
        by.className = 'mt-0.5 block break-words font-mono text-[11px] text-ink-subtle';
        by.textContent = [r.pelaksana, r.pelaksana_id].filter(Boolean).join(' · ');

        td.append(head, what, by);
        return td;
    }

    function render() {
        const set = visible();
        const pages = Math.max(1, Math.ceil(set.length / PAGE));
        if (page > pages) page = pages;
        const slice = set.slice((page - 1) * PAGE, page * PAGE);

        body.textContent = '';
        for (const r of slice) {
            const tr = document.createElement('tr');
            tr.className = 'transition-colors duration-[var(--duration-micro)] hover:bg-card-muted';

            const time = cell('time', 'px-4 py-2 align-top lg:px-5');
            const jam = document.createElement('span');
            jam.className = 'block font-mono text-xs tabular-nums';
            jam.textContent = r.jam ?? '';
            const tgl = document.createElement('span');
            tgl.className = 'block font-mono text-[11px] text-ink-subtle';
            tgl.textContent = r.tanggal ?? '';
            time.append(jam, tgl);

            const ev = cell('event', 'px-4 py-2 align-top');
            const b = document.createElement('span');
            b.className = 'inline-block rounded-control px-1.5 py-0.5 font-mono text-[11px] '
                        + 'uppercase tracking-[0.1em] ' + badge(r);
            b.textContent = label(r);
            ev.append(b);

            const detail = cell('detail', 'px-4 py-2 align-top');
            detail.textContent = r.target ?? '';

            const actor = cell('actor', 'px-4 py-2 align-top');
            const who = document.createElement('span');
            who.className = 'block truncate';
            who.textContent = r.pelaksana ?? '';
            const wid = document.createElement('span');
            wid.className = 'block font-mono text-[11px] text-ink-subtle';
            wid.textContent = r.pelaksana_id ?? '';
            actor.append(who, wid);

            tr.append(summaryCell(r), time, ev, detail, actor);
            body.appendChild(tr);
        }

        $('logEmpty').hidden = set.length > 0;
        if (!set.length) {
            $('logEmpty').textContent = '';
            const p = document.createElement('p');
            p.className = 'px-5 py-10 text-center text-sm text-ink-muted';
            p.textContent = query ? LABEL.noMatch : LABEL.empty;
            $('logEmpty').appendChild(p);
        }

        const from = set.length ? (page - 1) * PAGE + 1 : 0;
        $('logCount').textContent = LABEL.count
            .replace(':from', from).replace(':to', (page - 1) * PAGE + slice.length)
            .replace(':total', set.length);

        renderPager(pages);
        // Offered on the last page, where running out of rows is the thing the
        // reader has just hit, and only while the server says more exist.
        $('logMore').hidden = exhausted() || page < pages;

        // Polling is only honest on page one; anywhere else the numbering moves
        // under the reader. Say so rather than quietly stopping.
        const browsing = page > 1;
        $('logPaused').hidden = !browsing;
        $('logPausedWhy').textContent = browsing ? LABEL.pausedBrowsing : '';
    }

    /** Preline pagination markup: https://preline.co/docs/pagination.html */
    function renderPager(pages) {
        pager.textContent = '';
        if (pages <= 1) return;
        const mk = (text, target, opts = {}) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.disabled = !!opts.disabled;
            b.className = 'grid h-11 min-w-11 place-items-center rounded-control border px-2 '
                + 'font-mono text-[11px] transition-colors duration-[var(--duration-micro)] '
                + 'disabled:opacity-40 '
                + (opts.current
                    ? 'border-brand bg-brand/10 text-brand'
                    : 'border-edge text-ink-subtle hover:border-brand hover:text-brand');
            if (opts.current) b.setAttribute('aria-current', 'page');
            if (opts.label) b.setAttribute('aria-label', opts.label);
            b.addEventListener('click', () => { page = target; render(); });
            return b;
        };
        pager.appendChild(mk('‹', page - 1, { disabled: page === 1, label: 'prev' }));
        // A window around the current page: 200 rows at 20 a page is ten
        // buttons, which is already more than anyone counts.
        const start = Math.max(1, Math.min(page - 2, pages - 4));
        for (let i = start; i <= Math.min(pages, start + 4); i++) {
            pager.appendChild(mk(String(i), i, { current: i === page }));
        }
        pager.appendChild(mk('›', page + 1, { disabled: page === pages, label: 'next' }));
    }

    /*
     * One cursor per category, because the endpoint limits the two separately.
     *
     * Sharing a watermark between them is what dropped rows: whichever table
     * was busier decided where the shared mark landed, and the quieter one's
     * rows underneath it were never asked for again. `more` is the server
     * saying its answer filled the page, so there is certainly another one.
     */
    const cursor = {
        ptt: { newest: '', oldest: '', more: true },
        adm: { newest: '', oldest: '', more: true },
    };
    let loadingOlder = false;

    /** Nothing older left to ask for in either table. */
    const exhausted = () => !cursor.ptt.more && !cursor.adm.more;

    // Plain comparison, not localeCompare: collation can ignore or reorder
    // punctuation, and these are timestamps whose byte order is already their
    // time order.
    const byTimeDesc = (a, b) => (String(a.raw_time) < String(b.raw_time) ? 1 : -1);

    function absorb(data, { append = false, polling = false } = {}) {
        const incoming = [...(data.ptt ?? []), ...(data.adm ?? [])];
        // Merge by id within category: a poll near a second boundary can
        // legitimately return a row already held, and a duplicated line in an
        // audit trail reads as the action having happened twice.
        const key = (r) => `${r.kategori}:${r.id}`;
        const seen = new Set(rows.map(key));
        const fresh = incoming.filter((r) => !seen.has(key(r)));
        rows = [...rows, ...fresh].sort(byTimeDesc);

        for (const cat of ['ptt', 'adm']) {
            const b = data.cursor?.[cat];
            if (!b) continue;
            if (b.newest) cursor[cat].newest = b.newest;
            /*
             * The paging cursor belongs to the downward queries -- the first
             * load and each "older" page. A poll returns rows newer than
             * everything held, so letting it move `oldest` would drag the mark
             * forward and skip the history in between, and letting it set
             * `more` would report on the wrong direction entirely: a poll that
             * fills its page says nothing about how deep the log goes.
             */
            if (!polling) {
                if (b.oldest) cursor[cat].oldest = b.oldest;
                cursor[cat].more = !!b.more;
            }
        }
        return fresh.length;
    }

    async function tick() {
        $('loading-indicator').hidden = false;
        try {
            // With a watermark the endpoint answers only what is newer, and
            // answers 204 when that is nothing -- which is most polls. One
            // watermark per category: see `cursor`.
            const polling = !!(cursor.ptt.newest || cursor.adm.newest);
            const qs = polling
                ? '?since_ptt=' + encodeURIComponent(cursor.ptt.newest)
                  + '&since_adm=' + encodeURIComponent(cursor.adm.newest)
                : '';
            const res = await fetch('fetch_logs.php' + qs, { headers: { Accept: 'application/json' } });
            if (res.status === 204) {
                // Nothing new. The rendered rows are still correct, so they are
                // left exactly as they are -- re-rendering would throw away the
                // reader's place for no new information.
                $('logStale').hidden = true;
                $('logError').hidden = true;
                stamp();
                slower();
                return;
            }
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const added = absorb(data, { polling });
            stamp();
            $('logStale').hidden = true;
            $('logError').hidden = true;
            if (added) { faster(); render(); } else { slower(); }
            /*
             * A poll that filled its page has left a backlog behind it. Come
             * back at once rather than waiting out the interval: the window is
             * oldest-first, so the rows still owed are the newer ones, and a
             * tab that was hidden for an hour would otherwise trickle them in
             * a hundred at a time. A short delay rather than an immediate call:
             * the watermark always advances so this terminates, but a tight
             * loop against a busy table is not a thing to leave to that.
             */
            if (polling && (data.cursor?.ptt?.more || data.cursor?.adm?.more)) {
                setTimeout(tick, 250);
            }
        } catch {
            // Keep the rows on screen but say they are no longer current.
            $('logStale').hidden = false;
        } finally {
            $('loading-indicator').hidden = true;
        }
    }

    function stamp() {
        $('last-update-time').textContent = new Date().toLocaleTimeString(LOCALE,
            { hour12: false, timeZone: 'Asia/Jakarta' });
    }

    /** One page older, on demand. This is what makes the log deeper than 200. */
    async function loadOlder() {
        if (loadingOlder || exhausted()) return;
        if (!cursor.ptt.oldest && !cursor.adm.oldest) return;
        loadingOlder = true;
        $('loading-indicator').hidden = false;
        try {
            /*
             * Each category asks from its own tail. Sharing one `before` across
             * both is what skipped rows: when they filled their pages and ended
             * at different times, the older tail became the next request and
             * everything the other table held between the two was never asked
             * for again. A category with nothing left sends no bound and is
             * simply not queried further.
             */
            const qs = new URLSearchParams();
            if (cursor.ptt.more && cursor.ptt.oldest) qs.set('before_ptt', cursor.ptt.oldest);
            if (cursor.adm.more && cursor.adm.oldest) qs.set('before_adm', cursor.adm.oldest);
            if (![...qs.keys()].length) return;

            const res = await fetch('fetch_logs.php?' + qs.toString(),
                                    { headers: { Accept: 'application/json' } });
            if (res.status === 204) { cursor.ptt.more = cursor.adm.more = false; return; }
            if (!res.ok) throw new Error(res.status);
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            if (!absorb(data, { append: true })) {
                cursor.ptt.more = cursor.adm.more = false;
            }
            render();
        } catch {
            $('logStale').hidden = false;
        } finally {
            loadingOlder = false;
            $('loading-indicator').hidden = true;
        }
    }

    document.querySelectorAll('.am2-cat').forEach((btn) => {
        btn.addEventListener('click', () => {
            category = btn.dataset.cat;
            page = 1;
            document.querySelectorAll('.am2-cat').forEach((b) => {
                const on = b === btn;
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.classList.toggle('border-brand', on);
                b.classList.toggle('bg-brand/10', on);
                b.classList.toggle('text-brand', on);
                b.classList.toggle('border-edge', !on);
                b.classList.toggle('text-ink-subtle', !on);
            });
            window.AM2?.filtered(body);
            render();
        });
    });

    $('logSearchInput').addEventListener('input', (e) => {
        query = e.target.value;
        page = 1;
        window.AM2?.filtered(body);
        render();
    });

    /*
     * How often to ask.
     *
     * Four seconds is right while something is happening -- a dispatch log is
     * read as it moves -- and wasteful at three in the morning, when the same
     * interval bought 900 requests an hour to be told nothing had changed. So
     * four seconds is the floor, not the rate: every quiet poll backs off a
     * step, and the first new row snaps it back. An event still surfaces within
     * four seconds of the one before it, which is what the number was for.
     */
    const MIN_EVERY = 4000;
    const MAX_EVERY = 30000;
    let every = MIN_EVERY, timer = null;

    const faster = () => { every = MIN_EVERY; };
    const slower = () => { every = Math.min(MAX_EVERY, Math.round(every * 1.5)); };

    function schedule() {
        clearTimeout(timer);
        // A chain of timeouts rather than an interval: the delay is decided
        // after each response, and an interval cannot change its own period.
        timer = setTimeout(async () => {
            // Only on page one. Anywhere else the numbering moves under the
            // reader -- see render(), which says so on screen.
            if (page === 1 && !document.hidden) await tick();
            schedule();
        }, every);
    }

    /*
     * A hidden tab asks for nothing.
     *
     * This console is left open on several screens all shift, and a tab nobody
     * is looking at was polling at exactly the same rate as the one in front of
     * the operator. Coming back asks immediately, so the first thing seen is
     * current rather than however old the last answer was.
     */
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) { clearTimeout(timer); return; }
        faster();
        if (page === 1) tick();
        schedule();
    });

    // Older rows, on request. The endpoint pages backwards from the oldest row
    // held, so this is what makes the log deeper than the newest 200 events.
    $('logMore')?.addEventListener('click', loadOlder);

    tick();
    schedule();
})();
</script>
</body>
</html>
