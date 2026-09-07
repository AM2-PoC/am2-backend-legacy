#!/usr/bin/env bash
#
# Put a built APK and its manifest into an update channel, or refuse.
#
# The channel is four files in two directories, and every way it breaks is
# quiet. A manifest whose version_code does not exceed the published one makes
# every handset decide there is nothing to fetch -- no error, no log, and the
# release simply never arrives. A file copied in with the wrong group is
# unreadable to the relay while looking perfectly present in `ls`. An APK signed
# by a different key is rejected by Android on the device, far from whoever
# published it.
#
# Publishing was a `cp` a person ran from memory. This makes the checks part of
# the act: the group is set as the file is created rather than corrected
# afterwards, the artefact is in place before the manifest that promises it, and
# a publish that would be invisible to handsets is refused rather than reported
# as done.
set -euo pipefail

usage() {
    cat >&2 <<'USAGE'
Usage: publish-update-channel.sh --source DIR --channel DIR
         [--manifest version.json] [--group www-data] [--mode 0640]
         [--allow-signer-change]

  --source   directory holding the built artefact and its manifest
  --channel  the published channel directory
  --manifest manifest filename in both (default version.json)
USAGE
}

source_dir=
channel_dir=
manifest_name=version.json
group=www-data
mode=0640
allow_signer_change=0

while [[ $# -gt 0 ]]; do
    case $1 in
        --source) [[ $# -ge 2 ]] || { usage; exit 64; }; source_dir=$2; shift 2 ;;
        --channel) [[ $# -ge 2 ]] || { usage; exit 64; }; channel_dir=$2; shift 2 ;;
        --manifest) [[ $# -ge 2 ]] || { usage; exit 64; }; manifest_name=$2; shift 2 ;;
        --group) [[ $# -ge 2 ]] || { usage; exit 64; }; group=$2; shift 2 ;;
        --mode) [[ $# -ge 2 ]] || { usage; exit 64; }; mode=$2; shift 2 ;;
        --allow-signer-change) allow_signer_change=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage; exit 64 ;;
    esac
done

[[ -n $source_dir && -n $channel_dir ]] || { usage; exit 64; }
[[ $source_dir == /* && -d $source_dir ]] || { echo "source must be an absolute directory: $source_dir" >&2; exit 1; }
[[ $channel_dir == /* && -d $channel_dir ]] || { echo "channel must be an absolute directory: $channel_dir" >&2; exit 1; }
[[ $manifest_name != */* ]] || { echo "manifest must be a filename, not a path: $manifest_name" >&2; exit 1; }

incoming=$source_dir/$manifest_name
[[ -f $incoming && ! -L $incoming ]] || { echo "no manifest to publish: $incoming" >&2; exit 1; }

published=$channel_dir/$manifest_name

# Everything the decision needs, read once, in one place. The artefact name
# comes from the manifest's own download url exactly as check-update-channels.sh
# derives it, so the two agree on which file the channel is offering.
read -r artefact_name incoming_code incoming_sha incoming_signer < <(
    python3 - "$incoming" <<'PY'
import json, re, sys

manifest = json.load(open(sys.argv[1], encoding='utf-8'))

url = ''
for key in ('update_url', 'download_url'):
    candidate = str(manifest.get(key) or '').strip()
    if candidate:
        url = candidate
        break
if not url:
    raise SystemExit('the manifest offers no download url, so there is nothing to publish')

name = url.rsplit('/', 1)[-1]
if not name or '/' in name or name in ('.', '..'):
    raise SystemExit(f'the manifest names an unusable artefact: {name!r}')

code = manifest.get('version_code')
if not isinstance(code, int) or isinstance(code, bool) or code <= 0:
    raise SystemExit(f'version_code must be a positive integer, not {code!r}')

digest = str(manifest.get('sha256') or '')
if not re.fullmatch(r'[0-9a-f]{64}', digest):
    raise SystemExit('the manifest declares no usable sha256; a channel that '
                     'cannot be checked is a channel that cannot be trusted')

signer = str(manifest.get('signer_sha256') or '')
print(name, code, digest, signer or '-')
PY
)

artefact=$source_dir/$artefact_name
[[ -f $artefact && ! -L $artefact ]] || { echo "the manifest names $artefact_name, which is not in the source" >&2; exit 1; }

actual=$(sha256sum -- "$artefact" | cut -d' ' -f1)
if [[ $actual != "$incoming_sha" ]]; then
    echo "the artefact is ${actual:0:12}, the manifest says ${incoming_sha:0:12}" >&2
    echo "publishing this pair would advertise bytes nobody has" >&2
    exit 1
fi

# What is already there decides whether this publish can be seen at all.
if [[ -f $published ]]; then
    if ! python3 - "$published" "$incoming_code" "$incoming_signer" "$allow_signer_change" <<'PY'
import json, sys

published_path, incoming_code, incoming_signer, allow_signer_change = sys.argv[1:]
current = json.load(open(published_path, encoding='utf-8'))

current_code = current.get('version_code')
if isinstance(current_code, int) and not isinstance(current_code, bool):
    if int(incoming_code) <= current_code:
        raise SystemExit(
            f'version_code {incoming_code} does not exceed the published '
            f'{current_code}. Handsets compare codes and would decide there is '
            'nothing to fetch, so this publish would succeed here and be '
            'invisible in the field.')

current_signer = str(current.get('signer_sha256') or '')
if current_signer and incoming_signer != '-' and incoming_signer != current_signer:
    if allow_signer_change != '1':
        raise SystemExit(
            f'the signer changes from {current_signer[:12]} to '
            f'{incoming_signer[:12]}. Android refuses an update signed by a '
            'different key, so every handset in this channel would fail to '
            'install it and would need a manual reinstall. Pass '
            '--allow-signer-change if that is the intent.')
PY
    then
        exit 1
    fi
fi

# The artefact lands before the manifest that promises it, so the channel is
# never in a state where it advertises a digest for bytes that are not there.
# `install` sets the group as the file is created: correcting it afterwards
# leaves a window, and forgetting to correct it leaves a channel that looks
# published and serves nothing.
install -g "$group" -m "$mode" -- "$artefact" "$channel_dir/.$artefact_name.incoming"
mv -- "$channel_dir/.$artefact_name.incoming" "$channel_dir/$artefact_name"

install -g "$group" -m "$mode" -- "$incoming" "$channel_dir/.$manifest_name.incoming"
mv -- "$channel_dir/.$manifest_name.incoming" "$published"

# Read back what is actually on disk rather than trusting what was just written.
settled=$(sha256sum -- "$channel_dir/$artefact_name" | cut -d' ' -f1)
if [[ $settled != "$incoming_sha" ]]; then
    echo "the published artefact is ${settled:0:12}, the published manifest says ${incoming_sha:0:12}" >&2
    exit 1
fi

echo "published  $artefact_name  version_code $incoming_code  ${incoming_sha:0:12}  -> $channel_dir"
