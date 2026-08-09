I have the full picture. Here is the contract documentation.

---

# AM2 Backend Contract — Full Reference

Scope read: `/var/www/am2/current/WebAdmin/*.php`, `/var/www/am2/current/server/server.js`, `/var/www/am2/current/server/struktur_am2.sql`, `/etc/am2/*.env*`, `/etc/systemd/system/am2-api.service`. `APK AM2/` and `APK Admin_Native/` were not opened.

---

## 0. Topology (read this first)

Two distinct API surfaces exist and they are **not** the same thing:

| Surface | Consumer | Auth |
|---|---|---|
| `WebAdmin/*.php` **panel pages** (`dashboard.php`, `users.php`, `channels.php`, `user_access.php`, `logs.php`, `settings.php`, `livetrack.php`, `admin_panel.php`) | Browser (the PHP dashboard) | PHP `$_SESSION` |
| `WebAdmin/api_*.php` | **Admin Native APK** (mobile admin app) | **None** — `admin_id`/`role` passed as plain request params |
| `WebAdmin/fetch_logs.php`, `get-users-ajax.php` | Browser (panel AJAX) | `$_SESSION` |
| `WebAdmin/get_users_location.php`, `update_location.php` | Unauthenticated (APK/legacy) | **None** |
| `server.js` `/api/admin/*` | PHP panel → Node, server-to-server over `http://localhost:5000` | **None** |
| `server.js` `/api/check-update`, `/update/*`, WebSocket | AM2 user APK | WS: `app_login` message |

A UI redesign only touches the first row. Rows 2–6 must remain byte-identical.

---

## 1. PHP API endpoints

### Global facts that apply to nearly all of them

- **None of the `api_*.php` files call `session_start()` except `api_user_access.php`** (`api_user_access.php:5-7`), and even there the session is never *checked*. Authorization is entirely `$_GET['admin_id']` / `$_GET['role']` supplied by the caller — trivially forgeable.
- `header('Content-Type: application/json')` is emitted at line 2 of every `api_*.php`.
- **Failure almost always returns HTTP 200** with `{"success":false,...}` or `{"error":...}`. Only a handful of read paths call `http_response_code(500)`.
- There is **no `Allow`/405 handling** in most files: an unmatched method or `action` falls through and produces an **empty response body with HTTP 200**.

---

### 1.1 `api_admin_panel.php`

**GET** — no params.
Success (200), a **bare JSON array** of admin rows:

```php
// api_admin_panel.php:27-37
foreach ($admins as &$adm) {
    $adm['channel_ids'] = json_decode($adm['channel_ids'] ?? '[]', true) ?: [];
    $adm['can_manage_maps'] = (bool)$adm['can_manage_maps'];
    $adm['can_manage_p2p'] = (bool)$adm['can_manage_p2p'];
    $adm['can_manage_video'] = (bool)$adm['can_manage_video'];
    $adm['user_quota'] = (int)$adm['user_quota'];
    $adm['channel_quota'] = (int)$adm['channel_quota'];
    unset($adm['password_hash']);
}
echo json_encode($admins);
```

Element shape (`SELECT a.*` at `api_admin_panel.php:10`, so all `admin` columns minus `password_hash`): `id:int, username:string, role:string, created_at:string, max_channels:int, status:string, user_quota:int, channel_quota:int, expired_at:string|null, can_manage_p2p:bool, can_manage_maps:bool, can_manage_video:bool, current_status:string ('expired'|status), channel_ids:int[]`.

Error (**500**):
```php
// api_admin_panel.php:38-41
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
```

**POST**, dispatched on `$_POST['action']` (`api_admin_panel.php:44`):

- `action=save` — params: `admin_id:int|empty` (empty ⇒ insert), `username:string`, `password:string`, `role:string` (`admin`|`superadmin`), `user_quota:int`, `channel_quota:int`, `expired_at:date|empty`, `can_manage_maps|can_manage_p2p|can_manage_video` = literal string `"true"`/`"false"` (`:54-56`). Note `role==='superadmin'` forces both quotas to `999999` (`:51-52`).
  ```php
  // api_admin_panel.php:68  (update path)
  echo json_encode(['success' => true, 'message' => 'Admin updated']);
  // api_admin_panel.php:73  (insert path)
  echo json_encode(['success' => true, 'message' => 'Admin created']);
  // api_admin_panel.php:75-77
  } catch (PDOException $e) {
      echo json_encode(['success' => false, 'message' => $e->getMessage()]);
  }
  ```
  Status: **always 200.**
- `action=delete` — param `id:int`. `DELETE ... AND role != 'superadmin'` (`:82`). Returns `{"success":true,"message":"Admin deleted"}` **even when 0 rows were deleted**.
- `action=delegate` — params `target_admin_id:int`, `channels:int[]` (form array `channels[]`). Returns `{"success":true,"message":"Delegation updated"}` (`:102`) or `{"success":false,"message":...}` (`:105`).

Unknown `action` ⇒ **empty body, 200**.

---

### 1.2 `api_channels.php`

Shared params read from either GET or POST (`api_channels.php:10-11`): `admin_id`, `role` (default `'admin'`).

**GET, `action=get_users_access`** — param `channel_id:int`.
```php
// api_channels.php:21-26
$stmt = $pdo->prepare("SELECT user_id FROM public.user_channels WHERE channel_id = ?");
$stmt->execute([$ch_id]);
echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
```
⇒ bare array of user-id strings, e.g. `["001","002"]`. Error ⇒ `{"error":"..."}` at **200**.

**GET (no action)** — role-scoped channel list. Bare array; element = all `channels` columns plus `creator_name:string|null`, `ownership_type:'OWNER'|'DELEGATED'`, `online_count:int-as-string`, `total_access:int-as-string`. Error: `http_response_code(500)` + `{"error":...}` (`:57-60`).

**POST `action=add`** — `display_name:string`. `name` is derived: `strtolower(str_replace(' ','_',$display_name))` (`:67`), `category` hard-coded `'public'`. ⇒ `{"success":true}` (`:73`) / `{"success":false,"message":...}` (`:75`).

**POST `action=delete`** — `id:int`. Ownership guard for non-superadmin:
```php
// api_channels.php:87
echo json_encode(['success' => false, 'message' => 'Hanya pemilik (Owner) atau Superadmin yang dapat menghapus channel ini.']);
```
Cascade at `:99-103` clears `users.current_channel`, deletes from `ptt_logs`, `admin_managed_channels`, `user_channels`, then `channels`. ⇒ `{"success":true}` (`:106`), `{"success":false,"message":"Channel tidak ditemukan"}` (`:108`), or `{"success":false,"message":<pdo msg>}` (`:112`). Always **200**.

**POST `action=save_access`** — `channel_id:int`, `users` = **JSON-encoded string** of an id array (`json_decode($_POST['users'] ?? '[]', true)`, `:117`). Inserts with hard-coded `is_default='false'`, `permission='FULL DUPLEX'` (`:126`). After commit, fires `syncUserChannels($uid)` per user (`:130`). ⇒ `{"success":true}` / `{"success":false,"message":...}`.

---

### 1.3 `api_dashboard_chart.php`

**Any method.** Params `admin_id`, `role` (GET or POST, `:5-6`). Sets `SET TIME ZONE 'Asia/Jakarta'` (`:9`).

```php
// api_dashboard_chart.php:47-52
echo json_encode([
    'labels' => $labels,
    'values' => $values,
    'status' => 'success',
    'timestamp' => date('Y-m-d H:i:s')
]);
```
`labels: string[]` (`"HH:00"`), `values: int[]`. 24 buckets via `generate_series`.
Error: `{"error":...}` at **200** (`:54-56`) — no 500, and **no `status` key**, so a client keying off `status` sees `undefined`.

---

### 1.4 `api_dashboard_stats.php`

**GET.** Params `admin_id`, `role`.
```php
// api_dashboard_stats.php:32-36
echo json_encode([
    'total_user' => (int)$total_user,
    'user_online' => (int)$user_online,
    'total_channel' => (int)$total_channel
]);
```
Error: `{"error":...}` at **200** (`:38`).

---

### 1.5 `api_get_users.php`

**GET.** Params `admin_id`, `role`. Returns only `status='online'` users. `Content-Type` header is emitted *after* the body is built (`:63`).

```php
// api_get_users.php:49-60
$results[] = [
    'id'           => $user['id'],
    'name'         => htmlspecialchars($user['name']),
    'lat'          => (float)$user['latitude'],
    'lng'          => (float)$user['longitude'],
    'accuracy'     => (float)$user['accuracy'],
    'is_online'    => 1,
    'is_speaking'  => (int)$user['is_speaking'],
    'is_stale'     => $is_stale,
    'channel_name' => $user['channel_name'] ?? 'Standby',
    'updated_at'   => $user['updated_at']
];
```
`is_stale` = `updated_at` older than 60 s (`:48`). `is_speaking` = last `ptt_logs` row is `PUSH`/`PUSH_PRIVATE` within 7 s (`:22-25`).
Error: **500** + `{"error":...}` (`:66-68`).

