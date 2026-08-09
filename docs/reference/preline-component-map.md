# Preline component map

Reference. Records every Preline component adapted into the panel: where it
came from, whether it is free, what it replaced, and what was changed to make
it AM2's rather than Preline's.

Preline UI 4.2.0, MIT. Only components from the free/core library are used —
nothing from Preline Pro. Every URL below is a free docs page.

## Runtime

| Piece | Version | Where it lands |
|---|---|---|
| `preline` | 4.2.0 | bundled into `asset/js/am2-ui.min.js` |
| `motion` | 12.43.0 | same bundle |
| `esbuild` | 0.28.1 | devDependency, build only |

Built with `npm run build` (`build:css` + `build:js`). Nothing is served from
`node_modules` and there is no CDN at runtime.

### The build flag that is not optional

Preline's per-plugin modules export **nothing** — they assign
`window.HSOverlay` and register a `load` listener, and `package.json` lists
only `dist/index.mjs` under `sideEffects`. A bundler honouring that annotation
drops the imports entirely:

```
▲ [WARNING] Ignoring this import because "node_modules/preline/dist/overlay.mjs"
  was marked as having no side effects [ignored-bare-import]
```

The build still exits 0 and still writes a bundle. `--ignore-annotations` is
what puts Preline in it. Verified by asserting the built file contains
`HSOverlay`, `HSDropdown`, `HSCollapse`, `HSTabs`, `HSTooltip` and
`HSComboBox`, not by trusting the exit code.

Six plugins are imported by name rather than the barrel: the barrel also
carries the datatable, datepicker, carousel, range slider and file upload,
which is 449 kB of behaviour this console does not have. Selective import is
240 kB, 69.5 kB gzipped — less than the Bootstrap, jQuery and Font Awesome the
old pages pulled from a CDN.

### Tailwind v4 integration

```css
@source "../../node_modules/preline/dist/*.js";
@import "../../node_modules/preline/variants.css";
```

The `@source` is what makes Tailwind emit the utility classes Preline applies
at runtime; without it a component opens with no styling at all. `variants.css`
supplies the `hs-*` custom variants the markup keys off.

## Division of responsibility

One behaviour, one owner:

- **Preline** — component state and lifecycle: what is open, where focus is,
  whether the body scrolls, Escape handling, focus trapping.
- **Motion** — what the change looks like, and never what is visible. Every
  animation runs on an element Preline has already shown, so an animation that
  throws leaves a usable page.
- **Vanilla JS** — fetch, polling, and the business state the pages already had.

Alpine still drives page bodies that have not been migrated yet. No element is
controlled by both; Alpine is removed once the last R7 page is done.

## Components adapted

Filled in as each page lands.

### Shared shell

