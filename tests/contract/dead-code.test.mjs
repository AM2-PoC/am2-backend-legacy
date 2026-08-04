// Dead code does not come back.
//
// Three sweeps that each found something real: 32 catalog keys nothing could
// render, four functions nothing called, and four whole pages nothing linked
// to. None of it failed anything — dead code never does. It just sits there
// being read by the next person as though it mattered.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC } from './helpers.mjs';

/** Every file that could reach a key or call a function, excluding the catalog. */
function sources() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (['node_modules', 'vendor', 'lang', 'font', 'image'].includes(entry.name)) continue;
                walk(p);
            } else if (/\.(php|js|mjs)$/.test(entry.name) && !/\.min\.js$/.test(entry.name)) {
                out.push(fs.readFileSync(p, 'utf8'));
            }
        }
    };
    walk(SRC);
    return out.join('\n');
}

describe('nothing in the tree is unreachable', () => {
    test('every catalog key is reachable from somewhere', () => {
        const blob = sources();
        const catalog = fs.readFileSync(`${SRC}/lang/id.php`, 'utf8');
        const keys = [...catalog.matchAll(/^\s*'([a-z][a-z0-9_.]+)'\s*=>/gm)].map((m) => m[1]);
        assert.ok(keys.length > 100, 'the catalog matcher has drifted');

        const dead = keys.filter((k) => {
            // Built at runtime and invisible to a literal search:
            //   'log.' . $code            am2_log_text()
            //   'log.via_' . $params.via  the origin suffix
            //   '@log.f_maps'             handed through event_params
            //   'log.tbl_' || TG_TABLE    the trigger, in SQL
            //   t($why)                   admin_panel.php, three locked reasons
            if (k.startsWith('log.')) return false;
            if (k.startsWith('adm.locked_')) return false;
            return !blob.includes(`'${k}'`) && !blob.includes(`"${k}"`) && !blob.includes(`'@${k}'`);
        });

        assert.deepEqual(dead, [],
            `these keys are translated twice and rendered never:\n  ${dead.join('\n  ')}`);
    });

    test('every function defined is called', () => {
        const blob = sources();
        const defined = new Map();
        for (const entry of fs.readdirSync(SRC, { withFileTypes: true })) {
            if (!entry.isFile() || !entry.name.endsWith('.php')) continue;
            const src = fs.readFileSync(path.join(SRC, entry.name), 'utf8');
            for (const m of src.matchAll(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) {
                defined.set(m[1], entry.name);
            }
        }
        for (const entry of fs.readdirSync(`${SRC}/partials`)) {
            if (!entry.endsWith('.php')) continue;
            const src = fs.readFileSync(`${SRC}/partials/${entry}`, 'utf8');
            for (const m of src.matchAll(/^function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm)) {
                defined.set(m[1], `partials/${entry}`);
            }
        }
        assert.ok(defined.size > 10, 'the function matcher has drifted');

        const uncalled = [];
        for (const [fn, where] of defined) {
            const calls = (blob.match(new RegExp(`\\b${fn}\\s*\\(`, 'g')) ?? []).length;
            if (calls <= 1) uncalled.push(`${fn}() in ${where}`);
        }
        assert.deepEqual(uncalled, [],
            `defined and never called:\n  ${uncalled.join('\n  ')}`);
    });
});