⚠️ `name` is HTML-escaped **inside JSON** — a redesign that renders it as text will show `&amp;` literals.

---

### 1.6 `api_login.php`

**POST only.** Params `username:string`, `password:string`.

```php
// api_login.php:18-24
echo json_encode([
    'success' => true,
    'message' => 'Login Berhasil',
    'admin_id' => (int)$user['id'],
    'username' => $user['username'],
    'role' => $user['role']
]);
```
Failures, all **HTTP 200**:
- `{"success":false,"message":"Akun Anda sedang dinonaktifkan."}` (`:16`)
- `{"success":false,"message":"Username atau Password salah."}` (`:27`)
- `{"success":false,"message":"Kesalahan sistem: <pdo msg>"}` (`:30`)
- non-POST ⇒ `{"success":false,"message":"Method not allowed"}` (`:33`) — **status 200, not 405.**

No session is created. The mobile admin app is expected to carry `admin_id`/`role` in every subsequent request.

---

### 1.7 `api_logs.php`

**GET.** Param `category:'ALL'|'PTT'|'ADM'` (default `'ALL'`). LIMIT 50 per source; `ALL` merges and re-slices to 50 (`:45-50`).

Bare array; element shape (note **Indonesian keys**):
`id:string, jam:"HH:MM:SS", tanggal:"DD/MM/YYYY", raw_time:string, pelaksana:string, pelaksana_id:string, target:string, aksi:string, kategori:'PTT'|'ADM'`.

```php
// api_logs.php:52
echo json_encode($results);
// api_logs.php:54-57
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
```

---

### 1.8 `api_settings.php`

**GET `action=export_db`** (`:7-31`) — params `admin_id:int`, `role`. Not JSON: streams a `pg_dump` via `passthru()` with `Content-Type: application/octet-stream` and an attachment filename. Superadmin gets `-n public`; others get `-t public.users -t public.channels --column-inserts`. Uses `$host/$port/$user/$dbname/$password` globals from `config.php`.

**GET `action=check_update`** (`:38-55`) — reads `update/admin_version.json` (symlink → `/var/www/am2/shared/webadmin-update`).
```php
// api_settings.php:42-46
echo json_encode([
    'latest_version' => $data['version_name'],
    'download_url'   => $data['download_url'],
    'changelog'      => $data['changelog']
]);
```
Fallback when the file is absent (`:48-52`): `{"latest_version":"1.0.0","download_url":"https://am2-poc.com/update/admin.apk","changelog":"Versi awal."}`.

**GET (no action)** — params `admin_id:int`, `role`. Returns a single object: `username, role, user_quota, channel_quota, expired_at, can_manage_maps:bool, can_manage_p2p:bool, can_manage_video:bool, total_admins:int, total_users:int, total_channels:int` (`:78-85`). Not found ⇒ `{"error":"Settings not found"}` at **200** (`:87`). PDO error ⇒ **500** + `{"error":...}` (`:90-91`).

**POST `action=update_password`** — `admin_id:int`, `new_password:string`.
```php
// api_settings.php:100-108
if (strlen($new_pass) < 8) { echo json_encode(['success'=>false,'message'=>'Password minimal 8 karakter']); exit; }
...
echo json_encode(['success' => true, 'message' => 'Password diperbarui']);
```
**No old-password check, and no verification that `admin_id` is the caller.**

**POST `action=import_db`** — multipart `sql_file`. Shells out `psql ... < tmpfile` (`:121-122`). ⇒ `{"success":true,"message":"Database berhasil dipulihkan"}` or `{"success":false,"message":"File .sql tidak ditemukan"}` (`:115`). All **200**. `shell_exec` return value is discarded, so failure is reported as success.

---

### 1.9 `api_user_access.php`

**GET** — params `admin_id`, `role`, `search:string`.
```php
// api_user_access.php:76-83
foreach ($result as &$row) {
    $row['id'] = (string)$row['id'];
    $row['channel_ids_json'] = json_decode($row['channel_ids_json'] ?? '[]', true) ?: [];
    $row['permissions_json'] = json_decode($row['permissions_json'] ?? '[]', true) ?: [];
    $row['default_id'] = $row['default_id'] ? (int)$row['default_id'] : null;
}
echo json_encode($result);
```
Element: `id:string, name:string, allowed_channels:string|null` (comma-joined display names, default prefixed `*`), `channel_ids_json:int[]`, `permissions_json:string[]`, `default_id:int|null`. Error ⇒ **500** + `{"error":...}` (`:85-86`).

🐛 **Broken SQL on the search path** — `api_user_access.php:64`:
```php
$sql .= " AND (u.name ILIKE ? u.id::text ILIKE ?)";
```
Missing `OR`. Any request with `?search=` non-empty throws a syntax error and returns **500**. This is pre-existing; preserve or fix deliberately, but note the current observable contract is "500 on search".

**POST `action=force_logout`** — `user_id:string`, `admin_id` (optional, for the audit row). Sets `force_logout=TRUE, status='offline', current_device_id=NULL` (`:102`), writes an `admin_activity_logs` row with `aksi='FORCE_LOGOUT'` and `keterangan` suffixed `" (via Mobile)"` (`:106-107`), then POSTs to Node `/api/admin/force-logout` (`:111`).
```php
// api_user_access.php:112
echo json_encode(['success' => true, 'message' => 'User berhasil dikeluarkan.']);
// api_user_access.php:115
echo json_encode(['success' => false, 'message' => $e->getMessage()]);
```

**POST `action=update_access`** — `user_id:string`, `channels:int[]` (form array), `default_channel:int|null`, `permissions` = **JSON string** map `{channelId: "RX"|...}` (`:122`). Any value other than `"RX"` becomes `'FULL DUPLEX'` (`:147`). If `default_channel` is absent or not in `channels`, the first selected channel wins (`:138-140`). Mirrors the choice into `users.last_channel_id` (`:152`, `:161`). Then `syncUserChannels($user_id)` (`:171`).
⇒ `{"success":true,"message":"Otoritas akses user berhasil diperbarui."}` (`:172`) / `{"success":false,"message":...}` (`:175`). All **200**.

---

### 1.10 `api_users.php`

Shared params `admin_id`, `role` from GET or POST (`:30-31`).

**GET `action=get_user_channels`** — `u_id:string` ⇒ bare array of `channel_id` ints (`:43`). Error ⇒ `{"error":...}` at 200.

**GET (no action)** — `search:string`. Bare array, element:
```php
// api_users.php:78-83
$u['enable_maps'] = (bool)$u['enable_maps'];
$u['enable_p2p'] = (bool)$u['enable_p2p'];
$u['enable_ptt_video'] = (bool)$u['enable_ptt_video'];
$u['admin_id'] = $u['admin_id'] ? (int)$u['admin_id'] : null;
```
⇒ `id:string, name:string, status:string, admin_id:int|null, current_channel:string|null, enable_maps:bool, enable_p2p:bool, enable_ptt_video:bool, duplex_mode:string`. Error ⇒ **500** + `{"error":...}` (`:87-88`).

**POST `action=add`|`edit`** — `id:string`, `name:string` (upper-cased, `:96`), `password:string` (optional on edit). `add` also seeds a `user_app_permissions` row with everything false and `'HALF DUPLEX'` (`:111`).
⇒ `{"success":false,"message":"Data tidak lengkap"}` (`:100`), `{"success":true,"message":"User berhasil ditambahkan|diperbarui"}` (`:124`), `{"success":false,"message":"Gagal: ..."}` (`:127`). All **200**.

**POST `action=save_user_channels`** — `u_id:string`, `channels` = JSON string array. First element becomes default and is copied to `users.last_channel_id` (`:143-146`); empty list nulls it (`:149`). Then `syncUserChannels`. ⇒ `{"success":true}` / `{"success":false,"message":...}`.

**POST `action=update_feature`** — `u_id:string`, `feature:string`, `val:string`.
⚠️ **`$feature` is interpolated directly into SQL** with no allow-list here (contrast `users.php:126` which does validate):
```php
// api_users.php:174-177
$sql = "INSERT INTO public.user_app_permissions (user_id, $feature, updated_at)
        VALUES (?, $sql_val, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET $feature = EXCLUDED.$feature, updated_at = NOW()";
```
On success calls `notifyPermissionUpdate(...)` → Node `/api/admin/update-permissions` (`:185`). ⇒ `{"success":true}` (`:186`) / `{"success":false,"message":...}` (`:189`).