| Preline component | Free | Docs | Target file | Adapted from | AM2 changes |
|---|---|---|---|---|---|
| Sidebar | core | [sidebar](https://preline.co/docs/sidebar.html) | `partials/shell.php` | the `hs-overlay` aside, `[--auto-close]`, and the mobile toggle | 272px / 72px rail instead of a fixed `w-64`; `transition-all duration-300` replaced with `transition-[transform,width]` on AM2's scale; rail width rendered by PHP from a cookie so there is no snap after paint |
| Accordion | core | [accordion](https://preline.co/docs/accordion.html) | `partials/shell.php` | `hs-accordion-group` + `data-hs-accordion-always-open`, `hs-accordion-toggle`, `hs-accordion-content` | the group holding the current page starts open; folded groups are written to a cookie so the sidebar renders already folded |
| Dropdown | core | [dropdown](https://preline.co/docs/dropdown.html) | `partials/shell.php` | `hs-dropdown`, `hs-dropdown-toggle`, `hs-dropdown-menu`, `[--placement:top-left]` | account menu in the sidebar foot, holding language, theme and sign out; opacity left to Preline, travel given to Motion |
| Navbar | core | [navbar](https://preline.co/docs/navbar.html) | `partials/shell.php` | sticky header composition and the overlay toggle button | page title, contextual action slot, and a full-width operational status strip below it |
| Modal | core | [modal](https://preline.co/docs/modal.html) | `partials/shell_end.php` | `hs-overlay` dialog with `data-hs-overlay` triggers | the command palette: Preline owns open, Escape and focus, the list and cursor are plain JS |

### Where Preline stops and Motion starts

Opacity is Preline's visibility mechanism — it swaps `opacity-0` for
`hs-overlay-open:opacity-100`. Motion therefore never touches opacity on those
elements, only `transform`. That keeps one property under one controller, and
it means an animation that fails to run leaves the component visible rather
than stuck at zero.

| Element | Preline owns | Motion owns |
|---|---|---|
| Mobile drawer | open/close, backdrop, focus trap, Escape, body scroll lock | `x` translate, 220ms enter / 120ms exit |
| Modal + palette | open/close, focus, Escape | panel `y` and `scale`, 180ms / 120ms |
| Dropdown | open/close, placement, keyboard | menu `y`, 160ms |
| Rail | — | width and padding, CSS transition (no Motion: nothing is being revealed) |

Verified in the browser, not inferred: `HSOverlay`, `HSDropdown` and
`HSAccordion` are all functions at runtime; the rail goes 272px to 72px with
labels hidden; the account dropdown opens; folding a group takes the visible
links from 8 to 5; the palette opens on Ctrl+K with 11 entries; and the mobile
drawer opens with a backdrop, locks body scroll and closes on Escape.

### login.php

| Preline component | Free | Docs | Adapted from | AM2 changes |
|---|---|---|---|---|
| Card | core | [card](https://preline.co/docs/card.html) | bordered surface with header and body padding | holds the form, which previously sat on the bare background and read as a page that had not finished rendering |
| Input | core | [input](https://preline.co/docs/input.html) | field + label + focus ring | 48px controls, monospace value text because a username and a password are identifiers |
| Toggle Password | core | [toggle-password](https://preline.co/docs/toggle-password.html) | `data-hs-toggle-password='{"target": "#password"}'`, icons swapped on `hs-password-active` | replaced the hand-rolled Alpine reveal outright, which is what makes login the first Alpine-free page |
| Alert | core | [alerts](https://preline.co/docs/alerts.html) | soft alert with leading icon | `role="alert"`, and a left border so the meaning does not rest on colour alone |

Contract kept exactly: `method="POST"` with no `action`, `name="username"`,
`name="password"`, `id="username"`, `id="password"`, `type="submit"`,
`id="themeToggle"`, the `?lang=` links, and the PHP block above the view
(lines 1-58: session, throttle, `session_regenerate_id`) untouched.

Motion here: `enterOnce()` staggers the four form blocks at 35ms, `toast()`
brings in the error alert, and `emit()` drives the three rings leaving the
mark. The rings were CSS keyframes before; they are Motion now so that one
owner holds the transform, and reduced motion is a branch rather than a media
query cancelling an animation in flight.

Verified: `HSTogglePassword` is a function; the password type goes
password → text → password; field names render as `["username","password"]`;
`method=POST action=null`; a keyboard-only sign-in with Enter reaches the
dashboard; the error alert renders on a bad password; three rings animate
normally and **zero** render under `prefers-reduced-motion: reduce`, with the
form fields still at opacity 1. No console errors in either mode.

## settings.php

| Component | Tier | Preline doc | Used as | Note |
|---|---|---|---|---|
| Toggle Password | core | [toggle-password](https://preline.co/docs/toggle-password.html) | `data-hs-toggle-password='{"target": "#new_password"}'` on both fields | replaced a hand-written Font Awesome eye that swapped two icon classes and announced no pressed state |
| Modal | core | [modal](https://preline.co/docs/modal.html) | `#am2-restore`, opened by `data-hs-overlay`, holding the whole restore form | no transition on the container: Preline re-adds `hidden` only after one ends, and a transition on a property that never changes never ends |
| Card | core | [card](https://preline.co/docs/card.html) | every section, plus the three stat cards as links | the stat cards carry the same arrow affordance as the dashboard's, because they link the same way |
| Alert | core | [alerts](https://preline.co/docs/alerts.html) | the POST result, `role="alert"` on failure and `role="status"` on success | a left border so the meaning does not rest on colour |
| Progress | core | [progress](https://preline.co/docs/progress.html) | quota meters, `role="progressbar"` with aria-valuenow | only rendered where a ceiling exists; a superadmin has none, and the old card printed "100" beside "sisa UNLIMITED" |

Contract kept exactly: `name="update_password"` with `new_password` and
`confirm_password`, `name="export_db"`, `name="import_db"` with `sql_file`,
`name="upload_apk"` with `apk_file`, `am2_csrf_field()` in all four POST forms,
and `require_once 'auth.php'` ahead of `config.php`. Export stays a native form
submit on purpose: the response to that POST is the dump itself, streamed by
`passthru()`, so a `fetch()` would read it into memory and never hand it over.

Motion here: `enterOnce()` staggers the stat cards and the alert, `countTo()`
runs the three counts up once, `revealOnScroll()` brings in the two lower
sections. Nothing loops, and nothing animates on the destructive controls --
a red button that moves reads as an invitation.

Behaviour changed on purpose, beyond the reskin:
- `import_db` gained the superadmin guard that `api_settings.php` already had.
  The page ran the same `psql` pipe with no role check, so a branch admin could
  overwrite every branch's data.
- Both `pg_dump` and `psql` now pass `-p $port`, which only the API did.
- The restore no longer writes an audit row into `ptt_logs`. That table's
  `user_id` is a foreign key to `users(id)` and its `channel_id` to
  `channels(id)`; an admin username and channel `0` satisfy neither, so the
  INSERT threw every time, was caught, and reported a restore that had already
  overwritten the database as a failure. It goes to the server log instead,
  beside the authorization refusals.

Verified: `HSTogglePassword` flips `type` password → text; the restore dialog
opens, keeps its submit disabled until the operator writes the confirmation
word, closes on Escape with no backdrop left behind and the page still
clickable, and clears the word when reopened; the title survives 390 and 768;
no tap target under 40px; no horizontal overflow at 390; `:focus-visible`
matches on the destructive button and paints a ring; every entrance element
sits at opacity 1 under `prefers-reduced-motion: reduce`; ID and EN both
render, and the confirmation word follows the locale. No console errors.

Open, and not fixed here -- see the release notes: the page discards
`shell_exec()`'s result and reports the restore as done whether or not `psql`
applied anything, and `export_db` for a branch admin dumps `public.users` and
`public.channels` whole, which is every branch's rows and not only its own.

### settings.php, second pass: the console states its condition

The first pass moved the page onto the shell. It still asked for actions
without saying what state anything was in. Every card now answers a question
before it asks for one.

| Addition | What it answers | Built from |
|---|---|---|
| Release shelf | which build the app is told to fetch, whether that file exists, what else is on the shelf | `update/admin_version.json` and a `glob()` of the folder — both already there, neither ever shown |
| QR of the download URL | how a build reaches a phone in the field | `qrcode-generator`, bundled, drawn as an SVG element |
| SHA-256 of the chosen APK | whether this is the build that was tested | `crypto.subtle` in the browser; the file is never read twice |
| Upload progress | that a 24 MB upload is moving | XHR, replacing the three server-rendered regions rather than reloading |
| Restore preflight | what is in the file, against what is in the database | the file read in the browser; nothing reaches the server |
| Password rules | whether the password will be accepted, before submitting | two comparisons, live |
| Quota consequence line | what happens at the ceiling | the quota already on the page |
| Export contents line | what the download will hold | the counts already on the page |
| ⌘K section jumps | how to reach a section without scrolling | `$pageCommands`, merged into the shell's own palette |

Drag and drop is a second gesture, never a replacement: both `<input
type="file">` elements stay, because they are what a keyboard and a screen
reader operate and the only path where drag events do not exist. The zone
writes into the input through a `DataTransfer` so there is one source of truth
for the chosen file. A contract test counts the file inputs.

Four defects surfaced while building it, none of them visual:

- **The APK upload could not work.** `upload_max_filesize` is 2 MB and
  `post_max_size` 8 MB, so a real APK is discarded whole — and when a body
  exceeds `post_max_size`, PHP empties `$_POST`, `am2_csrf_require()` finds no
  token and answers "Sesi tidak valid. Muat ulang halaman." The operator was
  told their session was broken. The page now states the limit, refuses an
  oversized file before sending it, and maps every `UPLOAD_ERR_*` to its own
  message. **Raising the limits is a server change and has not been made.**
- **The update folder was not writable by the web process** on staging
  (`drwxr-x---`, owner `am2deploy`, group `www-data`). Fixed on staging with
  `chmod g+w`; production has not been checked.
- **`update/` did not exist on staging at all.** The handler would have created
  a real directory inside the deployed tree, which the next rsync erases. The
  card now says so; staging was given the symlink production has.
- **`admin_version.json` points at `admin.apk`, which is not on the shelf.**
  Admin Native is told to download a file that has never been uploaded. The
  card shows this as a warning; nothing else in the panel ever mentioned it.

Two bugs of my own, both invisible without measuring:

- **The page reached for `window.AM2` at parse time.** The bundle is deferred,
  so it had not run; every call site guards with `?.`, so the page rendered
  perfectly and simply had no motion and no QR. `ui-runtime.test.mjs` now fails
  any page that calls `AM2.enterOnce`, `AM2.revealOnScroll` or `AM2.qr` without
  something waiting for the bundle first.
- **Closing the command palette from inside the Enter keydown made Preline
  re-open it 53ms later**, with no click on any trigger — traced with an event
  log, not guessed. Letting the key event finish first fixes it.

Verified: QR renders at 114×116 from a 15,394-character path; a 3 MB file is
refused client-side with the limit named and the submit disabled; a 64 KB APK
uploads through XHR and the alert, version block and shelf list all swap in
from the response; the preflight reads a backup as "Cadangan AM2 (per satwil)"
and shows 218 → 5 devices and 8 → 2 channels with the missing-DROP warning;
password rules tick at 8 characters and on match; ⌘K jumps to the danger zone
with focus landing on the section; ID and EN both render and the confirmation
word follows the locale; no tap target under 40px; nothing under
`prefers-reduced-motion`; no console errors.
