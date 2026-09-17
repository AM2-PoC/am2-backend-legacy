# Channel access contract

Reference for `WebAdmin/channel_access.php`, the only place `user_channels` is written.

## Why there is a single writer

Membership updates must preserve permission, default-channel, and `users.last_channel_id` consistency across every caller.

## Invariants

Enforced by the service, asserted by `tests/contract/channel-access.test.mjs`:

1. A unit holding at least one channel has **exactly one** default.
2. `users.last_channel_id` always equals that default.
3. A unit holding no channels has `last_channel_id = NULL`. This is a valid
   state — revoking all access — and is the only case where it may be null.
4. A permission is only changed when the caller states it. Silence preserves.
5. A default is only moved when the caller states one that is actually granted.
6. Editing one channel's roster touches no other channel's rows.

## The two entry points

```php
am2_set_user_channels(PDO $pdo, string $userId, array $channelIds,
                      ?string $defaultId = null, array $perms = []): array
```

The complete set of channels a user holds. `$defaultId` and `$perms` are both
optional and partial: anything not stated keeps the value already in the row.
Returns `['granted', 'revoked', 'default', 'permissions']`.

```php
am2_set_channel_members(PDO $pdo, string $channelId, array $userIds,
                        ?array $scopeUserIds = null): array
```

The complete roster of one channel. `$scopeUserIds` limits which rows this
caller may remove, so a branch admin editing a shared channel cannot evict
another tenant's units. A unit removed from its default channel is resettled
onto another channel it still holds rather than left stranded. Returns
`['added', 'removed', 'resettled']`.

Both must run inside a transaction and neither contacts the relay: they return
the user ids they touched so the caller can sync **after** the commit, and see
that sync fail.

## Permission values

The check constraint on `user_channels.permission` allows `RX`, `TX`,
`FULL DUPLEX` and the historical column default `rxtx`. Only `RX` means
receive-only; the relay lets every other value transmit. Legacy values are
passed through untouched — a membership edit is not the place to migrate them.

## Authorization

The ids arrive over POST. A form rendered from this admin's own units is not an
authorization, so every surface checks:

- `am2_admin_owns_user()` — the unit belongs to this admin, or the caller is a
  superadmin.
- `am2_first_foreign_channel()` — the channel was created by this admin or
  delegated to it through `admin_managed_channels`, which is the same pair of
  conditions `channels.php` lists the page with. `channels` has no `admin_id`.
