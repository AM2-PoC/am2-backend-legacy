# Authorization incident evidence closure

Status: attribution-limited; blast radius reconciled.

The affected durable data has been reconciled against the 10:03 pre-incident dump and the 14:26 pre-repair snapshot. The deleted branch data was restored; current durable channel state matches the baseline, and later differences are attributable to legitimate post-recovery operation. No unresolved orphan or durable-integrity mismatch remains.

Two earlier anonymous requests are retained in the access log:

- 11:32:16 — `POST /api_users.php` → 200
- 11:33:03 — `POST /api_channels.php` → 200
- Client: Android `okhttp/4.12.0`

The retained access log does not contain either request body or action parameter. No database snapshot exists between those requests and the destructive 11:35:58 admin deletion. Dump comparison can bound resulting durable state but cannot recover which action either request attempted. Therefore these requests must not be described as harmless, fully attributed, or reconstructed. Absence of an audit row is not evidence that no mutation occurred.

```text
incident classification: attribution-limited
blast radius reconciled: yes
durable integrity recovered: yes
exact request actions: unknown
per-request attribution: impossible from retained evidence
remaining durable-integrity blocker: none
```

The control gaps are handled separately by fail-closed authentication, client-IP attribution, restricted admin deletion, immutable delivery, Admin session handling, and the sole-writer contract. This note records the evidence limit; it does not claim that the two opaque requests were harmless.