**POST `action=delete`** — `id:string`. `DELETE ... AND role='user'` ⇒ `{"success":true}` (`:196`) unconditionally.

---

### 1.11 `fetch_logs.php` — session-authenticated (panel)

**Any method.** No params. Requires `$_SESSION['admin_logged_in']`.
```php
// fetch_logs.php:6-9
if (!isset($_SESSION['admin_logged_in'])) {
    header('Content-Type: application/json');
    exit(json_encode(['error' => 'Unauthorized']));
}
```
⚠️ Unauthorized is returned with **HTTP 200**, not 401.

Success:
```php
// fetch_logs.php:50-51
header('Content-Type: application/json');
echo json_encode(['ptt' => $ptt_logs, 'adm' => $adm_logs]);
```
Both arrays LIMIT 100, scoped to the session admin unless superadmin (`:17`, `:34`). Element keys: `id, aksi, jam, tanggal, raw_time, target, pelaksana, pelaksana_id, kategori`. `raw_time` here is a **timestamp**, whereas `api_logs.php` casts it `::text` — the shapes differ subtly between the two log endpoints. Error ⇒ `{"error":...}` at **200** (`:55`).

---

### 1.12 `get-users-ajax.php` — session-authenticated (panel, livetrack)

**Any method.** No params. This is the **only** file in the panel that returns a correct **401**:
```php
// get-users-ajax.php:5-9
if (!isset($_SESSION['admin_logged_in'])) {
    header('Content-Type: application/json', true, 401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}
```
Success body is identical in shape to `api_get_users.php` (`:62-73`) — same 10 keys, same `htmlspecialchars($user['name'])`, same 60-second `is_stale`, same 7-second `is_speaking`.
Error ⇒ **500** + `{"error":"Database Sync Failed","details":"<pdo msg>"}` (`:80-84`).

---

### 1.13 `get_users_location.php` — **no auth at all**

**Any method.** Param `search:string`. Joins `channels` on `users.last_channel_id` (not `current_channel` like the other two).
```php
// get_users_location.php:41-51
return [
    'id'           => $user['id'],
    'name'         => $user['name'],
    'lat'          => (float)$user['lat'],
    'lng'          => (float)$user['lng'],
    'accuracy'     => (float)$user['accuracy'],
    'status'       => $user['status'],
    'is_online'    => ($user['status'] === 'online'),
    'channel_name' => $user['active_channel_name'] ?? 'No Channel',
    'updated_at'   => $user['updated_at']
];
```
Note the divergence from `get-users-ajax.php`: `status` present, `is_online` is a **bool** not `1`, no `is_speaking`, no `is_stale`, default channel label is `'No Channel'` not `'Standby'`, `name` is **not** escaped.
Error ⇒ **500** + `{"error":"Database Error","message":...}` (`:58-62`).

---

### 1.14 `update_location.php` — **no auth at all**

**POST only.** Params `user_id:string`, `latitude`, `longitude`, `accuracy` (default 0).
```php
// update_location.php:4-7
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('HTTP/1.1 405 Method Not Allowed');
    exit(json_encode(['status' => 'error', 'message' => 'Gunakan metode POST']));
}
```
The only **405** in the codebase. Missing fields ⇒ `{"status":"error","message":"Data tidak lengkap"}` at **200** (`:15`). Success ⇒ `{"status":"success","message":"Lokasi diperbarui","user":<user_id>}` (`:37-41`); zero rows ⇒ `{"status":"error","message":"User ID tidak ditemukan di database"}` (`:43-46`). PDO error ⇒ **500** + `{"status":"error","message":...}` (`:50-51`).

Also note it **forces `status='online'`** as a side effect of a location ping.

---

### 1.15 `assign.php` — **returns a full HTML page, not JSON**

`session_start()` + redirect to `login.php` if unauthenticated (`:3`). **GET** renders the page; **POST with `assign` set** writes `user_channels`. Params: `user_id`, `channel_id`, `is_rx` (checkbox presence ⇒ `'true'`/`'false'`).

```php
// assign.php:12-16
$stmt = $pdo->prepare("INSERT INTO user_channels (user_id, channel_id, is_rx_only) VALUES (?, ?, ?) 
                       ON CONFLICT (user_id, channel_id) DO UPDATE SET is_rx_only = EXCLUDED.is_rx_only");
$stmt->execute([$user_id, $channel_id, $is_rx]);
$msg = "<div class='alert alert-success'>Akses Berhasil Diperbarui!</div>";
```

⚠️ **This file is dead/broken.** It writes `user_channels.is_rx_only`, a column that **does not exist** in `struktur_am2.sql` (the real column is `permission`). Every POST here throws, and the listing query at `:78-81` also selects `uc.is_rx_only`, so the page fatals on render too. It is not linked from `sidebar.php`. Treat as removable — but confirm with the user before deleting, since "no endpoint may change" was stated as absolute.

Always **HTTP 200**. Also: unescaped `{$u['name']}` / `{$c['name']}` interpolation into `<option>` at `:53` and `:59`, and `{$l['uname']}` at `:84` — XSS sinks.

---

### 1.16 `create_admin.php` — **returns a full HTML page, not JSON**

`session_start()` + redirect if unauthenticated (`:3-6`). **POST** params `id`, `name`, `password`.

```php
// create_admin.php:20-23
$stmt = $pdo->prepare("INSERT INTO users (id, name, password, role, status) VALUES (?, ?, ?, ?, 'offline')");
$stmt->execute([$id, $name, $hashed_password, $role]);
$message = "<div class='alert alert-success'>Admin [$name] Berhasil Dibuat!</div>";
```

⚠️ **Also legacy/wrong.** It inserts into `public.users` with `role='superadmin'` — but panel login (`login.php:17`) authenticates against `public.admin`. An account created here **cannot log into the panel**. The listing at `:84` also reads `users WHERE role='superadmin'`. `admin_panel.php` is the real admin-creation path. Not linked from `sidebar.php`. Always **200**.

---

### 1.17 `logout.php`

Entire file:
```php
// logout.php:1-5
<?php
session_start();
session_destroy();
header("Location: login.php");
?>
```
**Any method**, no params, no CSRF token, **HTTP 302** to `login.php`. Note it does **not** call `session_unset()` or clear the session cookie, and it is reachable by GET — so any cross-site `<img src="logout.php">` logs the admin out.

---

## 2. Node.js HTTP endpoints (`server.js`)

**Zero authentication on every route.** No API key, no bearer token, no IP allow-list, no `express` auth middleware. `app.use(cors())` at `server.js:53` is wide-open (`Access-Control-Allow-Origin: *`). The only thing keeping `/api/admin/*` private is that the port is not proxied by Apache (no `ProxyPass` found in `/etc/apache2/sites-enabled/`) — the PHP calls all go to `http://localhost:5000` directly.

| Route | Line | Consumer | Params | Success | Error |
|---|---|---|---|---|---|
| `GET /` | `246` | health | — | `200` `text/html` `<h1>PTT Server</h1>...` | — |
| `GET /update/*` (static) | `59-66` | **APK** | — | file; `.apk` gets `application/vnd.android.package-archive` + `Content-Disposition: attachment; filename="update.apk"` | 404 |
| `GET /api/check-update` | `252` | **APK** | — | see below | `404` / `500` |
| `POST /api/admin/set-app-version` | `277` | admin (**no PHP caller found**) | JSON `version_code:int, version_name:string, force_update:bool?, release_notes:string?` | `{success:true, message:"Versi <name> berhasil didaftarkan."}` | `500 {success:false,error}` |
| `GET /api/admin/sync-channels` | `297` | **panel + APK-admin** | query `userId` | `{success:true, message:"Sync command sent to user."}` | `400 {error:"userId is required"}`, `500 {success:false,error}` |
| `POST /api/admin/refresh-branch-permissions` | `308` | **panel only** | JSON `adminId` | `{success:true, message:"Updated N users in branch."}` | `400 {error:"adminId is required"}`, `500 {error}` |
| `POST /api/admin/update-user-profile` | `372` | admin APK (**no PHP caller**) | JSON `userId, name` | `{success:true, message:"User profile updated and synced."}` | `400 {error:"userId and name are required"}`, `500 {error}` |
| `POST /api/admin/update-channel` | `398` | admin APK (**no PHP caller**) | JSON `channelId, display_name` | `{success:true, message:"Nama channel diperbarui dan disinkronkan."}` | `500 {success:false,error}` |
| `POST /api/admin/assign-channel` | `409` | admin APK (**no PHP caller**) | JSON `userId, channelId, permission?` (default `'TX'`) | `{success:true, message:"Channel assigned & synced."}` | `500 {success:false,error}` |
| `POST /api/admin/remove-channel` | `426` | admin APK (**no PHP caller**) | JSON `userId, channelId` | `{success:true, message:"Channel access removed & synced realtime."}` | `500 {success:false,error}` |
| `POST /api/admin/update-permissions` | `442` | **panel + APK-admin** | JSON `userId, enable_maps, enable_p2p, enable_ptt_video, duplex_mode` | `{success:true, message:"Permissions updated successfully."}` | `500 {success:false,error}` |
| `POST /api/admin/set-permission` | `486` | admin APK (**no PHP caller**) | JSON `userId, channelId, permission` | `{success:true, message:"Izin berhasil diperbarui."}` | `500 {success:false,error}` |
| `POST /api/admin/force-logout` | `503` | **panel + APK-admin** | JSON `userId` | `{success:true, message:"User <id> berhasil dikeluarkan."}` or `{success:true, message:"User sudah offline, status database telah direset."}` | `500 {success:false,error}` |

