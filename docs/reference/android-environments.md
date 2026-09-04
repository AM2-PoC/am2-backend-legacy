# Android environments

`config/android-environments.json` is the machine-readable identity contract for the Client and Admin Android apps.

| Environment | Client package | Admin package | Purpose |
|---|---|---|---|
| DEV | `com.am2.tik.dev` | `com.am2.admin.dev` | Synthetic development data and non-production credentials |
| staging | `com.am2.tik.staging` | `com.am2.admin.staging` | Release-candidate integration and acceptance |
| production | `com.am2.tik` | `com.am2.admin` | Runtime-only production release |

DEV and staging packages install alongside production and use visibly suffixed app labels. Their API, WebSocket, WebAdmin, and update endpoints must never resolve to production hosts. Endpoint records use HTTPS/WSS only. The deployed staging Client API and update host is `staging-apiapi.am2-poc.com`; source contracts bind both staging endpoints to that one hostname.

The listed DEV hostname is a contract target; it does not claim that separated DEV infrastructure is already provisioned. Current staging is transitional and co-resident, so it is not the final isolation boundary.

Production promotion is disabled until protected signing, independent approval, same-digest staging acceptance, physical-device acceptance, and rollback rehearsal are proven. Production promotion selects the accepted APK digest; it does not rebuild the APK.
