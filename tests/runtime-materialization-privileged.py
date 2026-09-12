#!/usr/bin/env python3
"""Privilege regression: disposable GitHub-hosted runner only; no host services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'infra/scripts'
UID = 65534
GID = 65534


def run(*args, uid=None):
    def drop():
        os.setgroups([])
        os.setgid(GID)
        os.setuid(uid)
    return subprocess.run([str(a) for a in args], text=True, capture_output=True,
                          preexec_fn=drop if uid is not None else None)


def ok(result):
    assert result.returncode == 0, result.stdout + result.stderr


class Materialization(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='am2-privilege-', dir='/'))
        self.base.chmod(0o755)
        self.scripts = self.base / 'scripts'
        shutil.copytree(SCRIPTS, self.scripts)
        self.env = self.base / 'environment'
        self.releases = self.env / 'releases'
        self.releases.mkdir(parents=True)
        os.chown(self.releases, 0, GID)
        self.releases.chmod(0o2750)
        for name in ('webadmin-update', 'server-update'):
            path = self.env / 'shared' / name
            path.mkdir(parents=True)
            os.chown(path, UID, GID)
        self.ingress = self.base / 'ingress'
        self.ingress.mkdir()
        payload = self.base / 'payload'
        files = {
            '.release-sha': 'a' * 40 + '\n',
            'server/server.js': '"use strict";\n',
            'server/package.json': '{"engines":{"node":"22.x"},"dependencies":{"fs":"*"}}',
            'server/package-lock.json': '{"packages":{"":{"engines":{"node":"22.x"}}}}',
            'server/node_modules/placeholder': '',
            'WebAdmin/login.php': '<?php echo "fixture";',
            'WebAdmin/asset/js/am2-ui.min.js': '// fixture\n',
            'infra/scripts/smoke-release.sh': '#!/bin/sh\nexit 0\n',
        }
        for name, content in files.items():
            path = payload / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
            path.chmod(0o755 if name.endswith('.sh') else 0o644)
        tar = ['tar', '--sort=name', '--mtime=UTC 1970-01-01', '--owner=0', '--group=0', '--numeric-owner', '-C', str(payload)]
        raw = subprocess.check_output(tar + ['-cf', '-', '.'])
        archive = self.ingress / 'am2-backend-runtime.tar.gz'
        ok(run(*tar, '-czf', archive, '.'))
        lock = b'{"packages":{}}'
        (self.ingress / 'lockfiles').mkdir()
        for name in ('server', 'webadmin'):
            (self.ingress / 'lockfiles' / f'{name}-package-lock.json').write_bytes(lock)
        digest = lambda b: hashlib.sha256(b).hexdigest()
        runtime_node = subprocess.check_output(['node', '-p', 'process.versions.node.split(".")[0]'], text=True).strip()
        manifest = {'schema_version': 1, 'application': 'am2-backend', 'source_sha': 'a' * 40,
                    'payload_sha256': digest(raw), 'archive_sha256': digest(archive.read_bytes()),
                    'runtime': {'node': runtime_node, 'php': '8.3'},
                    'lockfiles': {f'{name}_package_lock_sha256': digest(lock) for name in ('server', 'webadmin')}}
        self.manifest = self.ingress / 'artifact-manifest.json'
        self.manifest.write_text(json.dumps(manifest))
        members = ['am2-backend-runtime.tar.gz', 'artifact-manifest.json', 'lockfiles/server-package-lock.json', 'lockfiles/webadmin-package-lock.json']
        (self.ingress / 'SHA256SUMS').write_text(''.join(f'{digest((self.ingress / p).read_bytes())}  {p}\n' for p in members))
        self.dest = self.releases / 'candidate'

    def tearDown(self):
        shutil.rmtree(self.base)

    def materialize(self, uid=None):
        return run('bash', self.scripts / 'materialize-runtime-release.sh',
                   '--archive', self.ingress / 'am2-backend-runtime.tar.gz',
                   '--manifest', self.manifest, '--checksums', self.ingress / 'SHA256SUMS',
                   '--dest', self.dest,
                   '--webadmin-update', self.env / 'shared/webadmin-update',
                   '--server-update', self.env / 'shared/server-update', uid=uid)

    def verify(self):
        return run('bash', self.scripts / 'verify-materialized-artifact.sh',
                   '--release', self.dest, '--manifest', self.manifest)

    def test_fresh_root_inodes_runtime_reads_and_shared_writes(self):
        # An unprivileged writer keeps an FD across root's chown/chmod. This is
        # the actual kernel counterexample to "seal" by changing old ownership.
        old = self.base / 'old-runtime'
        old.write_text('old bytes')
        os.chown(old, UID, GID)
        reader, writer = os.pipe()
        ready_reader, ready_writer = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(writer)
            os.setgroups([]); os.setgid(GID); os.setuid(UID)
            fd = os.open(old, os.O_WRONLY)
            os.close(ready_reader)
            os.write(ready_writer, b'x')
            os.close(ready_writer)
            os.read(reader, 1)
            os.write(fd, b'FD ATTACK')
            os.close(fd)
            os._exit(0)
        os.close(reader)
        os.close(ready_writer)
        self.assertEqual(os.read(ready_reader, 1), b'x', 'child never held writable FD')
        os.close(ready_reader)
        os.chown(old, 0, 0); old.chmod(0o444)
        try:
            ok(self.materialize())
            os.write(writer, b'x'); os.close(writer)
            self.assertEqual(os.waitpid(child, 0)[1], 0)
            self.assertEqual(old.read_text(), 'FD ATTACK')
            target = self.dest / 'server/server.js'
            self.assertNotEqual(old.stat().st_ino, target.stat().st_ino)
            self.assertEqual(target.read_text(), '"use strict";\n')
            self.assertEqual(target.stat().st_uid, 0)
            ok(run('cat', target, uid=UID))
            self.assertNotEqual(run('sh', '-c', 'echo attack >> "$1"', '_', target, uid=UID).returncode, 0)
            self.assertNotEqual(run('mv', self.dest, self.releases / 'stolen', uid=UID).returncode, 0)
            for name, component in [('webadmin-update', 'WebAdmin'), ('server-update', 'server')]:
                ok(run('sh', '-c', 'echo update > "$1"', '_', self.dest / component / 'update/probe', uid=UID))
            ok(self.verify())
            ok(run('bash', self.scripts / 'verify-current-release.sh', self.dest, uid=UID))
            self.env.joinpath('shared').chmod(0o777)
            self.assertNotEqual(self.verify().returncode, 0, 'accepted replaceable update store')
            self.env.joinpath('shared').chmod(0o755)
            self.assertFalse((self.env / 'current').exists())
            self.assertFalse(any(p.name.startswith('.') for p in self.releases.iterdir()))
            print('REAL UID 65534: held-FD write survived chown; fresh payload unchanged; runtime read/shared write passed', flush=True)
        finally:
            try: os.close(writer)
            except OSError: pass
            try: os.waitpid(child, 0)
            except ChildProcessError: pass

    def test_rejects_writable_ancestor_and_unprivileged_creation(self):
        self.env.chmod(0o777)
        result = self.materialize()
        self.assertNotEqual(result.returncode, 0, 'accepted writable environment ancestor')
        self.assertFalse(self.dest.exists())
        self.env.chmod(0o755)
        os.chown(self.releases, UID, GID)
        self.releases.chmod(0o755)
        result = self.materialize(uid=UID)
        self.assertNotEqual(result.returncode, 0, 'accepted unprivileged materialization')
        self.assertIn('requires root', result.stderr)
        self.assertFalse(self.dest.exists())

    def test_nested_publication_preserves_existing_destination(self):
        wrapper = self.releases / '.private'
        wrapper.mkdir(mode=0o700)
        source = wrapper / 'payload'
        source.mkdir()
        self.dest.mkdir()
        sentinel = self.dest / 'sentinel'
        sentinel.write_text('keep')
        result = run('python3', self.scripts / 'atomic-rename-no-replace.py',
                     '--source', source, '--destination', self.dest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('destination already exists', result.stderr)
        self.assertTrue(source.is_dir())
        self.assertEqual(sentinel.read_text(), 'keep')
        self.dest.joinpath('sentinel').unlink()
        self.dest.rmdir()
        wrapper.chmod(0o750)
        result = run('python3', self.scripts / 'atomic-rename-no-replace.py',
                     '--source', source, '--destination', self.dest)
        self.assertNotEqual(result.returncode, 0, 'accepted non-private staging wrapper')
        self.assertFalse(self.dest.exists())

    def test_verifiers_reject_mutable_candidate_and_rollback(self):
        ok(self.materialize())
        target = self.dest / 'server/server.js'
        os.chown(target, UID, GID)
        self.assertNotEqual(self.verify().returncode, 0, 'digest verifier accepted mutable candidate')
        result = run('bash', self.scripts / 'verify-current-release.sh', self.dest)
        self.assertNotEqual(result.returncode, 0, 'rollback preflight accepted mutable payload')


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted' or os.geteuid() != 0:
        raise SystemExit('requires root on an explicitly disposable GitHub-hosted runner')
    unittest.main(verbosity=2)