`GET /api/check-update` response (`server.js:261-268`):
```js
res.json({
    success: true,
    server_version_code: result.rows[0].version_code,
    server_version_name: result.rows[0].version_name,
    force_update: result.rows[0].force_update,
    release_notes: result.rows[0].release_notes,
    update_url: `http://${req.headers.host}/update/update.apk`
});
```
`update_url` is built from the **client-supplied `Host` header** — host-header injection into the APK's download URL.

`update-permissions` has a latent crash: `targetWs.sessionUser.admin_id` at `server.js:459` is dereferenced without a null guard, and `ws.sessionUser` is initialised to `null` (`:541`). A connected-but-unauthenticated socket in `activeConnections` would throw. (In practice sockets only enter the map after `app_login`, so this is theoretical.)

---

## 3. WebSocket protocol

`new WebSocket.Server({ server })` at `server.js:529` — same port 5000, path `/`. 30-second ping/pong liveness sweep (`:531-537`); dead sockets are `terminate()`d.

### 3.1 Per-connection state (`server.js:539-549`)
`isAlive, sessionUser (null until login), currentRoom, currentChannelId, is_rx_only=false, ptpTargetId=null, enable_maps=true, enable_p2p=true, enable_ptt_video=false, duplex_mode='HALF DUPLEX'`.

### 3.2 Binary frames (`server.js:553-589`)

Frames are raw; **byte 0 is the type tag**:

| `message[0]` | Meaning | Gate |
|---|---|---|
| `1` | Audio | dropped if `ws.is_rx_only` (`:564`); **also dropped unless the sender is currently in `activeSpeakers` for the room** (`:567-575`) — i.e. a `ptt_audio_start` must have succeeded first |
| `2` | Video | dropped unless `ws.enable_ptt_video` (`:577`) |

Routing: if `ws.ptpTargetId` is set the frame is unicast to that peer (`:558-562`); otherwise it is fanned out to every socket in `channelRooms.get(ws.currentRoom)` **except** the sender and except peers currently in a P2P call (`:581-585`). Unauthenticated sockets are dropped at `:555`.

### 3.3 JSON control messages — **client → server** (`switch(type)` at `server.js:595`)

| type | `data` fields | Effect |
|---|---|---|
| `app_login` | `username, password, current_device_id, latitude?, longitude?, accuracy?, address?` | bcrypt verify; admin status/expiry gate; requires a valid `last_channel_id` **and** a matching `user_channels` row; double-login prevention keyed on `current_device_id` with a 10 s grace period; sets `users.status='online'`, `current_device_id`, `is_speaking=false`; logs `LOGIN` |
| `update_location` | `latitude, longitude, accuracy, address` | `updateUserLocation` + `broadcastUsersInChannel` |
| `join_channel` | `new_channel_slug` | verifies membership; moves rooms; syncs Redis speaker/video sets; transactionally sets `users.current_channel`/`last_channel_id` and flips `user_channels.is_default` |
| `ptt_audio_start` | — | **HALF DUPLEX server-side lockout** (`:807`); adds to `activeSpeakers` + Redis `speakers:<slug>`; `users.is_speaking=true`; logs `PUSH` |
| `ptt_audio_end` | — | removes from set; `is_speaking=false`; logs `RELEASE` |
| `ptt_video_start` / `ptt_video_end` | — | Redis `video:<slug>` set; no DB log |
| `ptt_audio_start_private` | `target_id` | sets `ptpTargetId`; logs `PUSH_PRIVATE` |
| `ptt_audio_end_private` | `target_id?` | logs `RELEASE_PRIVATE` |
| `request_ptp` | `target_id` | requires `enable_p2p` |
| `accept_ptp` | `target_id` | binds both sockets' `ptpTargetId` |
| `request_ptp_video` / `accept_ptp_video` | `target_id` | requires `enable_p2p` **and** `enable_ptt_video` |
| `ptt_video_start_private` / `ptt_video_end_private` | `target_id` | |
| `cancel_ptp` | — | `clearPtpSession(ws)` |

Unrecognised `type` falls through silently. Malformed JSON is swallowed (`:592`).

### 3.4 JSON control messages — **server → client**

`login_success` (`:698`), `login_error` (`:618, 623, 626, 630, 642, 711, 715`), `channels_updated` (`:139`), `permission_update` (`:150, 351, 467`), `users_online` (`:198`), `join_channel_success` (`:792`), `ptt_active_status` (`:744, 828, 846, 881, 894, 977`), `ptt_error` (`:808`), `video_stream_status` (`:856, 866, 947, 954`), `ptp_invitation` (`:905`), `ptp_confirmed` (`:917`), `ptp_video_invitation` (`:929`), `ptp_video_confirmed` (`:941`), `ptp_failed` (`:902, 907, 926, 931`), `ptp_cancelled` (`:239`), `force_logout` (`:336, 511`), `user_profile_update` (`:383`).

### 3.5 Disconnect handling (`server.js:966-999`)

On `close`: the user is immediately removed from `activeSpeakers` and a `ptt_active_status` is broadcast, but the *offline* transition is **debounced by `DISCONNECT_GRACE_PERIOD = 10000` ms** (`:46`). After 10 s, if the socket is still the registered one, it sets `status='offline', current_channel=NULL, current_device_id=NULL, is_speaking=false` and logs `LOGOUT`. This is why the panel's "online" counts can lag ~10 s behind reality.

### 3.6 ⭐ The `refresh-branch-permissions` path — full trace

This is the one you remembered. It is the **only** panel→Node→live-WS push, and it is fired from exactly one place.

**Step 1 — PHP defines the caller** (`admin_panel.php:13-26`):
```php
function notifyNodeServerToRefresh($adminId) {
    $url = "http://localhost:5000/api/admin/refresh-branch-permissions";
    $data = array('adminId' => $adminId);
    $options = array(
        'http' => array(
            'header'  => "Content-type: application/json\r\n",
            'method'  => 'POST',
            'content' => json_encode($data),
            'timeout' => 2
        )
    );
    $context  = stream_context_create($options);
    @file_get_contents($url, false, $context);
}
```

**Step 2 — it is invoked in exactly one branch** — the *edit* path of the superadmin's admin-save form, **never** on create (`admin_panel.php:68-85`):
```php
if ($admin_id) {
    $sql = "UPDATE public.admin SET username = ?, role = ?, ... status = 'active'";
    ...
    $pdo->prepare($sql)->execute($params);

    notifyNodeServerToRefresh($admin_id);   // <-- admin_panel.php:80
} else {
    // INSERT path — NO notify call
}
```

**Authentication:** none, in either direction.
- Panel side: the only gate is the page-level session check at `admin_panel.php:5-8` (`admin_logged_in` **and** `admin_role === 'superadmin'`), plus the form POST carrying `save_admin`. There is no CSRF token on that form.
- Node side: `POST /api/admin/refresh-branch-permissions` has **no auth whatsoever**. Anyone who can reach `localhost:5000` can force-refresh (or force-logout) an entire branch by POSTing `{"adminId":N}`.
- Transport: plain HTTP, `@`-suppressed, 2-second timeout, **return value discarded**. If Node is down the panel reports success anyway.

**Step 3 — Node side** (`server.js:308-370`). It iterates every live socket, filtering on `ws.sessionUser.admin_id == adminId` (loose `==`, `:317`), and for each match re-reads the effective permission set:
```js
const permRes = await pool.query(`
    SELECT u.id, p.enable_maps, p.enable_p2p, p.enable_ptt_video, p.duplex_mode,
           a.status as admin_status, a.expired_at as admin_expired_at,
           a.can_manage_maps, a.can_manage_p2p, a.can_manage_video,
           uc.permission as channel_perm
    FROM public.users u
    LEFT JOIN public.user_app_permissions p ON u.id = p.user_id
    LEFT JOIN public.admin a ON u.admin_id = a.id
    LEFT JOIN public.user_channels uc ON u.id = uc.user_id AND u.last_channel_id = uc.channel_id
    WHERE u.id = $1 LIMIT 1
`, [uid]);
```
Then two outcomes (`server.js:335-360`):

*Revocation* — if the branch admin is expired or non-`active`, the user is kicked:
```js
if (isExpired || isInactive) {
    ws.send(JSON.stringify({
        type: 'force_logout',
        data: { message: "Masa aktif instansi/admin telah berakhir atau dinonaktifkan." }
    }));
    await pool.query("UPDATE public.users SET status = 'offline', current_device_id = NULL WHERE id = $1", [uid]);
    setTimeout(() => ws.terminate(), 500);
    continue;
}
```

*Update* — otherwise, permissions are recomputed as the **AND of the user's own flag and the branch admin's capability**, then pushed:
```js
ws.enable_maps      = (row.enable_maps !== false) && (row.can_manage_maps !== false);
ws.enable_p2p       = (row.enable_p2p !== false) && (row.can_manage_p2p !== false);
ws.enable_ptt_video = (row.enable_ptt_video === true) && (row.can_manage_video === true);
ws.duplex_mode      = row.duplex_mode || 'HALF DUPLEX';
ws.is_rx_only       = (row.channel_perm === 'RX');

