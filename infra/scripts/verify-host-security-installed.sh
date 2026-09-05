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
#     byte-identical to the receipt.
#   * lane session-store separation -- the two Apache lanes must keep separate
#     session stores. When they shared one, a staging session authenticated in
#     production, which is privilege escalation rather than untidiness.
#   * externally refreshed data -- Cloudflare's real-IP ranges are refreshed on
#     Cloudflare's cadence, so they are judged by shape and provenance instead
#     of byte equality. See infra/contracts/cloudflare-realip-lifecycle.json.

usage() {
    cat >&2 <<'USAGE'
Usage: verify-host-security-installed.sh
         --receipt /absolute/receipt.json
         [--root /absolute/root]        (default /)
         [--unprivileged-root]          (the root is a fixture, not the host)
         [--lifecycle /absolute/cloudflare-realip-lifecycle.json]
USAGE
}

receipt=
root=/
unprivileged_root=0
lifecycle=
while [[ $# -gt 0 ]]; do
    case "$1" in
        --receipt) [[ $# -ge 2 ]] || { usage; exit 64; }; receipt=$2; shift 2 ;;
        --root) [[ $# -ge 2 ]] || { usage; exit 64; }; root=$2; shift 2 ;;
        --unprivileged-root) unprivileged_root=1; shift ;;
        --lifecycle) [[ $# -ge 2 ]] || { usage; exit 64; }; lifecycle=$2; shift 2 ;;
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

python3 - "$receipt" "$root" "$unprivileged_root" "$lifecycle" <<'PY'
import datetime, hashlib, json, os, pathlib, re, stat, sys

receipt_path, root_argument, unprivileged_root, lifecycle_path = sys.argv[1:]
unprivileged_root = unprivileged_root == '1'
receipt = json.load(open(receipt_path, encoding='utf-8'))
lifecycle = json.load(open(lifecycle_path, encoding='utf-8'))
root = pathlib.Path(root_argument)

findings = []


def report(message):
    findings.append(message)


# A receipt from an unprivileged materialization describes a fixture, and a
# non-/ root is a fixture root. Either one may be checked deliberately, but
# neither may be passed off as a statement about the real host.
if not receipt.get('privileged') and not unprivileged_root:
    raise SystemExit(
        'receipt records an unprivileged materialization; it is not evidence about this host. '
        'Pass --unprivileged-root to check it as a fixture.')
if str(root) != '/' and not unprivileged_root:
    raise SystemExit('a root other than / is a fixture; pass --unprivileged-root to check it')
if str(root) == '/' and unprivileged_root:
    raise SystemExit('--unprivileged-root cannot be used against the real host root')

if receipt.get('application') != 'am2-host-security-materialization':
    raise SystemExit('receipt is not a host-security materialization receipt')


def resolve_targets(entry):
    """Absolute install targets for one receipt entry, as they exist on this host."""
    if 'target' in entry:
        return [entry['target']]
    if entry.get('target_kind') == 'php-sapi-conf.d':
        # Which PHP versions exist is host state, so it is discovered here
        # rather than frozen into the receipt.
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
        if path.is_symlink():
            report(f'{target}: is a symlink, not a regular file')
            continue
        if not path.exists():
            report(f'{target}: missing')
            continue
        if not path.is_file():
            report(f'{target}: is not a regular file')
            continue

        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if mode != int(entry['mode'], 8):
            report(f"{target}: mode {mode:04o}, expected {int(entry['mode'], 8):04o}")
        if not unprivileged_root and (info.st_uid != 0 or info.st_gid != 0):
            report(f'{target}: owned by {info.st_uid}:{info.st_gid}, expected 0:0')

        body = path.read_bytes()
        installed_text[entry['id']] = body.decode('utf-8', 'replace')
        if entry['id'] == governed_id:
            # Externally refreshed: judged below by shape and provenance.
            continue
        if hashlib.sha256(body).hexdigest() != entry['sha256']:
            report(f'{target}: installed bytes differ from the receipt')

# Lane session-store separation.
lane_paths = {}
for lane, entry_id in (('production', 'apache-production-webadmin'), ('staging', 'apache-staging-webadmin')):
    text = installed_text.get(entry_id)
    if text is None:
        continue
    declared = re.findall(r'^\s*php_value\s+session\.save_path\s+(\S+)\s*$', text, re.MULTILINE)
    if not declared:
        report(f'{lane} lane declares no session.save_path of its own')
    elif len(set(declared)) > 1:
        report(f'{lane} lane declares conflicting session.save_path values: {sorted(set(declared))}')
    else:
        store = declared[0]
        if store.rstrip('/') == '/var/lib/php/sessions':
            report(f'{lane} lane uses the shared default session store {store}')
        lane_paths[lane] = store

if len(lane_paths) == 2 and lane_paths['production'] == lane_paths['staging']:
    report(f"both lanes share one session store ({lane_paths['production']}); "
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
    for directive in validation['required_directives']:
        if directive not in text:
            report(f'cloudflare real-IP: missing required directive {directive!r}')

    marker = lifecycle['provenance']['generated_marker']
    found = re.search(re.escape(marker) + r'(\d{4}-\d{2}-\d{2})', text)
    if not found:
        report('cloudflare real-IP: no generation marker, so its provenance cannot be established')
    else:
        generated = datetime.date.fromisoformat(found.group(1))
        age = (datetime.datetime.now(datetime.timezone.utc).date() - generated).days
        if age > lifecycle['staleness']['fail_after_days']:
            report(f'cloudflare real-IP: generated {age} days ago, past the '
                   f"{lifecycle['staleness']['fail_after_days']}-day stale-data policy")

if findings:
    for finding in findings:
        print(f'host-security drift: {finding}', file=sys.stderr)
    raise SystemExit(1)

print(f"host-security installed state verified: {receipt['source_sha']} at {root_argument}")
PY
