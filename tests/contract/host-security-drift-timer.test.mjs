import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const servicePath = resolve(ROOT, 'infra/systemd/am2-host-security-drift.service');
const timerPath = resolve(ROOT, 'infra/systemd/am2-host-security-drift.timer');

test('the host-security drift audit runs periodically and only ever reads', () => {
  assert.ok(existsSync(servicePath), 'missing host-security drift audit service unit');
  assert.ok(existsSync(timerPath), 'missing host-security drift audit timer unit');
  const service = readFileSync(servicePath, 'utf8');
  const timer = readFileSync(timerPath, 'utf8');
  // Directives only: the unit is allowed to explain in comments what it
  // deliberately does not do.
  const directives = service.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  // systemd continues a directive across lines with a trailing backslash.
  const joined = directives.replace(/\\\n\s*/g, ' ');

  assert.match(joined, /^ExecStart=.*audit-host-security-drift\.sh .*--receipt /m,
    'the service unit does not run the drift audit against a receipt');

  // Without the independently obtained manifest the audit refuses on a real
  // host, so a timer that omits it fails every day and inverts the whole
  // "silence means healthy" contract into permanent noise.
  assert.match(joined, /^ExecStart=.*--expected-manifest \/\S+/m,
    'the timer would run the audit with nothing independent to check against');
  assert.match(service, /^Type=oneshot$/m);

  // Quiet on success: a timer that mails something every day trains everybody
  // to skim past it, and the one run that mattered scrolls by with the rest.
  assert.match(service, /^StandardOutput=null$/m);

  // An auditor that can also change things is one whose findings nobody has to
  // take seriously. It must not activate, reload or restart anything.
  assert.doesNotMatch(directives, /systemctl|apache2ctl|nginx -t|reload|restart|ExecStartPre|ExecStartPost/,
    'the drift audit unit may not activate or reload anything');
  assert.match(service, /^ProtectSystem=strict$/m, 'the drift audit is not confined to reading');
  assert.match(service, /^NoNewPrivileges=yes$/m);

  assert.match(timer, /^OnCalendar=/m, 'the timer never fires');
  assert.match(timer, /^Persistent=true$/m,
    'a missed audit must run after boot rather than being skipped');
  assert.match(timer, /^Unit=am2-host-security-drift\.service$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});
