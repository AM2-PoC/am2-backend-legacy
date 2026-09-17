#!/usr/bin/env bash
set -euo pipefail

# Check what is actually installed on a host against a materialization receipt.
#
# Every other check in this pipeline reads bytes that are on their way to a
# host. This one reads the bytes that are already there, because those are the
# only ones protecting traffic. A file can be correct in Git, correct in the
# bundle, correct in the store, and still be wrong in /etc -- edited by hand,
# left world-writable, replaced by a symlink, or never installed at all.
#
# It reads and reports. It never installs, repairs, activates or reloads
# anything: a checker that can also change things is a checker whose findings
# nobody has to take seriously.
#
# Three classes of finding:
#
#   * target state -- present, a regular file, owned by root, mode 0644, and
#     byte-identical to the receipt. Where each file belongs and how tight it
#     must be come from the contract, not the receipt: a receipt that repointed
#     one entry at a decoy would otherwise send this check to read pristine
#     bytes and report health while the live file stayed edited.
#   * lane session-store separation -- the two Apache lanes must keep separate
#     session stores. When they shared one, a staging session authenticated in
#     production, which is privilege escalation rather than untidiness.
#   * externally refreshed data -- Cloudflare's real-IP ranges are refreshed on
#     Cloudflare's cadence, so they carry extra checks on shape and age. Those
#     are in addition to byte equality, never instead of it: exempting them made
#     that file the one an attacker could edit with the audit still reporting
#     health, and a single added range grants an address the right to speak for
#     any visitor. See infra/contracts/cloudflare-realip-lifecycle.json.

usage() {
    cat >&2 <<'USAGE'
Usage: verify-host-security-installed.sh
         --receipt /absolute/receipt.json
         [--root /absolute/root]        (default /)
         [--unprivileged-root]          (the root is a fixture, not the host)
         [--lifecycle /absolute/cloudflare-realip-lifecycle.json]
         [--expected-manifest /absolute/trusted-host-security-manifest.json]
USAGE
}

