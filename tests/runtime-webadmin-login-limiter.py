#!/usr/bin/env python3
"""Real nginx regression; only on a disposable GitHub-hosted runner."""
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / 'infra/contracts/host-security-contract.json').read_text())
ZONE_TARGET = '/etc/nginx/conf.d/am2-maps-and-limits.conf'
# Existing installed policy, used ONLY to expose the route defect before it is tracked.
EXISTING_ZONE = 'limit_req_zone $binary_remote_addr zone=am2_webadmin_login:10m rate=10r/m;'


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


class LoginLimiter(unittest.TestCase):
    def test_zone_is_in_the_sealed_host_security_inputs(self):
        entries = [entry for entry in CONTRACT['files'] if entry.get('target') == ZONE_TARGET]
        self.assertEqual(len(entries), 1, 'login zone is installed in /etc but absent from the sealed contract')
        entry = entries[0]
        self.assertEqual(entry['consumer'], 'nginx')
        self.assertEqual(entry['mode'], '0644')
        self.assertTrue((ROOT / entry['source']).is_file(), 'governed zone source is missing')

    def test_both_login_routes_share_one_per_client_budget(self):
        for lane, filename in [('production', 'am2-webadmin.conf'), ('staging', 'am2-webadmin-staging.conf')]:
            with self.subTest(lane=lane), tempfile.TemporaryDirectory(prefix='am2-login-nginx-') as directory:
                self.exercise_vhost(Path(directory), filename)

    def exercise_vhost(self, base, filename):
        frontend, backend, redirect = port(), port(), port()
        self.assertEqual(len({frontend, backend, redirect}), 3, 'fixture ports collided; retry the job')
        snippets = base / 'snippets'
        snippets.mkdir()
        for entry in CONTRACT['files']:
            if entry['consumer'] == 'nginx' and entry.get('target', '').startswith('/etc/nginx/snippets/'):
                shutil.copyfile(ROOT / entry['source'], snippets / Path(entry['target']).name)
        # Keep every location/proxy/real-IP directive. Adapt only TLS, sockets and logs.
        source = (ROOT / 'infra/nginx' / filename).read_text()
        source, count = re.subn(r'server 127\.0\.0\.1:808[01];', f'server 127.0.0.1:{backend};', source)
        self.assertEqual(count, 1, 'fixture must replace exactly one upstream, never contact a real service')
        source, count = re.subn(r'(?m)^\s*listen 80;', f'    listen 127.0.0.1:{redirect};', source)
        self.assertEqual(count, 1)
        source, count = re.subn(r'(?m)^\s*listen 443 ssl http2;', f'    listen 127.0.0.1:{frontend};', source)
        self.assertEqual(count, 1)
        source = '\n'.join(line for line in source.splitlines()
                           if not re.match(r'^\s*(?:ssl_\w+\s|include /etc/letsencrypt/|(?:access|error)_log /var/log/nginx/)', line))
        zones = [entry for entry in CONTRACT['files']
                 if entry['consumer'] == 'nginx' and entry.get('target', '').startswith('/etc/nginx/conf.d/')]
        zone_config = '\n'.join((ROOT / entry['source']).read_text() for entry in zones)
        if not zones:
            print(f'{filename}: route-only RED uses existing-zone fixture; contract assertion remains mandatory', flush=True)
            zone_config = EXISTING_ZONE
        config = base / 'nginx.conf'
        config.write_text(f'''daemon off;
master_process off;
pid {base}/nginx.pid;
error_log {base}/error.log warn;
events {{ worker_connections 128; }}
http {{
    access_log off;
    client_body_temp_path {base}/client-body;
    proxy_temp_path {base}/proxy;
    fastcgi_temp_path {base}/fastcgi;
    uwsgi_temp_path {base}/uwsgi;
    scgi_temp_path {base}/scgi;
    {zone_config}
    server {{ listen 127.0.0.1:{backend}; location / {{ return 200 "synthetic upstream"; }} }}
    {source}
}}
''')
        command = ['nginx', '-p', str(base) + '/', '-c', str(config)]
        check = subprocess.run(command + ['-t'], text=True, capture_output=True, timeout=10)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

        def request(path, client='127.0.0.2', headers=None):
            connection = http.client.HTTPConnection('127.0.0.1', frontend, timeout=2,
                                                    source_address=(client, 0))
            try:
                connection.request('POST', path, body='{}', headers=headers or {})
                response = connection.getresponse()
                body = response.read()
                if response.status == 200:
                    self.assertEqual(body, b'synthetic upstream', 'request must reach only the synthetic upstream')
                return response.status
            finally:
                connection.close()

        try:
            deadline = time.monotonic() + 5
            while True:
                self.assertIsNone(process.poll(), 'disposable nginx exited during startup')
                try:
                    self.assertEqual(request('/fixture-ready'), 200)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            for first, sibling, client in [('/login.php', '/api_login.php', '127.0.0.2'),
                                           ('/api_login.php', '/login.php', '127.0.0.3')]:
                with self.subTest(vhost=filename, first=first):
                    accepted = [request(first + '?fixture=1', client) for _ in range(6)]
                    self.assertEqual(accepted, [200] * 6, 'first request + burst=5 must pass without delay')
                    self.assertEqual(request(first, client), 503, f'{filename}: {first} seventh request bypassed burst=5')
                    self.assertEqual(request(sibling, client), 503, f'{filename}: {sibling} bypassed the shared login budget')
                    self.assertEqual(request(sibling, client, {'CF-Connecting-IP': '192.0.2.1',
                                                               'X-Forwarded-For': '192.0.2.2'}), 503,
                                     'untrusted forwarding headers must not reset the budget')
                    self.assertEqual([request('/index.php', client) for _ in range(8)], [200] * 8,
                                     'non-login routes must not inherit the limiter')
                    other = '127.0.0.4' if client == '127.0.0.2' else '127.0.0.5'
                    self.assertEqual(request(first, other), 200, 'a different peer must have its own budget')
                    # Real 10r/m: one slot after six seconds, not zero or two slots.
                    time.sleep(6.2)
                    self.assertEqual(request(first, client), 200, '10r/m must replenish one slot after six seconds')
                    self.assertEqual(request(sibling, client), 503, 'the replenished slot must be shared by both routes')
        finally:
            process.terminate()
            try:
                _, stderr = process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                _, stderr = process.communicate(timeout=5)
            diagnostics = (base / 'error.log').read_text() if (base / 'error.log').exists() else ''
            print(f'{filename}: disposable nginx diagnostics\n{stderr}{diagnostics}', flush=True)


if __name__ == '__main__':
    if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise SystemExit('requires an explicitly disposable GitHub-hosted runner; never run on AM2-AdminOps')
    unittest.main(verbosity=2)
