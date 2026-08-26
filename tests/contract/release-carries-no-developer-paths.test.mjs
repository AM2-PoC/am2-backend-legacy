// Nothing tracked may point outside the repository.
//
// A symlink named `server/node_modules` was committed by `git add -A` from a
// worktree, reached main, and stayed through two production deploys. It
// survived .gitignore because the rule read `node_modules/` -- with a trailing
// slash, which matches a directory, and a symlink is not a directory to git.
//
// It was harmless only by accident of ordering: build-release.sh runs
// `npm ci --omit=dev` after `git archive`, so the real install overwrote it
// before anything could follow it. Reverse those two steps and production loads
// its dependencies from whatever that path happens to contain on the build
// host -- a developer's working tree, mutable at any time, in a release
// directory whose entire purpose is to be immutable.
//
// The .gitignore rule is fixed. This is the guard that notices the next one,
// whatever it is named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every tracked path, with its git file mode. 120000 is a symbolic link. */
function trackedEntries() {
    return execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [meta, file] = line.split('\t');
            return { mode: meta.split(' ')[0], file };
        });
}

test('no tracked symlink escapes the repository', () => {
    const escaping = [];
    for (const { mode, file } of trackedEntries()) {
        if (mode !== '120000') continue;
        const target = execFileSync('git', ['show', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' }).trim();
        const resolved = path.resolve(path.dirname(path.join(ROOT, file)), target);
        if (path.isAbsolute(target) || !resolved.startsWith(ROOT + path.sep)) {
            escaping.push(`${file} -> ${target}`);
        }
    }
    assert.deepEqual(escaping, [],
        `a release built from this tree would carry a path off the build host:\n${escaping.join('\n')}`);
});

test('no npm dependency tree is tracked', () => {
    // Scoped to node_modules on purpose. WebAdmin/asset/vendor/ holds Leaflet
    // and is checked in deliberately -- the panel serves those files directly
    // and has no build step for them. Widening this to `vendor` would fail an
    // intentional decision, which is how a guard earns its way around.
    const vendored = trackedEntries()
        .map((e) => e.file)
        .filter((f) => /(^|\/)node_modules(\/|$)/.test(f));

    assert.deepEqual(vendored, [],
        `npm dependencies belong to npm ci at build time, not to the tree:\n${vendored.join('\n')}`);
});