ws.send(JSON.stringify({
    type: 'permission_update',
    data: { enable_maps, enable_p2p, enable_ptt_video, duplex_mode, is_rx_only }
}));
```
Reply: `{ success: true, message: "Updated N users in branch." }` (`:365`).

Note the asymmetric defaults: maps/p2p are **opt-out** (`!== false`), video is **opt-in** (`=== true`). A `NULL` from the LEFT JOIN enables maps and p2p but not video.

**Two sibling paths exist and matter equally for a redesign:**

- `syncUserChannels($userId)` → `GET /api/admin/sync-channels?userId=…` → `broadcastChannelUpdate` (`server.js:128-168`), which pushes `channels_updated` and, if the current room's permission flipped, a follow-up `permission_update` with `message: "Izin bicara diperbarui secara realtime."`. Defined **five times, near-identically**, in `users.php:15`, `channels.php:15`, `user_access.php:14`, `api_users.php:5`, `api_user_access.php:11`, `api_channels.php:5`. Two variants use cURL-with-`file_get_contents`-fallback, three use `file_get_contents` only.
- `notifyPermissionUpdate(...)` → `POST /api/admin/update-permissions` — defined in `users.php:20` (default `$duplex='FULL DUPLEX'`) and `api_users.php:10` (default `$duplex='HALF DUPLEX'`). **The defaults disagree between the two copies.**
- `notifyForceLogout($userId)` → `POST /api/admin/force-logout` — `user_access.php:29`, `api_user_access.php:26`.

---

## 4. Database schema as referenced

Confirmed against `server/struktur_am2.sql` (PostgreSQL 14, schema `public`). **Indonesian column names are flagged 🇮🇩.**

**`admin`** — `id int PK`, `username varchar(50)`, `password_hash text`, `role varchar(20)` default `'admin'`, `created_at timestamp`, `max_channels int` default 5 *(never read by panel or server)*, `status varchar(20)` default `'active'`, `user_quota int`, `channel_quota int`, `expired_at date`, `can_manage_p2p bool`, `can_manage_maps bool`, `can_manage_video bool`.

**`admin_activity_logs`** — `id int PK`, `admin_id int`, `aksi varchar(20)` 🇮🇩 *(action)*, `tabel_target varchar(50)` 🇮🇩 *(target table)*, `data_id varchar(50)`, `keterangan text` 🇮🇩 *(description)*, `waktu timestamp` 🇮🇩 *(time)*. Written by PHP with `aksi` values `CREATE_USER`, `UPDATE_USER`, `DELETE_USER`, `UPDATE_FEATURE`, `UPDATE_ACCESS`, `FORCE_LOGOUT`; also written automatically by the `log_admin_activity()` trigger with `CREATE`/`UPDATE`/`DELETE`.

**`admin_managed_channels`** — `admin_id int`, `channel_id int`, `assigned_at timestamp`. The delegation table.

**`app_versions`** — `version_code int PK`, `version_name varchar(20)`, `force_update bool`, `release_notes text`, `created_at timestamp`. Touched **only** by `server.js` (`:255`, `:281`); the PHP panel never reads it (it uses the `update/admin_version.json` file instead — two independent version sources).

**`channel_members`** — `user_id varchar(50)`, `channel_id varchar(50)`. **Referenced by nothing.** Dead table; superseded by `user_channels`. Note `channel_id` is `varchar` here vs `integer` in `user_channels`.

**`channels`** — `id int PK`, `name varchar(50)` (slug), `display_name varchar(100)`, `category varchar(20)` default `'public'` *(always hard-coded to `'public'` on write)*, `created_by int`, `no_timeout bool` *(never read)*, `created_at timestamp`.

**`ptt_logs`** — `id int PK`, `user_id varchar(50)`, `channel_id int`, `event_type varchar(20)`, `event_time timestamp`. `event_type` values emitted: `LOGIN`, `LOGOUT`, `PUSH`, `RELEASE`, `PUSH_PRIVATE`, `RELEASE_PRIVATE`, `FORCE_LOGOUT` (all from `server.js`), plus `RESTORE` from `settings.php:89`. Auto-pruned at 30 days (`server.js:94`).

**`user_app_permissions`** — `user_id varchar(50) PK`, `enable_maps bool` default **true**, `enable_p2p bool` default **true**, `enable_ptt_video bool` default false, `updated_at timestamptz`, `duplex_mode varchar(20)` default `'HALF DUPLEX'` with `CHECK (duplex_mode IN ('FULL DUPLEX','HALF DUPLEX'))`. ⚠️ Both `users.php:59` and `api_users.php:111` insert `enable_maps=false, enable_p2p=false` on user creation, overriding the schema defaults.

**`user_channels`** — `user_id varchar(50)`, `channel_id int`, `is_default bool`, `permission varchar(20)` default `'rxtx'` with `CHECK (permission IN ('RX','TX','FULL DUPLEX','rxtx'))`. Unique on `(user_id, channel_id)` (relied on by the `ON CONFLICT` at `server.js:416`). ⚠️ Four distinct writers use three different permission values: PHP writes `'FULL DUPLEX'` or `'RX'`; `server.js:417` defaults to `'TX'`; the column default is `'rxtx'`. Only `'RX'` is ever *read* meaningfully (`is_rx_only` at `server.js:349`, `:773`) — every other value means "can transmit". `is_rx_only` does **not** exist here despite `assign.php` writing to it.

**`users`** — `id varchar(50) PK`, `name varchar(100)`, `status varchar(20)` default `'offline'`, `current_channel varchar(255)` (channel **slug**, not id), `last_channel_id int`, `latitude numeric(10,8)`, `longitude numeric(11,8)`, `address text`, `created_at timestamp`, `created_by int`, `admin_id int`, `updated_at timestamp`, `accuracy double precision`, `password text` (bcrypt), `role varchar(20)` default **`'superadmin'`** ⚠️, `current_device_id text`, `force_logout bool`, `is_speaking bool`.

Note the dual channel pointers: `current_channel` (slug, live) and `last_channel_id` (int, default). `api_get_users.php`/`get-users-ajax.php` join on the former; `get_users_location.php` joins on the latter. Also `users.role` defaults to `'superadmin'` while every panel query filters `WHERE u.role='user'` — a row inserted without an explicit role becomes invisible to the panel.

A PL/pgSQL trigger `log_admin_activity()` (`struktur_am2.sql:37-50`) auto-writes `admin_activity_logs` on INSERT/UPDATE/DELETE of tables carrying `created_by`/`name`. Log rows will appear that no PHP code wrote.

---

## 5. Shared config

### `WebAdmin/config.php` (53 lines, read in full)

Credentials come from a **key=value env file outside the web root**:

```php
// config.php:2-7
/**
 * AM2 WebAdmin production config loader.
 * Real secrets live outside the web root in /etc/am2/webadmin.env.production.
 */
$envFile = '/etc/am2/webadmin.env.production';
```

Parser (`config.php:9-24`): skips blanks, `#` comments, and lines without `=`; splits on the **first** `=` only; trims whitespace then strips one layer of wrapping `"` or `'`; publishes each key to `putenv()`, `$_ENV`, **and `$_SERVER`**.

