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
