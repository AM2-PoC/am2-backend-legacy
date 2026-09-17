#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'USAGE'
Usage: rollback-host-security.sh
         --activation-receipt /absolute/activation.json
         [--root /absolute/root] [--unprivileged-root]
         [--apache-configtest /absolute/command]
         [--nginx-configtest /absolute/command]
         [--reload-command /absolute/command]
         [--lock /absolute/lock]
         --apply --allow-reload
USAGE
}
activation_receipt=
root=/
unprivileged=0
apply=0
allow_reload=0
apache_configtest=/usr/sbin/apache2ctl
nginx_configtest=/usr/sbin/nginx
reload_command=/usr/bin/systemctl
lock=/var/lib/am2/host-security/activation.lock
while [[ $# -gt 0 ]]; do
    case "$1" in
        --activation-receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; activation_receipt=$2; shift 2 ;;
        --root) [[ $# -ge 2 ]] || { usage; exit 64; }; root=$2; shift 2 ;;
        --unprivileged-root) unprivileged=1; shift ;;
        --apache-configtest) [[ $# -ge 2 ]] || { usage; exit 64; }; apache_configtest=$2; shift 2 ;;
        --nginx-configtest) [[ $# -ge 2 ]] || { usage; exit 64; }; nginx_configtest=$2; shift 2 ;;
        --reload-command) [[ $# -ge 2 ]] || { usage; exit 64; }; reload_command=$2; shift 2 ;;
        --lock) [[ $# -ge 2 ]] || { usage; exit 64; }; lock=$2; shift 2 ;;
        --apply) apply=1; shift ;;
        --allow-reload) allow_reload=1; shift ;;

        *) usage; exit 64 ;;
    esac
done
for value in "$activation_receipt" "$root" "$apache_configtest" "$nginx_configtest" "$reload_command" "$lock"; do
    [[ $value == /* ]] || { usage; exit 64; }
done
(( apply )) || { echo "host-security rollback requires --apply" >&2; exit 64; }
(( allow_reload )) || { echo "host-security rollback requires --allow-reload" >&2; exit 64; }
if (( unprivileged )); then
    [[ $(realpath -m -- "$root") != / ]] || { echo "fixture rollback may not target /" >&2; exit 64; }
elif [[ $EUID -ne 0 ]]; then
    echo "real host rollback requires root" >&2; exit 1
fi
[[ -f $activation_receipt && ! -L $activation_receipt ]] || { echo "activation receipt is missing" >&2; exit 1; }
for command in "$apache_configtest" "$nginx_configtest" "$reload_command"; do
    [[ -x $command && ! -L $command ]] || { echo "rollback helper is missing: $command" >&2; exit 1; }
done
mkdir -p -- "$(dirname -- "$lock")"
exec 9>"$lock"
flock -x 9

identity_file=$(mktemp)
trap 'rm -f -- "$identity_file"' EXIT INT TERM HUP
python3 - "$activation_receipt" "$root" "$unprivileged" >"$identity_file" <<'PY'
import json, os, pathlib, stat, sys
path,root,unprivileged=sys.argv[1:]
info=pathlib.Path(path).lstat()
if stat.S_IMODE(info.st_mode) & 0o022:
    raise SystemExit('activation receipt is writable beyond its owner')
if unprivileged != '1' and info.st_uid != 0:
    raise SystemExit('activation receipt is not root-owned')
value=json.load(open(path,encoding='utf-8'))
if value.get('application')!='am2-host-security-activation' or value.get('status')!='verified':
    raise SystemExit('activation receipt is not verified')
if value.get('root_path') != os.path.realpath(root):
    raise SystemExit('activation receipt root does not match requested root')
print(value['backup_path'])
print(value['backup_manifest_sha256'])
print(value.get('superseded_activation_sha256', ''))
PY
mapfile -t identity <"$identity_file"
backup=${identity[0]}
backup_manifest_sha256=${identity[1]}
superseded_sha256=${identity[2]:-}
[[ -d $backup && ! -L $backup && -f $backup/previous.json ]] || { echo "activation backup is missing" >&2; exit 1; }
python3 - "$backup" "$activation_receipt" "$unprivileged" <<'PY'
import pathlib, stat, sys
backup=pathlib.Path(sys.argv[1]); receipt=pathlib.Path(sys.argv[2]); unprivileged=sys.argv[3]
if backup.parent == backup or not backup.is_absolute():
    raise SystemExit('activation backup path is invalid')
if unprivileged != '1':
    for path,label in ((receipt,'activation receipt'),(backup,'activation backup'),(backup/'previous.json','activation backup manifest')):
        info=path.lstat(); mode=stat.S_IMODE(info.st_mode)
        if info.st_uid != 0 or mode & 0o022:
            raise SystemExit(f'{label} is not root-protected')
PY

if [[ -n $superseded_sha256 ]]; then
    python3 - "$backup/superseded-activation.json" "$superseded_sha256" "$root" "$unprivileged" <<'PY'
import hashlib, json, os, pathlib, stat, sys
archive, expected, root, unprivileged = sys.argv[1:]
try:
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as error:
    raise SystemExit(f'superseded activation receipt is unavailable: {error.strerror}')
with os.fdopen(fd, 'rb') as stream:
    info = os.fstat(stream.fileno())
    raw = stream.read()
if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o022 or (unprivileged != '1' and info.st_uid != 0):
    raise SystemExit('superseded activation receipt is not protected')
if hashlib.sha256(raw).hexdigest() != expected:
    raise SystemExit('superseded activation receipt does not match the receipt that was replaced')
value = json.loads(raw.decode('utf-8'))
if not isinstance(value, dict) or value.get('application') != 'am2-host-security-activation' or value.get('status') != 'verified':
    raise SystemExit('superseded activation receipt is not verified')
if value.get('root_path') != os.path.realpath(root):
    raise SystemExit('superseded activation receipt root does not match requested root')
backup = pathlib.Path(str(value.get('backup_path', '')))
anchor = backup / 'previous.json'
if not backup.is_absolute() or backup.is_symlink() or not backup.is_dir() or anchor.is_symlink() or not anchor.is_file():
    raise SystemExit('superseded activation rollback anchor is missing')
if unprivileged != '1':
    for item in (backup, anchor):
        details = item.lstat()
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise SystemExit('superseded activation rollback anchor is not root-protected')
if hashlib.file_digest(open(anchor, 'rb'), 'sha256').hexdigest() != value.get('backup_manifest_sha256'):
    raise SystemExit('superseded activation rollback anchor changed')
PY
fi

python3 - "$backup/previous.json" "$root" "$backup_manifest_sha256" "$unprivileged" <<'PY'
import hashlib, json, os, pathlib, shutil, stat, tempfile, sys
manifest,root_arg,expected_digest,unprivileged=sys.argv[1:]
if hashlib.file_digest(open(manifest,'rb'),'sha256').hexdigest() != expected_digest:
    raise SystemExit('activation backup manifest does not match its receipt')
records=json.load(open(manifest,encoding='utf-8')); root=pathlib.Path(root_arg)
seen=set()
for item in records:
    if item.get('kind') not in ('file','directory') or item.get('state') not in ('present','absent'):
        raise SystemExit('activation backup manifest has an invalid record')
    target_name=item.get('target')
    relative=pathlib.PurePosixPath(str(target_name).lstrip('/'))
    if not str(target_name).startswith('/') or '..' in relative.parts or target_name in seen:
        raise SystemExit(f'activation backup manifest has an invalid target: {target_name}')
    seen.add(target_name)
    target=root/relative
    try: target.relative_to(root)
    except ValueError: raise SystemExit(f'activation backup target escapes root: {target_name}')
    cursor=root
    for component in pathlib.PurePosixPath(item['target'].lstrip('/')).parts[:-1]:
        cursor=cursor/component
        if cursor.is_symlink(): raise SystemExit(f'rollback target parent is a symlink: {cursor}')
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_symlink(): raise SystemExit(f'rollback target is a symlink: {item["target"]}')
    if item['kind']=='directory':
        if item['state']=='absent':
            try: target.rmdir()
            except FileNotFoundError: pass
            continue
        if target.is_symlink() or not target.is_dir():
            raise SystemExit(f'rollback directory target is unsafe: {item["target"]}')
        os.chmod(target,item['mode'])
        if unprivileged != '1': os.chown(target,item['uid'],item['gid'])
        continue
    if item['state']=='absent':
        target.unlink(missing_ok=True); continue
    source=pathlib.Path(item['backup'])
    expected_source=pathlib.Path(manifest).parent/'files'/relative
    if source != expected_source:
        raise SystemExit(f'rollback backup path is outside its sealed namespace: {target_name}')
    if not source.is_file() or source.is_symlink(): raise SystemExit(f'rollback backup is unsafe: {source}')
    if hashlib.file_digest(open(source,'rb'),'sha256').hexdigest() != item['sha256']:
        raise SystemExit(f'rollback backup digest differs: {item["target"]}')
    fd,tmp=tempfile.mkstemp(dir=target.parent,prefix='.'+target.name+'.rollback-')
    try:
        with open(source,'rb') as before, os.fdopen(fd,'wb') as output:
            shutil.copyfileobj(before,output); output.flush(); os.fsync(output.fileno())
        os.chmod(tmp,item['mode'])
        if unprivileged != '1': os.chown(tmp,item['uid'],item['gid'])
        os.replace(tmp,target)
    except BaseException:
        try: os.close(fd)
        except OSError: pass
        pathlib.Path(tmp).unlink(missing_ok=True); raise
PY
"$apache_configtest" configtest
"$nginx_configtest" -t
"$reload_command" reload apache2
"$reload_command" reload nginx
# Rolling back a superseding activation put the replaced activation's files back,
# so its receipt becomes active again -- otherwise the host runs hardened files
# with no activation on record and that activation's own rollback anchor is
# unreachable. The archive was checked before anything changed; it is written
# only from bytes that still match the digest the superseding receipt recorded.
if [[ -n $superseded_sha256 ]]; then
    python3 - "$backup/superseded-activation.json" "$superseded_sha256" "$activation_receipt" "$unprivileged" <<'PY'
import hashlib, os, pathlib, stat, sys, tempfile
archive, expected, out, unprivileged = sys.argv[1:]
fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream:
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        raise SystemExit('superseded activation receipt changed during rollback')
    raw = stream.read()
if hashlib.sha256(raw).hexdigest() != expected:
    raise SystemExit('superseded activation receipt changed during rollback')
tmp_fd, tmp = tempfile.mkstemp(dir=pathlib.Path(out).parent, prefix='.host-security-activation-')
try:
    with os.fdopen(tmp_fd, 'wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.chmod(tmp, 0o644)
    if unprivileged != '1': os.chown(tmp, 0, 0)
    os.replace(tmp, out)
except BaseException:
    pathlib.Path(tmp).unlink(missing_ok=True)
    raise
PY
    printf 'host-security rolled back to superseded activation: %s\n' "$activation_receipt"
else
    rm -f -- "$activation_receipt"
fi
printf 'host-security rolled back: %s\n' "$backup"