```php
// config.php:29-33
$host     = getenv('AM2_DB_HOST')     ?: '127.0.0.1';
$port     = getenv('AM2_DB_PORT')     ?: '5432';
$dbname   = getenv('AM2_DB_NAME')     ?: 'am2';
$user     = getenv('AM2_DB_USER')     ?: 'admin';
$password = getenv('AM2_DB_PASSWORD') ?: '';
```

Keys present in `/etc/am2/webadmin.env.production` (`-rw-r----- root:www-data`, 136 bytes): `AM2_DB_HOST`, `AM2_DB_PORT`, `AM2_DB_NAME`, `AM2_DB_USER`, `AM2_DB_PASSWORD`, `AM2_TIMEZONE`. **All values `<redacted>`** — I read only the key names.

Fail-closed on missing password (`config.php:35-39`): logs to `error_log`, `http_response_code(500)`, `die('Konfigurasi database belum lengkap.')`. Connection failure (`:49-52`): `die('Koneksi database gagal.')`. PDO is created with `ERRMODE_EXCEPTION` and `FETCH_ASSOC` (`:44-47`), then `SET TIME ZONE 'Asia/Jakarta'` (`:48`); timezone also applied to PHP via `date_default_timezone_set` (`:26-27`).

**Exported globals every consumer relies on:** `$pdo`, and also `$host`, `$port`, `$user`, `$dbname`, `$password` — the last five are consumed as raw shell arguments by `api_settings.php:24,26,121` and `settings.php:67,69,86`. A redesign must keep `config.php` defining all six names.

⚠️ `/var/www/am2/current/WebAdmin/config.php.bak.2026-05-03-182146` exists, owned `root:root`, mode `-rw-r--r--`, **459 bytes, world-readable, inside the web root**, with a `.bak…` extension Apache will not pass to PHP. If it contains the pre-migration inline credentials it is serving them in plaintext. I did not open it. Worth verifying independently of the redesign.

### `server.js` config

`require('dotenv').config()` at `server.js:1` — but **no `.env` exists** at `/var/www/am2/current/server/.env`. The real source is systemd:

```
# /etc/systemd/system/am2-api.service
WorkingDirectory=/var/www/am2/current/server
EnvironmentFile=/etc/am2/api.env
ExecStart=/usr/bin/node /var/www/am2/current/server/server.js
User=am2deploy  Group=www-data
```

Keys in `/etc/am2/api.env` (`-rw-r----- root:www-data`): `NODE_ENV`, `PORT`, `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT`, `REDIS_URL`. Values `<redacted>`.

Consumed at `server.js:19` (`PORT`, default 5000), `:28` (`REDIS_URL`, default `redis://localhost:6379`), `:69-79` (pg `Pool`, `max: 50`, `options: "-c timezone=Asia/Jakarta"`). Note the two services use **different env var names for the same database** (`AM2_DB_*` vs `DB_*`) and different files.

Redis holds only ephemeral sets `speakers:<slug>` and `video:<slug>`; a failed Redis connect is logged and execution continues (`server.js:33-40`), but later `await redisClient.sAdd(...)` calls will then reject inside the message handler.

---

## 6. Session / auth contract

### `$_SESSION` keys — the complete set (4)

| Key | Type | Set at | Read at |
|---|---|---|---|
| `admin_logged_in` | `true` | `login.php:25` | `auth.php:6`, `admin_panel.php:5`, `assign.php:3`, `create_admin.php:3`, `get-users-ajax.php:5`, `login.php:5`, `sidebar.php:2`, `channels.php:5`, `dashboard.php:5`, `fetch_logs.php:6`, `logs.php:7`, `settings.php:5`, `livetrack.php:5`, `user_access.php:5`, `users.php:5` |
| `admin_id` | int | `login.php:26` | `admin_panel.php:30,129`, `get-users-ajax.php:13`, `channels.php:12`, `dashboard.php:10`, `fetch_logs.php:11`, `settings.php:11`, `user_access.php:11`, `users.php:12` |
| `admin_username` | string | `login.php:27` | `sidebar.php:7`, `settings.php:12` |
| `admin_role` | string | `login.php:28` | `auth.php:12`, `admin_panel.php:5`, `get-users-ajax.php:14`, `sidebar.php:8`, `channels.php:13`, `dashboard.php:11`, `fetch_logs.php:12`, `layout.php:4`, `settings.php:10`, `user_access.php:12`, `users.php:13` |

Set in exactly one place:
```php
// login.php:25-28
$_SESSION['admin_logged_in'] = true;
$_SESSION['admin_id']        = $user['id'];
$_SESSION['admin_username']  = $user['username'];
$_SESSION['admin_role']      = $user['role'];
```

⚠️ **`layout.php:3` and `sidebar.php:7` read `$_SESSION['admin_name']`, which is never set anywhere.** `layout.php` falls back to `'Admin'`; `sidebar.php` falls back to `admin_username` first so it works by accident. `layout.php` appears to be unused (no page includes it — every page includes `sidebar.php` directly).

⚠️ **No session regeneration on login** (`session_regenerate_id()` appears nowhere) — session fixation is possible. **No idle/absolute timeout.** No `session_set_cookie_params` hardening (no explicit `HttpOnly`/`Secure`/`SameSite`); whatever `php.ini` provides is what you get.

### CSRF tokens

**None.** `grep -n 'csrf\|CSRF\|token' *.php asset/js/*.js` returns zero hits. Every state-changing operation is an unprotected form POST or a bare `GET ?delete=<id>`:
- `users.php:192` — `GET ?delete=<id>` deletes a user
- `channels.php:113` — `GET ?delete=<id>` deletes a channel and cascades
- `admin_panel.php:28` — `GET ?delete_id=<id>` deletes an admin
- `logout.php` — GET-triggered logout

The only "protection" on those is a client-side `onclick="return confirm(...)"`, which is not a control.

### Rate limiting

**None.** No throttling on `login.php`, no throttling on `api_login.php`, no failed-attempt counter, no lockout, no captcha, no `fail2ban` filter for the panel. `api_login.php` in particular is an unauthenticated, unrate-limited bcrypt oracle — and bcrypt is deliberately slow, so it doubles as a cheap DoS vector.

### Other auth gaps worth recording before you redesign

1. **`auth.php` is dead code.** It is the only file with a reusable guard + `is_superadmin()` helper, and **no file includes it**. Every page hand-rolls `if (!isset($_SESSION['admin_logged_in'])) { header("Location: login.php"); exit; }`. A redesign should adopt `auth.php` — but that changes nothing observable, so it is safe under your constraint.
2. **`api_*.php` have no session check at all.** Sending `?admin_id=1&role=superadmin` to any of them grants full superadmin over the whole database from an unauthenticated request. This is the single largest issue in the codebase and it is orthogonal to the UI.
3. **No ownership checks on most mutations.** `api_users.php action=delete` deletes any user id regardless of `admin_id`. `api_settings.php action=update_password` resets any admin's password. `api_admin_panel.php action=save` lets any caller create a `superadmin`.
4. `users.php:126` validates `$feature` against an allow-list before interpolating it into SQL; `api_users.php:174` does the **same interpolation without the allow-list**. Same logical endpoint, one hardened copy and one not.

---

## 7. Coupling risks for a UI rewrite

Ranked by how likely each is to silently break a redesign.

### 7.1 Panel pages are simultaneously HTML views *and* JSON endpoints

This is the biggest trap. Four pages branch on a request parameter *before* emitting HTML, and return JSON instead. If a rewrite splits view rendering out of these files, these endpoints vanish.

- **`users.php` — three hidden JSON endpoints in one file:**
  ```php
  // users.php:73-79   GET  users.php?get_user_channels=1&u_id=<id>
  if (isset($_GET['get_user_channels'])) {
      header('Content-Type: application/json');
      $stmt = $pdo->prepare("SELECT channel_id FROM public.user_channels WHERE user_id = ?");
      $stmt->execute([$_GET['u_id']]);
      echo json_encode($stmt->fetchAll(PDO::FETCH_COLUMN));
      exit;
  }
  ```
  ```php
  // users.php:81-82   POST users.php  (field save_user_channels)
  if (isset($_POST['save_user_channels'])) { header('Content-Type: application/json');
  // users.php:104-105 POST users.php  (field update_feature)
  if (isset($_POST['update_feature'])) { header('Content-Type: application/json');
  ```
  Consumed by `users.php:519`, `:539`, `:566`, `:601` — all `fetch('users.php', ...)` against **itself**. Response key on failure is `msg`, **not** `message` (`users.php:99`, `:127`, `:161`, `:165`) — different from every `api_*.php` file.

- **`channels.php:30-39`** — `GET channels.php?ajax_action=get_channel_users&channel_id=<id>` returns a bare JSON array; consumed at `channels.php:409`.

