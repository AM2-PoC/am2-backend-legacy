// The gates between a release and production, written down and sequenced.
//
// On 2026-09-04 at 11:29:06 a release was promoted to production with none of
// them: no staging acceptance, no rollback target recorded, no smoke against
// the production environment, no separate approval. It was not the cause of the
// deletion six minutes later -- the vulnerability predated it -- but the gates
// existed on paper and were skipped, which is the only interesting fact about
// them.
//
// Later the same day the same gates were run correctly, by hand, one command at
// a time. That is the failure mode this file exists to end: a sequence that
// lives in a runbook and in whoever happens to be doing it. The steps were
// already scripted individually; what was missing was something that refuses to
// continue when one of them fails.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const GATE = 'infra/scripts/promote-to-production.sh';

describe('production promotion gate', () => {
    test('the gate exists and is runnable', () => {
        assert.ok(existsSync(join(ROOT, GATE)), `${GATE} does not exist`);
        assert.ok(statSync(join(ROOT, GATE)).mode & 0o111, `${GATE} is not executable`);
    });

    test('it runs every step that was skipped on 11:29, in order', () => {
        const s = read(GATE);
        // Named individually rather than counted, because "some checks ran" is
        // exactly what a skipped gate looks like from the outside.
        for (const step of ['verify-current-release.sh', 'smoke-release.sh',
                            'verify-webadmin-guard.sh']) {
            assert.ok(s.includes(step), `the gate never runs ${step}`);
        }
        const order = ['verify-current-release.sh', 'smoke-release.sh'];
        assert.ok(s.indexOf(order[0]) < s.indexOf(order[1]),
            'the release is smoked before it is verified');
    });

    test('the rollback target is verified too, not just recorded', () => {
        // Writing down what to roll back to proves nothing if that release can
        // no longer start. Both were checked by hand today; the gate has to do
        // it or the rollback is a hope rather than a plan.
        const s = read(GATE);
        assert.match(s, /rollback/i);
        assert.match(s, /"\$VERIFY_CURRENT" "\$old"/,
            'the rollback target is never verified, only named');
    });

    test('it refuses to continue when a gate fails', () => {
        const s = read(GATE);
        assert.match(s, /set -euo pipefail/,
            'a failing gate would be stepped over rather than stopping the promotion');
        assert.doesNotMatch(s, /(?:verify|smoke|curl|systemctl|readlink|relay-source-digest)[^\n]*\|\|\s*true\s*$/m,
            'a safety gate result is discarded');
    });

    test('it will not promote a SHA that staging never ran', () => {
        /*
         * The gate that would have caught 11:29. Production took a release
         * built from a SHA that no staging release had ever been built from,
         * and nothing anywhere noticed.
         */
        const s = read(GATE);
        assert.match(s, /staging/,
            'the gate does not look at staging at all');
        assert.match(s, /\.release-sha/,
            'the gate cannot tell which SHA staging is running');
    });

    test('it records who promoted what, and when', () => {
        // The artifact-only plan asks for an immutable receipt naming actor,
        // source SHA and release. Today the only record that production moved
        // at 11:29 was the symlink's own mtime.
        const s = read(GATE);
        assert.match(s, /receipt|RECEIPT/,
            'a promotion leaves no record beyond a symlink mtime');
    });

    test('archive identity comes from verified materialization metadata, not a directory name', () => {
        const s = read(GATE);
        assert.match(s, /\.artifact-identity\.json/,
            'promotion trusts a caller-provided digest without release metadata');
        assert.match(s, /archive_sha256[\s\S]*artifact-identity/i);
    });

    test('artifact packaging carries every post-cutover verifier the gate invokes', () => {
        const packager = read('infra/scripts/package-runtime-artifact.sh');
        assert.match(packager, /verify-webadmin-guard\.sh/,
            'promotion selects the candidate before invoking a verifier absent from its artifact');
    });

    test('promotion runs a fresh runtime-boundary audit before activation', () => {
        const s = read(GATE);
        assert.match(s, /AM2_RUNTIME_BOUNDARY_AUDIT[^\n]*audit-runtime-boundary\.sh/,
            'promotion has no host-owned runtime-boundary audit interface');
        assert.match(s, /"\$RUNTIME_BOUNDARY_AUDIT" --deploy-gate[\s\S]*step "staging runtime and rehearsal identity"/,
            'promotion does not fail closed on fresh runtime-boundary drift before promotion gates');
    });

    test('promotion owns the deployment lock and automatically restores failures', () => {
        const s = read(GATE);
        assert.match(s, /flock[^\n]*deploy\.lock|deploy\.lock[\s\S]*flock/,
            'promotion never owns the deployment lock');
        assert.match(s, /trap[\s\S]*rollback|rollback[\s\S]*trap/,
            'post-cutover failure leaves production selected on the failed candidate');
    });

    test('relay decisions use canonical running identity and bounded readiness', () => {
        const s = read(GATE);
        assert.match(s, /relay-source-digest\.sh/,
            'promotion carries a weaker second relay digest');
        assert.match(s, /\/proc\/\$\{?[^}]*pid[^}]*\}?\/cwd|\/proc\/\$pid\/cwd/i,
            'promotion compares against the old pointer instead of the running PID cwd');
        assert.match(s, /curl[\s\S]*(?:PTT Server|http)/i,
            'post-restart verification accepts systemd active without application readiness');
        assert.match(s, /healthy_samples[\s\S]*NRestarts/,
            'production readiness accepts one transient healthy sample');
    });

    test('staging gate requires runtime identity and an exact rehearsal receipt', () => {
        const s = read(GATE);
        assert.match(s, /am2-api-staging/);
        assert.match(s, /staging[\s\S]*MainPID|MainPID[\s\S]*staging/,
            'staging gate checks only the symlink marker');
        assert.match(s, /rehearsal|acceptance.*receipt|receipt.*staging/i,
            'staging gate accepts a pointer move without rollback/re-promotion evidence');
        assert.match(s, /verify-materialized-artifact\.sh|VERIFY_ARTIFACT/,
            'staging gate does not verify exact artifact bytes');
        const rehearsal = read('infra/scripts/rehearse-staging-artifact.sh');
        for (const evidence of ['candidate_pid', 'rollback_pid', 'repromoted_pid', 'archive_sha256', 'payload_sha256']) {
            assert.match(rehearsal, new RegExp(evidence), `staging rehearsal omits ${evidence}`);
        }
        assert.ok(rehearsal.indexOf('flock -x 9') < rehearsal.indexOf('old=$(readlink -f "$CURRENT")'),
            'staging rollback identity is captured before owning the deployment lock');
        assert.match(rehearsal, /healthy_samples[\s\S]*NRestarts/,
            'staging readiness accepts one transient healthy sample');
    });

    test('candidate and rollback use the stable host-owned compatibility verifier', () => {
        const s = read(GATE);
        assert.match(s, /VERIFY_CURRENT[^\n]*verify-current-release\.sh[\s\S]*"\$VERIFY_CURRENT" "\$release"/,
            'candidate does not use the host-owned verifier');
        assert.match(s, /"\$VERIFY_CURRENT" "\$old"/,
            'legacy rollback releases are rejected by a release-local verifier');
    });

    test('fresh-install schemas prohibit destructive admin cascades', () => {
        for (const file of ['infra/docker/seed/01-schema.sql', 'server/struktur_am2.sql']) {
            const schema = read(file);
            const fk = schema.match(/ADD CONSTRAINT fk_user_admin[\s\S]{0,180}/)?.[0] ?? '';
            assert.match(fk, /ON DELETE RESTRICT/,
                `${file} still creates a destructive users→admin cascade`);
            assert.doesNotMatch(fk, /ON DELETE CASCADE/);
        }
    });

    test('post-cutover failure automatically restores the previous release', () => {
        const base = mkdtempSync(join(tmpdir(), 'am2-promotion-rollback-'));
        const bin = join(base, 'bin');
        const old = join(base, 'old');
        const archive = 'b'.repeat(64);
        const candidate = join(base, `artifact-${archive}`);
        const staging = join(base, 'staging');
        const current = join(base, 'current');
        const rehearsal = join(base, 'rehearsal.txt');
        const sha = 'a'.repeat(40);
        const makeRelease = (dir) => {
            mkdirSync(join(dir, 'server'), { recursive: true });
            mkdirSync(join(dir, 'infra/scripts'), { recursive: true });
            writeFileSync(join(dir, '.release-sha'), `${sha}\n`);
            writeFileSync(join(dir, '.artifact-identity.json'), `${JSON.stringify({ source_sha: sha, archive_sha256: archive, payload_sha256: 'c'.repeat(64) })}\n`);
            for (const script of ['smoke-release.sh', 'verify-webadmin-guard.sh']) {
                writeFileSync(join(dir, 'infra/scripts', script), '#!/bin/sh\nexit 0\n');
                chmodSync(join(dir, 'infra/scripts', script), 0o755);
            }
        };
        try {
            mkdirSync(bin);
            makeRelease(old);
            makeRelease(candidate);
            symlinkSync(candidate, staging);
            symlinkSync(old, current);
            writeFileSync(rehearsal, `source_sha ${sha}\narchive_sha256 ${archive}\nstatus verified\n`);
            const commands = {
                systemctl: '#!/bin/sh\ncase "$*" in *MainPID*) echo 123;; *NRestarts*) echo 0;; *is-active*) echo active;; esac\nexit 0\n',
                curl: '#!/bin/sh\nprintf "PTT Server\\n"\n',
                readlink: `#!/bin/sh\nif [ "$1" = "-f" ] && [ "$2" = "/proc/123/cwd" ]; then echo ${old}/server; else exec /usr/bin/readlink "$@"; fi\n`,
                sudo: '#!/bin/sh\nexit 0\n',
            };
            for (const [name, body] of Object.entries(commands)) {
                writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755);
            }
            const verify = join(base, 'verify-current');
            const digest = join(base, 'relay-digest');
            writeFileSync(verify, '#!/bin/sh\nexit 0\n'); chmodSync(verify, 0o755);
            writeFileSync(digest, '#!/bin/sh\nprintf "same\\n"\n'); chmodSync(digest, 0o755);
            // A non-directory receipts path forces a failure after pointer cutover.
            const receipts = join(base, 'receipts-file'); writeFileSync(receipts, 'blocked\n');
            const run = spawnSync('bash', [join(ROOT, GATE), '--release', candidate,
                '--archive-sha256', archive, '--staging-rehearsal-receipt', rehearsal], {
                encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
                    AM2_PRODUCTION_CURRENT: current, AM2_STAGING_CURRENT: staging,
                    AM2_PROMOTION_RECEIPTS: receipts, AM2_DEPLOY_LOCK: join(base, 'deploy.lock'),
                    AM2_VERIFY_CURRENT: verify, AM2_RELAY_DIGEST: digest,
                    AM2_PRODUCTION_ENV: join(base, 'prod.env'), AM2_PRODUCTION_URL: 'http://test/', AM2_STAGING_URL: 'http://test/' },
            });
            assert.notEqual(run.status, 0, 'forced post-cutover failure unexpectedly succeeded');
            assert.equal(realpathSync(current), old, `candidate remained selected:\n${run.stdout}\n${run.stderr}`);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    test('it is the runbook, so the runbook stops describing the steps twice', () => {
        const doc = read('docs/how-to/deploy-and-roll-back.md');
        assert.match(doc, /promote-to-production\.sh/,
            'the runbook still asks a person to sequence the gates by hand');
    });
});
