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

# The trusted manifest is the one thing here obtained independently of the host,
# so on a real host it is required: without it the check reduces to asking an
# unsigned file on that host whether that host is fine.
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


# A receipt from an unprivileged materialization describes a fixture, and a
# non-/ root is a fixture root. Either one may be checked deliberately, but
# neither may be passed off as a statement about the real host.
if not receipt.get('privileged') and not unprivileged_root:
    raise SystemExit(
        'receipt records an unprivileged materialization; it is not evidence about this host. '
        'Pass --unprivileged-root to check it as a fixture.')
# Resolved before it is judged. `//`, `/tmp/../` and `/.` all reach the real
# host through the kernel while a string compare reads them as a fixture, which
# would skip every check that exists because the host is real.
resolved_root = os.path.realpath(str(root))
if resolved_root != '/' and not unprivileged_root:
    raise SystemExit('a root other than / is a fixture; pass --unprivileged-root to check it')
if resolved_root == '/' and unprivileged_root:
    raise SystemExit('--unprivileged-root cannot be used against the real host root')

if receipt.get('application') != 'am2-host-security-materialization':
    raise SystemExit('receipt is not a host-security materialization receipt')

# A receipt is an unsigned file on the host it describes. `privileged`,
# `materialized_by_uid` and every digest in it are self-declared, so rewriting
# them to match tampered bytes would otherwise produce a clean bill of health.
# Bind them to the independently obtained manifest instead of taking the
# receipt's word.
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
info = pathlib.Path(receipt_path).lstat()
if stat.S_IMODE(info.st_mode) & 0o022:
    raise SystemExit(f'receipt is writable beyond its owner (mode {stat.S_IMODE(info.st_mode):04o})')
if not unprivileged_root and info.st_uid != 0:
    raise SystemExit(f'receipt is owned by uid {info.st_uid}, not root')


# Where each file belongs, and how tight it must be, come from the contract --
# never from the receipt. Those two fields decide which file is examined at all,
# so a receipt that repointed one entry at a decoy would send this check to read
# pristine bytes and report health while the live file stayed edited. Digests
# alone cannot catch that: the digest of a file nobody looked at is never wrong.
#
# The contract is read from the materialization store rather than accepted as an
# argument. An argument would just move the same problem one file over -- it
# would live in the same trust domain as the files this audit polices, and a
# supplied contract could retarget an entry or relax a mode just as a receipt
# could.
#
# The store is bound by hashing to the payload digest the trusted manifest names.
# That manifest does not list the contract among its files, but payload_sha256
# spans every byte of the payload, so it covers the contract too. store_path
# needs no separate trust: whatever it points at must reproduce that digest.
store_payload = pathlib.Path(receipt['store_path'], 'payload')
sealed_contract = store_payload / 'infra/contracts/host-security-contract.json'
if not sealed_contract.is_file() or sealed_contract.is_symlink():
    raise SystemExit(f'the materialization store carries no host-security contract: {sealed_contract}')

trusted_payload = (expected if expected_manifest_path else receipt)['payload_sha256']
with tempfile.TemporaryDirectory() as scratch:
    # A materialized store is sealed read-only, so its modes no longer match the
    # ones the packager hashed. Normalise a copy rather than weakening either end.
    normalised = pathlib.Path(scratch, 'payload')
    shutil.copytree(store_payload, normalised)
    for path in normalised.rglob('*'):
        path.chmod(0o755 if path.is_dir() else 0o644)
    normalised.chmod(0o755)
    derived = subprocess.run(
        ['tar', '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0',
         '--numeric-owner', '-C', str(normalised), '-cf', '-', '.'],
        capture_output=True, check=True).stdout
    if hashlib.sha256(derived).hexdigest() != trusted_payload:
        raise SystemExit(
            'the materialization store does not reproduce the trusted payload digest, '
            'so the contract it carries is not the sealed one')

contract = json.load(open(sealed_contract, encoding='utf-8'))
declared = {item['id']: item for item in contract['files']}


def resolve_targets(entry):
    """Absolute install targets for one file, as they exist on this host."""
    entry = declared.get(entry['id'])
    if entry is None:
        raise SystemExit('receipt and contract do not describe the same host-security files')
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
        expected_mode = int(declared[entry['id']]['mode'], 8)
        if mode != expected_mode:
            report(f'{target}: mode {mode:04o}, expected {expected_mode:04o}')
        if not unprivileged_root and (info.st_uid != 0 or info.st_gid != 0):
            report(f'{target}: owned by {info.st_uid}:{info.st_gid}, expected 0:0')

        body = path.read_bytes()
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

    # Skipping byte equality must not become "anything goes". These bytes are
    # included into nginx server context, so an unrelated directive here -- an
    # `allow all`, an `auth_basic off`, a `proxy_pass` -- is live configuration
    # that the exemption would otherwise wave through.
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
        if age > lifecycle['staleness']['fail_after_days']:
            report(f'cloudflare real-IP: generated {age} days ago, past the '
                   f"{lifecycle['staleness']['fail_after_days']}-day stale-data policy")

if findings:
    for finding in findings:
        print(f'host-security drift: {finding}', file=sys.stderr)
    raise SystemExit(1)

print(f"host-security installed state verified: {receipt['source_sha']} at {root_argument}")
PY
