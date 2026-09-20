// Temporary hosted-only regression proof and generated-file recovery.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractWriteSites } from './contract/lib/write-site-inventory.mjs';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'run only on disposable GitHub-hosted CI');
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
const root = resolve(import.meta.dirname, '..');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const output = join(process.env.RUNNER_TEMP, `admin-recovery-${sha}`);
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'candidate-sha.txt'), `${sha}\n`);

if (process.argv[2] === 'export') {
    const inventoryPath = 'tests/fixtures/webadmin-write-inventory.json';
    const inventory = JSON.parse(readFileSync(join(root, inventoryPath), 'utf8'));
    // Same ordered path/NUL/content/NUL digest as webadmin-write-ownership.test.mjs.
    for (const [dir, extension, prefix] of [['WebAdmin', '.php', 'webadmin'], ['server', '.js', 'relay']]) {
        const files = [];
        const walk = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules') continue;
                const path = join(dir, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (entry.name.endsWith(extension)) files.push(path);
            }
        };
        walk(join(root, dir));
        const hash = createHash('sha256');
        for (const path of files.sort()) {
            hash.update(path.slice(root.length + 1));
            hash.update('\0');
            hash.update(readFileSync(path));
            hash.update('\0');
        }
        inventory.source[`${prefix}_${extension === '.php' ? 'php' : 'js'}_files`] = files.length;
        inventory.source[`${prefix}_tree_sha256`] = hash.digest('hex');
    }
    inventory.source_literal_sites = extractWriteSites(root);
    // Keep backend_sha and every other audit field; never refresh the checked-in
    // fixture here, which would conceal stale inventory from the canonical gate.
    mkdirSync(join(output, 'tests/fixtures'), { recursive: true });
    writeFileSync(join(output, inventoryPath), `${JSON.stringify(inventory, null, 2)}\n`);
    for (const path of ['WebAdmin/asset/css/am2-tailwind.css', 'WebAdmin/asset/js/am2-ui.min.js']) {
        mkdirSync(join(output, path, '..'), { recursive: true });
        copyFileSync(join(root, path), join(output, path));
    }
    console.log(`Exported recovery files for ${sha} to ${output}`);
} else {
    assert.equal(process.argv[2], 'proof');
    const base = resolve(process.argv[3]);
    const baseSha = '00ea910fbf5d3fde6aa0b24f833d064b755ce9f6';
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: base, encoding: 'utf8' }).trim(), baseSha);
    const cases = [
        ['render', 'php', ['tests/contract/admin-panel-render.test.php'], 'Call to undefined function am2_adm_undeletable()'],
        ['delete-id', 'php', ['tests/contract/admin-delete-guards.test.php', 'id'], 'admin_panel.php promote false success/refusal'],
        ['delete-en', 'php', ['tests/contract/admin-delete-guards.test.php', 'en'], 'admin_panel.php promote false success/refusal'],
        ['matching', 'php', ['tests/contract/admin-matching-ids.test.php'], 'matching IDs must match deletion policy across pages'],
        ['selection', 'node', ['--test', '--test-reporter=tap', 'tests/unit/table-disabled-selection.test.mjs'], 'page and matching selection exclude disabled rows in paint, count and bulk payload'],
        ['bulk', 'node', ['--test', '--test-reporter=tap', 'tests/unit/admin-bulk-delete.test.mjs'], 'bulk carries server refusal reasons across reload as text, with accurate totals'],
    ];
    for (const [, , args] of cases) {
        const path = args.find((arg) => arg.startsWith('tests/'));
        copyFileSync(join(root, path), join(base, path));
    }
    let failed = false;
    for (const [label, command, args, reason] of cases) {
        for (const [phase, cwd] of [['base', base], ['candidate', root]]) {
            const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });
            const log = `${result.stdout || ''}${result.stderr || ''}`;
            writeFileSync(join(output, `${phase}-${label}.log`), log);
            console.log(`--- ${phase} ${label} (exit ${result.status})\n${log}`);
            const valid = phase === 'base'
                ? Number.isInteger(result.status) && result.status !== 0 && log.includes(reason)
                    && (command !== 'node' || (log.includes('ERR_ASSERTION') && log.includes(`not ok 1 - ${reason}`)))
                : result.status === 0;
            if (!valid || result.error) {
                console.error(`::error::${phase} ${label}: expected ${phase === 'base' ? 'intended regression failure' : 'success'}`);
                failed = true;
            }
        }
    }
    writeFileSync(join(output, 'proof.json'), `${JSON.stringify({ baseSha, candidateSha: sha, passed: !failed }, null, 2)}\n`);
    assert.equal(failed, false, 'baseline RED / candidate GREEN proof failed; inspect per-case logs');
}