- **`user_access.php:44-77`** — `POST` to **`window.location.href`** with `action=db_force_logout`:
  ```js
  // user_access.php:465
  const resp = await fetch(window.location.href, { method: 'POST', body: fd });
  ```
  Because the URL is `window.location.href`, this POST carries whatever `?search=` happens to be in the address bar. Any change to the page's URL structure changes the endpoint. This is the only place in the panel that returns a **correct 500** (`user_access.php:73`).

- **`settings.php:57-74`** — `POST settings.php` with `export_db` streams a `pg_dump` as an octet-stream download from inside a normal HTML page. `settings.php:76-97` accepts a `.sql` upload and pipes it into `psql`. `settings.php:36-55` accepts an `.apk` upload into `update/`.

### 7.2 `renderLogHTML` — server-shaped JSON compiled into HTML strings in the browser

`logs.php:110-146` builds table rows client-side from `fetch_logs.php` JSON. It hard-depends on the Indonesian field names **and** on specific badge semantics:

```js
// logs.php:111-125
const type = log.aksi.toUpperCase();
const isAdm = log.kategori === 'ADM';
const rowClass = isAdm ? 'is-admin-log' : 'is-ptt-log';
...
if (['PUSH', 'TX', 'START', 'PTT_ON'].includes(type)) {
    badgeClass = "bg-danger text-white"; badgeText = "TX / ON";
} else if (type === 'LOGIN') {
    badgeClass = "bg-success text-white"; badgeText = "ONLINE";
} else if (type.includes('CREATE')) {
    badgeClass = "bg-success text-white"; badgeText = "BARU";
}
```
`log.aksi.toUpperCase()` throws if `aksi` is ever null. `log.target` and `log.pelaksana` are interpolated **unescaped** into a template literal (`logs.php:133-146`) — `keterangan` is admin-controlled free text, so this is a stored-XSS sink. Required DOM ids/classes: `#log-table-body`, `#logSearchInput`, `#loading-indicator`, `#last-update-time`, `.filter-btn`, `#btn-all`/`#btn-ptt`/`#btn-adm` (derived as `'btn-' + cat.toLowerCase()` at `logs.php:220` — so the category strings and the element ids are welded together).

`applyFilters()` at `logs.php:207-216` filters by **`row.innerText`** and bails on `row.cells.length < 3`. Any change to column count or to visually-hidden text silently changes search results.

### 7.3 `livetrack.php` — jQuery + Leaflet against exact ids, with `onclick` built from data

```js
// livetrack.php:270
<div class="unit-item ${isSpeaking ? 'speaking-active' : ''}" onclick="gotoUnit(${u.lat}, ${u.lng}, '${u.id}')">
```
`u.id` is injected into a single-quoted JS string inside an HTML attribute — an id containing `'` breaks the page. `u.name` is interpolated unescaped at `:225` and `:278`.

Hard dependencies: `#map`, `#unitList`, `#unitSearch`, `#tx-indicator`, `#count-online`, `#unitPanel`, `#panelToggle`, and the CSS classes `custom-marker`, `speaking-marker`, `marker-label`, `pulse-dot` (used as Leaflet `divIcon` classNames at `:223-228`, so they are **not** ordinary styling classes — dropping them breaks marker rendering, not just appearance). Polls `get-users-ajax.php` every 2 s (`livetrack.php:198-199`, `:304-305`). Requires **jQuery** — `$('#tx-indicator').fadeIn(200)` at `:254`.

### 7.4 Server-rendered `data-*` attributes carrying JSON payloads into JS

The row markup *is* the data layer. A rewrite that changes the table structure loses the state.

```php
// user_access.php:297-301
data-user-id="<?= htmlspecialchars($row['id'], ENT_QUOTES, 'UTF-8') ?>"
data-user-name="<?= htmlspecialchars($row['name'], ENT_QUOTES, 'UTF-8') ?>"
data-current-ids='<?= htmlspecialchars(json_encode($ids_array), ENT_QUOTES, 'UTF-8') ?>'
data-default-id="<?= htmlspecialchars($row['default_id'] ?? '', ENT_QUOTES, 'UTF-8') ?>"
data-perm-map='<?= htmlspecialchars(json_encode($perm_map), ENT_QUOTES, 'UTF-8') ?>'
```
Read at `user_access.php:430-455` via `this.dataset.permMap` etc., with `JSON.parse` in a try/catch.

```php
// admin_panel.php:276-279
data-id="<?= $a['id'] ?>"  data-user="<?= htmlspecialchars($a['username']) ?>"
data-role="<?= $a['role'] ?>"  data-channels='<?= json_encode($a['channel_ids']) ?>'
// admin_panel.php:324
data-admin='<?= $jsonData ?>'
```
⚠️ `data-channels` and `data-admin` are **raw `json_encode` with no `htmlspecialchars`** — an admin username containing `'` breaks out of the attribute. Consumed at `admin_panel.php:574-605` (`.admin-row`, `.btn-edit-trigger`, `.del-check`).

### 7.5 Inline `onclick`/`onchange` handlers bound to PHP-generated arguments

Every one of these is a place where markup and behaviour are fused:

| File:line | Handler |
|---|---|
| `users.php:366` | `onclick="openChannelModal(<?= json_encode((string)$u['id']) ?>, <?= json_encode((string)$u['name']) ?>)"` on a `<td>` |
| `users.php:373` | `onchange="updateDuplex('<?= $u['id'] ?>', this.checked)"` |
| `users.php:379/385/391` | `onchange="updateFeature('<?= $u['id'] ?>', 'enable_maps'\|'enable_p2p'\|'enable_ptt_video', this.checked)"` — plus a PHP-driven `disabled` attribute from `$auth['can_manage_*']` |
| `users.php:396` | `onclick="event.stopPropagation(); openEditModal(...)"` — depends on the `<td>` handler above existing |
| `users.php:318, 436` | `onclick="togglePass('pass_add'\|'pass_edit', this)"` — assumes `<span>` wrapping an `<i>` |
| `users.php:475` | `onclick="saveQuickChannels()"` |
| `channels.php:307, 314` | `openAccessModal(<?= $c['id'] ?>, '<?= htmlspecialchars($c['display_name']) ?>')`, `openEditModal(...)` — ⚠️ `htmlspecialchars` **without `ENT_QUOTES`** inside a single-quoted JS string; a `'` in a display name breaks it |
| `channels.php:315` | `<a href="?delete=<?= $c['id'] ?>" onclick="return confirm(...)">` |
| `user_access.php:319` | `onclick="event.stopPropagation(); forceLogout(...)"` |
| `user_access.php:354, 356` | `onclick="setAsDefault(<?= $ch['id'] ?>)"` on a div + `onclick="event.stopPropagation();"` on the nested checkbox |
| `admin_panel.php:235, 325, 331, 380, 428, 434` | `openAddModal()`, `event.stopPropagation()`, delete-confirm, `toggleQuotaView()`, `toggleDateInput()`, `add30Days()` |
| `logs.php:53, 64, 68-70` | `manualRefresh()`, `applyFilters()`, `setCategory('ALL'\|'PTT'\|'ADM')` |
| `livetrack.php:162, 175, 270` | `resetMap()`, `renderList()`, `gotoUnit(...)` |
| `settings.php:265`, `layout.php:139`, `sidebar.php:86`, `users.php:399` | `return confirm(...)` — **the only guard on destructive GET actions** |

The `event.stopPropagation()` pattern (`users.php:396`, `user_access.php:319`, `user_access.php:356`, `admin_panel.php:325`, `:331`) means nested clickable regions are load-bearing: flattening a row into a single click target will fire the wrong action.

### 7.6 Form **field names** are the API

Every panel mutation is dispatched on the presence of a submit button's `name`, not on a route. Rename a button and the feature silently stops working (no error — the branch just never runs, and the page re-renders as if nothing happened).

| Field name | File:line | Effect |
|---|---|---|
| `add_user` | `users.php:48` | create user |
| `edit_user` | `users.php:168` | update user |
| `save_user_channels` | `users.php:81` | replace channel set (JSON) |
| `update_feature` | `users.php:104` | toggle a permission |
| `add_channel` | `channels.php:41` | create channel |
| `save_channel_access` | `channels.php:55` | replace channel membership |
| `edit_channel` | `channels.php:94` | rename channel |
| `update_multi_access` | `user_access.php:79` | replace user's channels + per-channel RX |
| `save_admin` | `admin_panel.php:53` | create/update admin → **fires `refresh-branch-permissions` on update only** |
| `update_delegation` | `admin_panel.php:92` | replace delegated channels |
| `update_password` | `settings.php:16` | change own password |
| `export_db` / `import_db` / `upload_apk` | `settings.php:57 / 76 / 36` | dump / restore / APK upload |
| `assign` | `assign.php:6` | (broken) |

