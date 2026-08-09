# Release boundary: why this ships all at once

Explanation. For the mechanics of deploying, see `docs/how-to/deploy-and-roll-back.md`.

## The decision

The redesign and the security work ship as **one atomic release**. There is no
feature flag, no second document root, no route namespace, and no cohort
selector. Rollback is moving the `current` symlink back to the previous
release directory — all of it, at once.

This was a deliberate choice against building a dual-UX boundary, taken 3 Aug
2026. The argument for one was that old and new pages could then be tested and
rolled back independently. The argument against, which won:

- It is one VPS, one symlink, and roughly ten admin users. A cohort selector is
  machinery sized for a problem this deployment does not have.
- Two UIs would run against **one** database, **one** session model and **one**
  relay. The bugs this release fixes — tenant isolation, membership integrity,
  who the caller is — all live in that shared layer. Keeping two front ends
  alive over it doubles the number of places each fix has to be right, which is
  the opposite of what the fixes are for.
- The old pages are the ones with the defects. A flag that keeps them reachable
  is a flag that keeps the defects reachable.

## What this costs

Partial rollback is not available, and must not be attempted. Concretely, these
combinations are broken and there is no adapter for them:

| Combination | Result |
|---|---|
| Old UI + new `config.php` | Old forms carry no `_csrf` field; every POST is refused. |
| Old `dashboard.php` + new `api_dashboard_chart.php` | The old page calls the endpoint with no parameters. It now answers for the session instead, which is correct — but the old page also reads a 7-bucket shape the endpoint no longer returns first. |
| New UI + old `config.php` | `t()`, `am2_asset()`, `am2_api_identity()` and `channel_access.php` are all missing. Fatal on every page. |
| New UI + old `api_*.php` | The pages do not call them directly, so this one is survivable — but the Admin Native app would be talking to endpoints with no superadmin gate. |

## Supported states

Exactly two:

1. **Previous release** — every file from the May build, `current` pointing at it.
2. **This release** — every file from this build, `current` pointing at it.

Moving between them is a symlink change plus an `am2-api` restart. Nothing in
between is supported, and nothing in between is tested.

## What the contract suite guarantees

`tests/contract/` runs against a whole deployed tree, not against files in
isolation. A green suite means *that tree* is consistent. It says nothing about
a tree assembled from two releases, and it is not able to: the tests read the
document root as a unit.

So the operational rule is the simple one. Deploy the release. If it is wrong,
put the symlink back. Do not move individual files, in either direction.
