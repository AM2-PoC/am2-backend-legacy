#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat >&2 <<'USAGE'
Usage: activate-host-security.sh
         --receipt /absolute/materialization.json
         --expected-manifest /absolute/trusted-host-security-manifest.json
         --activation-receipt /absolute/activation.json
         --backup-root /absolute/backups
         [--root /absolute/root] [--unprivileged-root]
         --apache-configtest /absolute/command
         --nginx-configtest /absolute/command
         --reload-command /absolute/command
          [--verify-installed /absolute/command]
          [--lifecycle /absolute/cloudflare-realip-lifecycle.json]
          [--lock /absolute/lock]
          [--supersede]
         --apply --allow-reload
USAGE
}

receipt=
expected_manifest=
activation_receipt=
backup_root=
root=/
unprivileged=0
apply=0
allow_reload=0
supersede=0
apache_configtest=/usr/sbin/apache2ctl
nginx_configtest=/usr/sbin/nginx
reload_command=/usr/bin/systemctl
verify_installed=
lifecycle=
lock=/var/lib/am2/host-security/activation.lock
while [[ $# -gt 0 ]]; do
    case "$1" in
        --receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; receipt=$2; shift 2 ;;
        --expected-manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; expected_manifest=$2; shift 2 ;;
        --activation-receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; activation_receipt=$2; shift 2 ;;
        --backup-root) [[ $# -ge 2 ]] || { usage; exit 64; }; backup_root=$2; shift 2 ;;
        --root) [[ $# -ge 2 ]] || { usage; exit 64; }; root=$2; shift 2 ;;
        --unprivileged-root) unprivileged=1; shift ;;
        --apache-configtest) [[ $# -ge 2 ]] || { usage; exit 64; }; apache_configtest=$2; shift 2 ;;
        --nginx-configtest) [[ $# -ge 2 ]] || { usage; exit 64; }; nginx_configtest=$2; shift 2 ;;
        --reload-command) [[ $# -ge 2 ]] || { usage; exit 64; }; reload_command=$2; shift 2 ;;
        --verify-installed) [[ $# -ge 2 ]] || { usage; exit 64; }; verify_installed=$2; shift 2 ;;
        --lifecycle) [[ $# -ge 2 ]] || { usage; exit 64; }; lifecycle=$2; shift 2 ;;
        --lock) [[ $# -ge 2 ]] || { usage; exit 64; }; lock=$2; shift 2 ;;
        --apply) apply=1; shift ;;
        --allow-reload) allow_reload=1; shift ;;
        --supersede) supersede=1; shift ;;

    esac
done

if [[ -z $verify_installed ]]; then
    verify_installed=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/verify-host-security-installed.sh
fi
if [[ -z $lifecycle ]]; then
    lifecycle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../contracts/cloudflare-realip-lifecycle.json
fi
for value in "$receipt" "$expected_manifest" "$activation_receipt" "$backup_root" "$root" \
             "$apache_configtest" "$nginx_configtest" "$reload_command" "$verify_installed" "$lifecycle" "$lock"; do
    [[ $value == /* ]] || { usage; exit 64; }
done
(( apply )) || { echo "host-security activation requires --apply" >&2; exit 64; }
(( allow_reload )) || { echo "host-security activation requires --allow-reload" >&2; exit 64; }
if (( unprivileged )); then
    [[ $(realpath -m -- "$root") != / ]] || { echo "fixture activation may not target /" >&2; exit 64; }
elif [[ $EUID -ne 0 ]]; then
    echo "real host activation requires root" >&2
    exit 1
fi
[[ -f $receipt && ! -L $receipt && -f $expected_manifest && ! -L $expected_manifest ]] \
    || { echo "materialization receipt or trusted manifest is missing" >&2; exit 1; }
for command in "$apache_configtest" "$nginx_configtest" "$reload_command" "$verify_installed"; do
    [[ -x $command && ! -L $command ]] || { echo "activation helper is missing: $command" >&2; exit 1; }
done
mkdir -p -- "$(dirname -- "$lock")"
exec 9>"$lock"
flock -x 9
if (( supersede )); then

    [[ -f $activation_receipt && ! -L $activation_receipt ]] || {
        echo "--supersede needs an active host-security activation receipt to replace" >&2
        exit 1
    }

    superseded_sha256=$(python3 - "$activation_receipt" "$root" "$unprivileged" <<'PY'
import hashlib, json, os, pathlib, stat, sys
path, root, unprivileged = sys.argv[1:]
receipt = pathlib.Path(path)
fd = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream:
    info = os.fstat(stream.fileno())
    raw = stream.read()
if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o022 or (unprivileged != '1' and info.st_uid != 0):
    raise SystemExit('active activation receipt is not protected; refusing to supersede it')
value = json.loads(raw.decode('utf-8'))
if not isinstance(value, dict):
    raise SystemExit('active activation receipt is not verified; refusing to supersede it')
if value.get('application') != 'am2-host-security-activation' or value.get('status') != 'verified':
    raise SystemExit('active activation receipt is not verified; refusing to supersede it')
if value.get('root_path') != os.path.realpath(root):
    raise SystemExit('active activation receipt root does not match the requested root')
backup = pathlib.Path(str(value.get('backup_path', '')))
anchor = backup / 'previous.json'
if not backup.is_absolute() or backup.is_symlink() or not backup.is_dir() or anchor.is_symlink() or not anchor.is_file():
    raise SystemExit('active activation rollback anchor is missing; refusing to supersede it')
if unprivileged != '1':
    for item in (backup, anchor):
        details = item.lstat()
        if details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise SystemExit('active activation rollback anchor is not root-protected')
if hashlib.file_digest(open(anchor, 'rb'), 'sha256').hexdigest() != value.get('backup_manifest_sha256'):
    raise SystemExit('active activation rollback anchor changed; refusing to supersede it')
print(hashlib.sha256(raw).hexdigest())
PY
)
else
    [[ ! -e $activation_receipt && ! -L $activation_receipt ]] || {
        echo "an active host-security receipt already exists; supersede it with --supersede or roll it back before another activation" >&2
        exit 1
    }
fi

# Materialization receipt and expected manifest are trust inputs. A real-host
# activation refuses anything not root-owned and immutable to group/other.
python3 - "$receipt" "$expected_manifest" "$unprivileged" <<'PY'
import pathlib, stat, sys
for path,label in ((sys.argv[1], 'materialization receipt'), (sys.argv[2], 'trusted expected manifest')):
    info=pathlib.Path(path).lstat(); mode=stat.S_IMODE(info.st_mode)
    if mode & 0o002:
        raise SystemExit(f'{label} is world-writable')
    if sys.argv[3] != '1' and (mode & 0o022 or info.st_uid != 0):
        raise SystemExit(f'{label} is not root-protected')
PY

work=$(mktemp -d)
cleanup() { rm -rf -- "$work"; }
trap cleanup EXIT INT TERM HUP
plan=$work/plan.json
authenticated_payload=$work/authenticated-payload
python3 - "$receipt" "$expected_manifest" "$root" "$plan" "$authenticated_payload" <<'PY'
import hashlib, json, os, pathlib, re, stat, subprocess, sys
receipt_path, manifest_path, root_arg, plan_path, snapshot_arg = sys.argv[1:]
receipt = json.load(open(receipt_path, encoding='utf-8'))
manifest = json.load(open(manifest_path, encoding='utf-8'))
for field in ('source_sha', 'payload_sha256', 'archive_sha256'):
    if receipt.get(field) != manifest.get(field):
        raise SystemExit(f'materialization receipt {field} does not match trusted manifest')
trusted = {entry['id']: entry['sha256'] for entry in manifest['files']}
received = {entry['id']: entry['sha256'] for entry in receipt['files']}
if trusted != received:
    raise SystemExit('materialization receipt files do not match trusted manifest')
store = pathlib.Path(receipt['store_path'], 'payload')
# Build one descriptor-opened snapshot of the immutable store. A scan followed by
# shutil.copytree() is still a pathname race when this command runs as root.
def snapshot_tree(source, destination):
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW
    def copy_dir(source_fd, out):
        for name in os.listdir(source_fd):
            entry = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            if stat.S_ISLNK(entry.st_mode):
                raise SystemExit(f'materialization store contains a symlink: {name}')
            if stat.S_ISDIR(entry.st_mode):
                child_fd = os.open(name, directory_flags, dir_fd=source_fd)
                try:
                    opened = os.fstat(child_fd)
                    if (opened.st_dev,opened.st_ino)!=(entry.st_dev,entry.st_ino):
                        raise SystemExit(f'materialization store changed while opening directory: {name}')
                    child_out=out/name; child_out.mkdir(mode=0o755)
                    copy_dir(child_fd,child_out)
                finally: os.close(child_fd)
            elif stat.S_ISREG(entry.st_mode):
                file_fd = os.open(name, file_flags, dir_fd=source_fd)
                try:
                    opened=os.fstat(file_fd)
                    if (opened.st_dev,opened.st_ino)!=(entry.st_dev,entry.st_ino):
                        raise SystemExit(f'materialization store changed while opening file: {name}')
                    output=out/name
                    with open(output,'xb') as stream:
                        while chunk := os.read(file_fd,1024*1024): stream.write(chunk)
                        stream.flush(); os.fsync(stream.fileno())
                    output.chmod(0o644)
                finally: os.close(file_fd)
            else:
                raise SystemExit(f'materialization store contains a non-regular entry: {name}')
    root_fd=os.open(source,directory_flags)
    try:
        opened=os.fstat(root_fd); named=os.lstat(source)
        if (opened.st_dev,opened.st_ino)!=(named.st_dev,named.st_ino):
            raise SystemExit('materialization store changed while opening payload')
        destination.mkdir(mode=0o755); copy_dir(root_fd,destination)
    finally: os.close(root_fd)

normalised = pathlib.Path(snapshot_arg)
snapshot_tree(store, normalised)
derived = subprocess.run(
    ['/usr/bin/tar', '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
     '--numeric-owner', '-C', str(normalised), '-cf', '-', '.'], capture_output=True, check=True).stdout
if hashlib.sha256(derived).hexdigest() != manifest['payload_sha256']:
    raise SystemExit('materialization store does not match trusted payload digest')
contract = json.load(open(normalised / 'infra/contracts/host-security-contract.json', encoding='utf-8'))
by_id = {entry['id']: entry for entry in contract['files']}
root = pathlib.Path(root_arg)
items = []
for entry in receipt['files']:
    declared = by_id.get(entry['id'])
    if declared is None or declared['source'] != entry['origin'] or declared['mode'] != entry['mode']:
        raise SystemExit(f"receipt and contract disagree at {entry['id']}")
    source = normalised / entry['origin']
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise SystemExit(f'materialized source is not a regular file: {source}')
    targets = []
    if 'target' in declared:
        targets = [declared['target']]
    elif declared.get('target_kind') == 'php-sapi-conf.d':
        php_root = root / 'etc/php'
        if php_root.is_dir():
            for version in sorted(php_root.iterdir()):
                if not version.is_dir() or version.is_symlink():
                    continue
                for sapi in declared['sapis']:
                    conf = version / sapi / 'conf.d'
                    if conf.is_dir() and not conf.is_symlink():
                        targets.append('/' + str((conf / declared['filename']).relative_to(root)))
        if not targets:
            raise SystemExit(f"no PHP SAPI target exists for {entry['id']}")
    else:
        raise SystemExit(f"contract resolves no target for {entry['id']}")
    for target in targets:
        if not re.fullmatch(r'/[A-Za-z0-9._/-]+', target) or '..' in target.split('/'):
            raise SystemExit(f'invalid install target: {target}')
        items.append({'id': entry['id'], 'source': str(source), 'target': target,
                      'mode': int(declared['mode'], 8)})
json.dump({'identity': {key: manifest[key] for key in ('source_sha','payload_sha256','archive_sha256')},
           'items': items}, open(plan_path, 'w', encoding='utf-8'), sort_keys=True)
PY

backup=$backup_root/$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["identity"]["payload_sha256"])' "$plan")-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(8))')
mkdir -m 0700 -p "$backup/files"
python3 - "$plan" "$root" "$backup" "$unprivileged" <<'PY'
import hashlib, json, os, pathlib, shutil, stat, sys
plan_path, root_arg, backup_arg, unprivileged = sys.argv[1:]
plan=json.load(open(plan_path)); root=pathlib.Path(root_arg); backup=pathlib.Path(backup_arg)
records=[]
for item in plan['items']:
    target=root / item['target'].lstrip('/')
    if target.exists() or target.is_symlink():
        if target.is_symlink() or not target.is_file():
            raise SystemExit(f'activation target is not a regular file: {item["target"]}')
        saved=backup/'files'/item['target'].lstrip('/')
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, saved, follow_symlinks=False)
        digest=hashlib.file_digest(open(saved,'rb'),'sha256').hexdigest()
        records.append({'kind':'file', 'target':item['target'], 'state':'present',
                        'backup':str(saved), 'sha256':digest,
                        'mode':stat.S_IMODE(target.lstat().st_mode),
                        'uid':target.lstat().st_uid, 'gid':target.lstat().st_gid})
    else:
        records.append({'kind':'file', 'target':item['target'], 'state':'absent'})
for path in ('/var/lib/php/sessions/am2','/var/lib/php/sessions/am2-staging'):
    target=root/path.lstrip('/')
    if target.exists() or target.is_symlink():
        info=target.lstat()
        if target.is_symlink() or not stat.S_ISDIR(info.st_mode):
            raise SystemExit(f'activation session target is not a directory: {path}')
        records.append({'kind':'directory', 'target':path, 'state':'present',
                        'mode':stat.S_IMODE(info.st_mode), 'uid':info.st_uid, 'gid':info.st_gid})
    else:
        records.append({'kind':'directory', 'target':path, 'state':'absent'})
out=backup/'previous.json'
with open(out,'x',encoding='utf-8') as stream:
    json.dump(records,stream,sort_keys=True,indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
for path in backup.rglob('*'):
    if path.is_symlink(): raise SystemExit(f'activation backup contains a symlink: {path}')
    os.chmod(path, 0o700 if path.is_dir() else 0o600)
if unprivileged != '1':
    for path in [backup, *backup.rglob('*')]: os.chown(path,0,0)
PY
backup_manifest_sha256=$(sha256sum "$backup/previous.json" | cut -d' ' -f1)

restore() {
    python3 - "$backup/previous.json" "$root" "$backup_manifest_sha256" "$unprivileged" <<'PY'
import hashlib, json, os, pathlib, shutil, stat, sys, tempfile
manifest, root_arg, expected_digest, unprivileged = sys.argv[1:]
if hashlib.file_digest(open(manifest,'rb'),'sha256').hexdigest() != expected_digest:
    raise SystemExit('activation backup manifest changed before rollback')
records=json.load(open(manifest)); root=pathlib.Path(root_arg)
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
    target.parent.mkdir(parents=True, exist_ok=True)
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
        target.unlink(missing_ok=True)
        continue
    source=pathlib.Path(item['backup'])
    expected_source=pathlib.Path(manifest).parent/'files'/relative
    if source != expected_source:
        raise SystemExit(f'activation backup path is outside its sealed namespace: {target_name}')
    if hashlib.file_digest(open(source,'rb'),'sha256').hexdigest() != item['sha256']:
        raise SystemExit(f'activation backup changed before rollback: {item["target"]}')
    fd,tmp=tempfile.mkstemp(dir=target.parent,prefix='.'+target.name+'.rollback-')
    os.close(fd); shutil.copyfile(source,tmp); os.chmod(tmp,item['mode'])
    if unprivileged != '1': os.chown(tmp,item['uid'],item['gid'])
    os.replace(tmp,target)
PY
}
rollback_on_failure() {
    rc=$?
    trap - ERR INT TERM HUP
    set +e
    restore
    if (( reload_started )); then
        "$apache_configtest" configtest >/dev/null 2>&1
        "$nginx_configtest" -t >/dev/null 2>&1
        "$reload_command" reload apache2 >/dev/null 2>&1
        "$reload_command" reload nginx >/dev/null 2>&1
    fi
    exit "$rc"
}
reload_started=0
trap rollback_on_failure ERR INT TERM HUP

python3 - "$plan" "$root" "$unprivileged" <<'PY'
import json, os, pathlib, shutil, tempfile, sys
plan=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2]); unprivileged=sys.argv[3]
for item in plan['items']:
    target=root/item['target'].lstrip('/')
    # Refuse any pre-existing symlink component. Atomic replacement protects the
    # final basename only; a symlinked parent would redirect the write outside
    # the approved root/target namespace.
    relative = pathlib.PurePosixPath(item['target'].lstrip('/'))
    cursor = root
    for component in relative.parts[:-1]:
        cursor = cursor / component
        if cursor.is_symlink():
            raise SystemExit(f'activation target parent is a symlink: {cursor}')
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        raise SystemExit(f'activation target is a symlink: {item["target"]}')
    fd,tmp=tempfile.mkstemp(dir=target.parent,prefix='.'+target.name+'.incoming-')
    try:
        with open(item['source'],'rb') as source, os.fdopen(fd,'wb') as output:
            shutil.copyfileobj(source,output); output.flush(); os.fsync(output.fileno())
        os.chmod(tmp,item['mode']); os.replace(tmp,target)
    except BaseException:
        try: os.close(fd)
        except OSError: pass
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise
www_data_gid = 33
if unprivileged != '1':
    import grp
    www_data_gid = grp.getgrnam('www-data').gr_gid
for path in ('/var/lib/php/sessions/am2','/var/lib/php/sessions/am2-staging'):
    directory=root/path.lstrip('/')
    directory.mkdir(parents=True,exist_ok=True)
    os.chmod(directory,0o1730)
    if unprivileged != '1': os.chown(directory,0,www_data_gid)
PY

"$apache_configtest" configtest
"$nginx_configtest" -t
reload_started=1
"$reload_command" reload apache2
"$reload_command" reload nginx

verify_args=(--receipt "$receipt" --expected-manifest "$expected_manifest" --lifecycle "$lifecycle")
if (( unprivileged )); then
    verify_args+=(--root "$root" --unprivileged-root)
fi
"$verify_installed" "${verify_args[@]}"

# Keep the replaced receipt beside the new rollback anchor. The new receipt
# overwrites the canonical path, and the chain of activations must stay readable.
# The archive is written from bytes that match the digest taken when the receipt
# was checked, not from whatever the path names now.
if (( supersede )); then
    python3 - "$activation_receipt" "$superseded_sha256" "$backup/superseded-activation.json" "$unprivileged" <<'PY'
import hashlib, os, stat, sys
path, expected, archive, unprivileged = sys.argv[1:]
fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, 'rb') as stream:
    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
        raise SystemExit('active activation receipt changed before it was archived')
    raw = stream.read()
if hashlib.sha256(raw).hexdigest() != expected:
    raise SystemExit('active activation receipt changed before it was archived')
out = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(out, 'wb') as stream:
    stream.write(raw); stream.flush(); os.fsync(stream.fileno())
os.chmod(archive, 0o600)
if unprivileged != '1': os.chown(archive, 0, 0)
PY
fi

python3 - "$plan" "$activation_receipt" "$backup" "$unprivileged" "$root" "$backup_manifest_sha256" "${superseded_sha256:-}" <<'PY'
import json, os, pathlib, tempfile, time, sys
plan_path,out,backup,unprivileged,root,backup_manifest_sha256,superseded_sha256=sys.argv[1:]
plan=json.load(open(plan_path)); value={
 'schema_version':1, 'application':'am2-host-security-activation', **plan['identity'],
 'activated_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),
 'backup_path':backup, 'backup_manifest_sha256':backup_manifest_sha256,
 'root_path':os.path.realpath(root),
 'privileged':unprivileged!='1', 'status':'verified'}
# Binds the archived superseded-activation.json to the receipt that was replaced,
# so rollback restores that receipt and nothing substituted for it.
if superseded_sha256:
    value['superseded_activation_sha256']=superseded_sha256
parent=pathlib.Path(out).parent; parent.mkdir(parents=True,exist_ok=True)
fd,tmp=tempfile.mkstemp(dir=parent,prefix='.host-security-activation-')
with os.fdopen(fd,'w') as stream:
    json.dump(value,stream,sort_keys=True,indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
os.chmod(tmp,0o644); os.replace(tmp,out)
PY
trap - ERR INT TERM HUP
printf 'host-security activated: %s\n' "$activation_receipt"