Array-shaped fields whose exact bracket syntax matters: `users[]` (`channels.php:355`), `channels[]` (`user_access.php:355`, `admin_panel.php:465`), and **`permissions[<channelId>]`** (`user_access.php:363`) — a keyed array, read as `$permissions_input[$ch_id]` at `user_access.php:106`. The `api_*` equivalents expect the *same* data as **JSON strings** instead (`api_user_access.php:122`, `api_channels.php:117`, `api_users.php:132`). Two encodings for one concept; do not unify them.

### 7.7 Dual-write duplication — every change must be made twice

Each panel feature has a near-identical `api_*.php` twin for the mobile admin app. They have already drifted:

| Concern | Panel | API twin | Drift |
|---|---|---|---|
| feature toggle | `users.php:104-166` | `api_users.php:160-191` | panel validates `$feature` against an allow-list; API does not |
| duplex default | `users.php:20` `'FULL DUPLEX'` | `api_users.php:10` `'HALF DUPLEX'` | **opposite defaults** |
| access update | `user_access.php:79-133` | `api_user_access.php:118-177` | API appends `" (via Mobile)"` to `keterangan`; panel logs `"(Main)"`, API logs `"(Utama)"` |
| force logout | `user_access.php:44-77` | `api_user_access.php:93-117` | panel returns bare `{success}`, API adds `message` |
| channel access | `channels.php:55-92` | `api_channels.php:115-136` | panel syncs **old ∪ new** users (`channels.php:82`), API syncs **only new** (`api_channels.php:130`) — API leaves removed users stale |
| error key | `users.php` uses `msg` | `api_users.php` uses `message` | different key name |

A redesign that "cleans up" one side without the other will diverge these further.

### 7.8 Chart bootstrapping is PHP-inlined, then swapped by AJAX

```php
// dashboard.php:384, 386
labels: <?= json_encode($chart_labels) ?>,
data: <?= json_encode($chart_values) ?>,
```
The first paint comes from PHP variables computed at `dashboard.php:18-66` (LIMIT 7 buckets, with a hard-coded 7-point fallback at `:58-60`); every subsequent refresh comes from `api_dashboard_chart.php` (**24** buckets). So the chart **changes point count** on first refresh. `refreshDashboardData()` (`dashboard.php:344-362`) also depends on `#activityChart`, `#chartSyncIcon`, `#liveClock`, a module-scope `myChart`, and reads **CSS custom properties off `document.body`** (`--dashboard-teal`, `--dashboard-chart-fill`, `--dashboard-line`, `--dashboard-muted`, `--dashboard-ink`, `--dashboard-panel`, `dashboard.php:369-375`). Renaming those CSS variables silently falls back to hard-coded hexes.

### 7.9 Bootstrap 5 component instances captured at parse time

```js
// users.php:492-493
const toastObj = new bootstrap.Toast(document.getElementById('liveToast'));
const channelModal = bootstrap.Modal.getOrCreateInstance(document.getElementById('channelModal'));
```
These run at script-parse time, **not** on `DOMContentLoaded`, and are not null-guarded — if `#liveToast` or `#channelModal` is absent (or moved after the `<script>`), the whole inline block throws and **every** handler in the file (`updateFeature`, `updateDuplex`, `saveQuickChannels`, …) becomes undefined, while the inline `onchange=` attributes still reference them. Same pattern at `channels.php:396`. `users.php:496-499` does guard, inconsistently.

Also parse-time and unguarded: `users.php:578` (`#selectAllChannels`), `channels.php:425` (`#selectAllUsers`), `channels.php:451` (`#searchInput`).

Required per-page ids: `users.php` — `liveToast`, `channelModal`, `editModal`, `edit_id`, `edit_name`, `pass_edit`, `pass_add`, `ch_user_id`, `ch_user_name`, `selectAllChannels`, `.quick-ch-checkbox`. `channels.php` — `accessModal`, `editModal`, `target_ch_id`, `target_ch_name`, `edit_id`, `edit_display_name`, `selectAllUsers`, `searchInput`, `.user-checkbox`, `.channel-row`. `user_access.php` — `accessModal`, `m_user_id`, `m_user_name`, `m_default_channel`, and the **dynamic id families `check_<id>`, `item_<id>`, `def_label_<id>`, `rx_<id>`** (`:386-421`), plus `.access-row`, `.channel-item`, `.ch-checkbox`, `.is-default`. `admin_panel.php` — `adminModal`, `delegateModal`, `modalTitle`, `f_id`, `f_username`, `f_password`, `f_role`, `f_user_quota`, `f_channel_quota`, `f_expired`, `f_permanent`, `f_can_maps`, `f_can_p2p`, `f_can_video`, `dateContainer`, `quotaView`, `featurePerms`, `delegate_admin_id`, `delegateUserText`, `.admin-row`, `.btn-edit-trigger`, `.del-check`.

The `def_label_<id>` family is queried by **attribute-prefix selector** — `document.querySelectorAll('[id^="def_label_"]')` (`user_access.php:388`, `:401`) — so the *id naming convention itself* is API.

### 7.10 Responsive layout encoded in `data-label` attributes

Every table cell carries `data-label="…"` (e.g. `users.php:366`, `assign.php:84`, `logs.php:133-145`) which `asset/css/am2-ui.css` uses to render mobile card views via `::before`. These are not decorative. `logs.php:201` even emits `data-label=""` on the empty-state row. A redesign that drops them loses the entire mobile table presentation.

### 7.11 Sidebar hard-refuses to render without a session

```php
// sidebar.php:2-4
if (!isset($_SESSION['admin_logged_in'])) {
    exit('Akses ditolak');
}
```
`exit()`, not `return` — it kills the whole response mid-HTML. It also emits a bare `<script>document.body.classList.add('has-mobile-sidebar');</script>` at `sidebar.php:11-13` that must run **after** `<body>` opens, and it computes active-nav state from `basename($_SERVER['PHP_SELF'])` (`:6`, used at `:37`+). Renaming any page file breaks its own nav highlight.

### 7.12 Miscellaneous escaping/consistency landmines

- `api_get_users.php:51` and `get-users-ajax.php:64` apply `htmlspecialchars()` to `name` **inside JSON**; `get_users_location.php:43` does not. Three endpoints, same field, two escaping policies.
- `assign.php:53,59,84` and `create_admin.php:23,25` interpolate DB values straight into HTML with no escaping.
- `admin_panel.php:243,246` echo `$success_msg`/`$error_msg` **unescaped** — and those strings contain raw `$e->getMessage()` (`admin_panel.php:49,88`), leaking SQL/schema detail into the page. Same at `channels.php:49` (which deliberately embeds `<strong>`), `users.php:69`, `settings.php:29`.
- `layout.php` is orphaned (nothing includes it) and reads a session key that is never set.
- `api_settings.php` `check_update` reads `update/admin_version.json`, a path relative to CWD, resolved through the `update` **symlink** to `/var/www/am2/shared/webadmin-update`. `settings.php:36-55` writes APKs into that same directory. Meanwhile `server.js` serves a *different* update directory (`/var/www/am2/current/server/update` → `shared/server-update`, `server.js:20`) and versions come from the `app_versions` **table**. Two independent update channels; do not merge them.

---

## Summary of the hard constraints

Things a redesign must not touch, in priority order:

1. All eleven `api_*.php` files — request params, `action` dispatch values, response key names (`success`/`message`/`error`, and `msg` in `users.php`), and the fact that most errors are HTTP 200.
2. The four self-POSTing panel endpoints (`users.php?get_user_channels`, `users.php` POST `save_user_channels`/`update_feature`, `channels.php?ajax_action=get_channel_users`, `user_access.php` POST `action=db_force_logout`).
3. Every form field `name` listed in §7.6, including the `channels[]` / `users[]` / `permissions[<id>]` array syntax.
4. The `?delete=`, `?delete_id=`, `?search=` GET parameters.
5. All twelve `server.js` routes and every WebSocket message `type` string in both directions, plus the binary tag bytes `1` (audio) and `2` (video).
6. The `refresh-branch-permissions` / `sync-channels` / `update-permissions` / `force-logout` PHP→Node calls — in particular that `admin_panel.php:80` fires only on the **update** branch.
7. `config.php` must keep exporting `$pdo` **and** `$host, $port, $user, $dbname, $password` (the shell-out paths in `settings.php` and `api_settings.php` depend on the last five).

Things that are safe to change because nothing consumes them: `assign.php` (writes a non-existent column), `create_admin.php` (writes the wrong table), `layout.php` (unincluded), `channel_members` table, `admin.max_channels`, `channels.no_timeout`. Confirm each with the user before removing, given the stated constraint.