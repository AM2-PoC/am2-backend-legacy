import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const route = readFileSync(resolve(root, 'laravel/routes/web.php'), 'utf8');
const workflow = readFileSync(resolve(root, '.github/workflows/source-checks.yml'), 'utf8');

test('Laravel health is a literal read-only JSON route', () => {
    assert.match(route, /Route::get\('\/next\/health'/);
    assert.match(route, /response\(\)->json\(\['status'\s*=>\s*'ok'\]\)/);
    assert.doesNotMatch(route, /DB::|Cache::|Session::|Artisan::|migrate/i);
});

test('pinned toolchain executes health before registry audit', () => {
    const health = workflow.indexOf('php tests/contract/laravel-health.test.php');
    const audit = workflow.indexOf('npm --prefix laravel audit --audit-level=high');
    assert.ok(health !== -1 && audit > health,
        'health proof must run after locked install and before the external registry audit');
});