receipt=
root=/
unprivileged_root=0
lifecycle=
expected_manifest=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; receipt=$2; shift 2 ;;
        --root) [[ $# -ge 2 ]] || { usage; exit 64; }; root=$2; shift 2 ;;
        --unprivileged-root) unprivileged_root=1; shift ;;
        --lifecycle) [[ $# -ge 2 ]] || { usage; exit 64; }; lifecycle=$2; shift 2 ;;
        --expected-manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; expected_manifest=$2; shift 2 ;;

        *) usage; exit 64 ;;
    esac
done

[[ $receipt == /* && $root == /* ]] || { usage; exit 64; }
[[ -f $receipt && ! -L $receipt ]] || { echo "host-security receipt is missing: $receipt" >&2; exit 1; }

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ -z $lifecycle ]]; then
    lifecycle=$here/../contracts/cloudflare-realip-lifecycle.json
fi
[[ -f $lifecycle && ! -L $lifecycle ]] || { echo "Cloudflare real-IP lifecycle contract is missing: $lifecycle" >&2; exit 1; }


if [[ -z $expected_manifest && $unprivileged_root -eq 0 ]]; then
    echo "checking a real host requires --expected-manifest; a receipt alone is the host vouching for itself" >&2
    exit 64
fi
if [[ -n $expected_manifest ]]; then
    [[ $expected_manifest == /* && -f $expected_manifest && ! -L $expected_manifest ]] \
        || { echo "trusted expected manifest is missing: $expected_manifest" >&2; exit 1; }
fi


python3 - "$receipt" "$root" "$unprivileged_root" "$lifecycle" "${expected_manifest:-}" <<'PY'
import datetime, hashlib, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile

receipt_path, root_argument, unprivileged_root, lifecycle_path, expected_manifest_path = sys.argv[1:]
unprivileged_root = unprivileged_root == '1'
receipt = json.load(open(receipt_path, encoding='utf-8'))
lifecycle = json.load(open(lifecycle_path, encoding='utf-8'))
root = pathlib.Path(root_argument)

findings = []


def report(message):
    findings.append(message)


if not receipt.get('privileged') and not unprivileged_root:
    raise SystemExit(
        'receipt records an unprivileged materialization; it is not evidence about this host. '
        'Pass --unprivileged-root to check it as a fixture.')

resolved_root = os.path.realpath(str(root))
if resolved_root != '/' and not unprivileged_root:
    raise SystemExit('a root other than / is a fixture; pass --unprivileged-root to check it')
if resolved_root == '/' and unprivileged_root:
    raise SystemExit('--unprivileged-root cannot be used against the real host root')

if receipt.get('application') != 'am2-host-security-materialization':
    raise SystemExit('receipt is not a host-security materialization receipt')

if expected_manifest_path:
    expected = json.load(open(expected_manifest_path, encoding='utf-8'))
    for field in ('source_sha', 'payload_sha256', 'archive_sha256'):
        if receipt.get(field) != expected.get(field):
            raise SystemExit(f'receipt {field} does not match the trusted manifest')
    trusted_digests = {item['id']: item['sha256'] for item in expected['files']}
    receipt_digests = {item['id']: item['sha256'] for item in receipt['files']}
    if receipt_digests != trusted_digests:
        differing = sorted(
            identifier for identifier in set(trusted_digests) | set(receipt_digests)
            if trusted_digests.get(identifier) != receipt_digests.get(identifier))
        raise SystemExit(f'receipt file digests do not match the trusted manifest: {differing[:3]}')

# The receipt must be protected, or anyone who can edit it decides what
# "verified" means. The permission check applies everywhere -- a receipt the
# world can write is wrong in any context, and only checking it on the real host
# leaves the rule itself untested. Ownership is root-specific and so is checked
# only where root is meaningful.
real_host = resolved_root == '/'


def require_protected(path, label):
    """A trust anchor must not be writable by people who are not trusted.

    Whoever can write one of these decides what "verified" means as surely as
    whoever can write the files being checked: the manifest supplies every
    expected digest, the lifecycle supplies the real-IP policy, and the receipt
    names the store. World-writable is wrong anywhere. Group-writable and
    non-root ownership are wrong on a host -- but a developer checkout is
    routinely both, and it is not a host, so those apply only against /.
    """
    anchor = pathlib.Path(path).lstat()
    mode = stat.S_IMODE(anchor.st_mode)
    if mode & 0o002:
        raise SystemExit(f'{label} is world-writable (mode {mode:04o}): {path}')
    if real_host:
        if mode & 0o022:
            raise SystemExit(f'{label} is writable beyond root (mode {mode:04o}): {path}')
        if anchor.st_uid != 0:
            raise SystemExit(f'{label} is owned by uid {anchor.st_uid}, not root: {path}')


require_protected(receipt_path, 'the receipt')
require_protected(lifecycle_path, 'the real-IP lifecycle contract')
if expected_manifest_path:
    require_protected(expected_manifest_path, 'the trusted expected manifest')

info = pathlib.Path(receipt_path).lstat()
if stat.S_IMODE(info.st_mode) & 0o022:
    raise SystemExit(f'receipt is writable beyond its owner (mode {stat.S_IMODE(info.st_mode):04o})')


store_base = pathlib.Path(receipt['store_path'])
store_payload = store_base / 'payload'
trusted_payload = (expected if expected_manifest_path else receipt)['payload_sha256']
# The materialized store is another trust boundary. On a real host it must be
# root-owned and not writable outside root; otherwise an untrusted account can
# race the audit before the digest comparison even starts.
if real_host:
    require_protected(store_base, 'the materialization store')

# Copy one descriptor-opened object tree into private scratch, never traversing
# a source pathname after it has been classified. shutil.copytree() is not a
# safety primitive here: between its is_symlink() and copy2() calls a writer can
# substitute a link and make a root verifier read or chmod its target.
def snapshot_tree(source, destination):
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    file_flags = os.O_RDONLY | os.O_NOFOLLOW

    def copy_dir(source_fd, out):
        for name in os.listdir(source_fd):
            entry = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            mode = entry.st_mode
            if stat.S_ISLNK(mode):
                raise SystemExit(f'the materialization store contains a symlink: {name}')
            if stat.S_ISDIR(mode):
                child_fd = os.open(name, directory_flags, dir_fd=source_fd)
                try:
                    opened = os.fstat(child_fd)
                    if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino) or not stat.S_ISDIR(opened.st_mode):
                        raise SystemExit(f'the materialization store changed while opening directory: {name}')
                    child_out = out / name
                    child_out.mkdir(mode=0o755)
                    copy_dir(child_fd, child_out)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(mode):
                file_fd = os.open(name, file_flags, dir_fd=source_fd)
                try:
                    opened = os.fstat(file_fd)
                    if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino) or not stat.S_ISREG(opened.st_mode):
                        raise SystemExit(f'the materialization store changed while opening file: {name}')
                    output = out / name
                    with open(output, 'xb') as stream:
                        while chunk := os.read(file_fd, 1024 * 1024):
                            stream.write(chunk)
                        stream.flush()
                        os.fsync(stream.fileno())
                    output.chmod(0o644)
                finally:
                    os.close(file_fd)
            else:
                raise SystemExit(f'the materialization store contains a non-regular entry: {name}')

    root_fd = os.open(source, directory_flags)
    try:
        opened = os.fstat(root_fd)
        named = os.lstat(source)
        if (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino) or not stat.S_ISDIR(opened.st_mode):
            raise SystemExit('the materialization store changed while opening payload')
        destination.mkdir(mode=0o755)
        copy_dir(root_fd, destination)
    finally:
        os.close(root_fd)

scratch = tempfile.mkdtemp(prefix='.host-security-snapshot-')
try:
    snapshot = pathlib.Path(scratch, 'payload')
    snapshot_tree(store_payload, snapshot)
    derived = subprocess.run(
        ['tar', '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
         '--numeric-owner', '-C', str(snapshot), '-cf', '-', '.'],
        capture_output=True, check=True).stdout
    if hashlib.sha256(derived).hexdigest() != trusted_payload:
        raise SystemExit(
            'the materialization store does not reproduce the trusted payload digest, '
            'so the contract it carries is not the sealed one')

    snapshot_contract = snapshot / 'infra/contracts/host-security-contract.json'
    if not snapshot_contract.is_file() or snapshot_contract.is_symlink():
        raise SystemExit('the materialization store carries no host-security contract')
    contract = json.load(open(snapshot_contract, encoding='utf-8'))
finally:
    shutil.rmtree(scratch, ignore_errors=True)
declared = {item['id']: item for item in contract['files']}


def resolve_targets(entry):
    """Absolute install targets for one file, as they exist on this host."""
    entry = declared.get(entry['id'])
    if entry is None:
        raise SystemExit('receipt and contract do not describe the same host-security files')
    if 'target' in entry:
        return [entry['target']]
    if entry.get('target_kind') == 'php-sapi-conf.d':

        targets = []
        php_root = root / 'etc/php'
        if php_root.is_dir():
            for version in sorted(php_root.iterdir()):
                for sapi in entry['sapis']:
                    conf_d = version / sapi / 'conf.d'
                    if conf_d.is_dir():
                        targets.append('/' + str((conf_d / entry['filename']).relative_to(root)))
        if not targets:
            report(f"{entry['id']}: no PHP SAPI conf.d directory carries {entry['filename']}")
        return targets
    report(f"{entry['id']}: receipt entry resolves no install target")
    return []


governed_id = lifecycle['host_security_file_id']
installed_text = {}

for entry in receipt['files']:
    for target in resolve_targets(entry):
        path = root / target.lstrip('/')
        if not path.exists() and not path.is_symlink():
            report(f'{target}: missing')
            continue

        # One descriptor, opened without following symlinks, then metadata and
        # bytes both read through it. Separate pathname operations -- lstat,
        # then is_file, then read -- are three chances for the path to become a
        # different file between the check and the use.
        try:
            handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as error:
            report(f'{target}: cannot be opened as a regular file ({error.strerror})')
            continue
        try:
            info = os.fstat(handle)
            if not stat.S_ISREG(info.st_mode):
                report(f'{target}: is not a regular file')
                continue
            mode = stat.S_IMODE(info.st_mode)
            expected_mode = int(declared[entry['id']]['mode'], 8)
            if mode != expected_mode:
                report(f'{target}: mode {mode:04o}, expected {expected_mode:04o}')
            if not unprivileged_root and (info.st_uid != 0 or info.st_gid != 0):
                report(f'{target}: owned by {info.st_uid}:{info.st_gid}, expected 0:0')
            with os.fdopen(os.dup(handle), 'rb') as stream:
                body = stream.read()

            current = os.stat(path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or not stat.S_ISREG(current.st_mode):
                report(f'{target}: changed while being verified')
                continue
        finally:
            os.close(handle)
        installed_text[entry['id']] = body.decode('utf-8', 'replace')
        # Every file, including the externally refreshed one.
        #
        # Exempting the real-IP data from byte equality made it the single file
        # an attacker could edit with the audit still reporting health -- and one
        # appended `set_real_ip_from` line grants an address the right to set
        # CF-Connecting-IP, so it can present as any client. Bounding wholesale
        # substitution did not help, because addition is the easier attack.
        #
        # A genuine Cloudflare refresh regenerates this file, which produces a
        # new bundle and a new receipt. That is what keeps its lifecycle separate
        # from the backend release: a separate cadence and approval path, not an
        # exemption from integrity. The shape and freshness checks below stay, to
        # catch a bad refresh rather than to substitute for verifying bytes.
        if hashlib.sha256(body).hexdigest() != entry['sha256']:
            report(f'{target}: installed bytes differ from the receipt')

# Lane session-store separation.
lane_paths = {}
for lane, entry_id in (('production', 'apache-production-webadmin'), ('staging', 'apache-staging-webadmin')):
    text = installed_text.get(entry_id)
    if text is None:
        continue
    save_paths = re.findall(r'^\s*php_value\s+session\.save_path\s+(\S+)\s*$', text, re.MULTILINE)
    if not save_paths:
        report(f'{lane} lane declares no session.save_path of its own')
    elif len(set(save_paths)) > 1:
        report(f'{lane} lane declares conflicting session.save_path values: {sorted(set(save_paths))}')
    else:
        store = save_paths[0]
        if store.rstrip('/') == '/var/lib/php/sessions':
            report(f'{lane} lane uses the shared default session store {store}')
        lane_paths[lane] = store

if len(lane_paths) == 2:
    # By identity, not by spelling. A symlink, a bind mount, or two paths that
    # resolve to the same directory are one store to PHP, and one store is how a
    # staging session came to authenticate in production. Comparing the declared
    # strings only catches a lane that was edited carelessly, not one that was
    # redirected.
    def identity(lane, store):
        path = root / store.lstrip('/')
        try:

            listed = path.lstat()
        except OSError:
            report(f'{lane} session store is missing: {store}')
            return None, None
        if stat.S_ISLNK(listed.st_mode):
            report(f'{lane} session store is a symlink: {store}')
            return None, None
        if not stat.S_ISDIR(listed.st_mode):
            report(f'{lane} session store is not a directory: {store}')
            return None, None
        mode = stat.S_IMODE(listed.st_mode)
        # PHP's documented lane stores are root:www-data 1730. The sticky bit
        # protects one session file from another PHP worker; group-only write
        # lets the SAPI create files without making the directory public.
        if mode != 0o1730:
            report(f'{lane} session store mode {mode:04o}, expected 1730: {store}')
        if not unprivileged_root and (listed.st_uid != 0 or listed.st_gid != 33):
            report(f'{lane} session store owned by {listed.st_uid}:{listed.st_gid}, expected 0:33: {store}')
        resolved = os.path.realpath(path)
        return resolved, (listed.st_dev, listed.st_ino)

    production_path, production_node = identity('production', lane_paths['production'])
    staging_path, staging_node = identity('staging', lane_paths['staging'])
    if production_path is None or staging_path is None:
        pass
    elif lane_paths['production'] == lane_paths['staging']:
        report(f"both lanes declare one session store ({lane_paths['production']}); "
               'a staging session would authenticate in production')
    elif production_path == staging_path:
        report(f"both lanes resolve to one session store ({production_path}); "
               'a staging session would authenticate in production')
    elif production_node == staging_node:
        report(f"both lanes reach the same directory ({production_node[0]}:{production_node[1]}); "
               'a staging session would authenticate in production')

# Externally refreshed Cloudflare real-IP data: shape and provenance.
text = installed_text.get(governed_id)
if text is not None:
    validation = lifecycle['validation']
    ipv4 = len(re.findall(r'^\s*set_real_ip_from\s+\d[\d.]*/\d+;', text, re.MULTILINE))
    ipv6 = len(re.findall(r'^\s*set_real_ip_from\s+[0-9a-fA-F:]+/\d+;', text, re.MULTILINE))
    if ipv4 < validation['min_ipv4_ranges']:
        report(f"cloudflare real-IP: {ipv4} IPv4 ranges, fewer than the {validation['min_ipv4_ranges']} "
               'a plausible list carries')
    if ipv6 < validation['min_ipv6_ranges']:
        report(f"cloudflare real-IP: {ipv6} IPv6 ranges, fewer than the {validation['min_ipv6_ranges']} "
               'a plausible list carries')
    # A commented-out directive is not a directive. Matching the whole file lets
    # `# real_ip_header CF-Connecting-IP;` satisfy the requirement, and nginx
    # would then take the peer address -- a Cloudflare edge -- as the client.
    active = [line for line in text.splitlines() if not line.lstrip().startswith('#')]
    for directive in validation['required_directives']:
        if not any(line.strip() == directive for line in active):
            report(f'cloudflare real-IP: missing required directive {directive!r}')

    allowed = [re.compile(pattern) for pattern in validation['allowed_line_patterns']]
    for number, line in enumerate(text.splitlines(), start=1):
        if not any(pattern.match(line) for pattern in allowed):
            report(f'cloudflare real-IP: unexpected directive on line {number}: {line.strip()[:60]!r}')
            break

    # Additions are a refresh and stay quiet. Wholesale substitution is not:
    # replacing Cloudflare's networks with somebody else's hands them the right
    # to speak for any visitor, in exactly the right shape and quantity.
    networks = set(re.findall(r'^\s*set_real_ip_from\s+(\S+);', text, re.MULTILINE))
    for network in validation['required_networks']:
        if network not in networks:
            report(f'cloudflare real-IP: long-standing Cloudflare network {network} is absent; '
                   'this is a substituted list rather than a refresh')
            break

    marker = lifecycle['provenance']['generated_marker']
    found = re.search(re.escape(marker) + r'(\d{4}-\d{2}-\d{2})', text)
    if not found:
        report('cloudflare real-IP: no generation marker, so its provenance cannot be established')
    else:
        generated = datetime.date.fromisoformat(found.group(1))
        age = (datetime.datetime.now(datetime.timezone.utc).date() - generated).days
        if age < 0:
            # Not fresh data: a broken clock or a forged marker. Treating it as
            # fresh would make the stale-data policy defeatable by writing
            # tomorrow's date.
            report(f'cloudflare real-IP: generated {-age} days in the future, '
                   'so its provenance cannot be trusted')
        elif age > lifecycle['staleness']['fail_after_days']:
            report(f'cloudflare real-IP: generated {age} days ago, past the '
                   f"{lifecycle['staleness']['fail_after_days']}-day stale-data policy")

if findings:
    for finding in findings:
        print(f'host-security drift: {finding}', file=sys.stderr)
    raise SystemExit(1)

print(f"host-security installed state verified: {receipt['source_sha']} at {root_argument}")
PY
