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

| Preline component | Free | Docs | Target file | Adapted from | AM2 changes |
|---|---|---|---|---|---|
| _(shell pending)_ | | | | | |
