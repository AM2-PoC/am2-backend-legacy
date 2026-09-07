import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expected = {
  db: 5432,
  redis: 6379,
  relay: 5000,
  webadmin: 80,
};

test('development Compose publishes every service only on loopback', () => {
  const composeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('COMPOSE_')),
  );
  const output = execFileSync('docker', [
    'compose', '-f', 'docker-compose.yml', 'config', '--format', 'json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...composeEnv,
      DB_PORT: '15433',
      REDIS_PORT: '16380',
      RELAY_PORT: '15000',
      WEBADMIN_PORT: '18080',
    },
  });
  const config = JSON.parse(output);

  const publishedServices = Object.entries(config.services)
    .filter(([, service]) => (service.ports ?? []).length > 0)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(publishedServices, Object.keys(expected).sort(),
    'an unexpected service publishes a host port');

  for (const [service, target] of Object.entries(expected)) {
    const ports = config.services[service]?.ports ?? [];
    assert.equal(ports.length, 1, `${service} must publish exactly one development port`);
    assert.equal(Number(ports[0].target), target, `${service} container port changed`);
    assert.equal(
      Number(ports[0].published),
      Number({ db: 15433, redis: 16380, relay: 15000, webadmin: 18080 }[service]),
      `${service} test host port override was not applied`,
    );
    assert.equal(
      ports[0].host_ip,
      '127.0.0.1',
      `${service} development port must not listen on non-loopback interfaces`,
    );
  }
});
