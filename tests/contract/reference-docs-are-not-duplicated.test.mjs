// A reference that says the same thing twice will eventually say it differently.
//
// backend-contract.md carried sections 1.3 through 1.8 twice -- 125 lines, five
// of them byte-identical and the sixth already drifted, because an earlier edit
// corrected one copy and left the other describing a hardcoded "1.0.0" fallback
// that had been removed long before.
//
// Nobody reads 1000 lines top to bottom. They search, land on whichever copy
// comes first, and trust it. A duplicate heading is not untidiness; it is two
// answers to one question with no way to tell which is current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');

function markdownFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...markdownFiles(p));
        else if (entry.name.endsWith('.md')) out.push(p);
    }
    return out;
}

test('no reference document repeats a heading', () => {
    const offenders = [];
    for (const file of markdownFiles(DOCS)) {
        const seen = new Map();
        const src = fs.readFileSync(file, 'utf8');
        let inFence = false;
        src.split('\n').forEach((line, i) => {
            // A "### something" inside a fenced block is sample output, not a
            // heading, and counting it would make the guard fail on its own
            // examples.
            if (/^\s*```/.test(line)) { inFence = !inFence; return; }
            if (inFence) return;
            const heading = /^(#{2,6})\s+(.*\S)\s*$/.exec(line);
            if (!heading) return;
            const key = `${heading[1]} ${heading[2]}`;
            if (seen.has(key)) {
                offenders.push(
                    `${path.relative(DOCS, file)}: "${key}" at lines ${seen.get(key)} and ${i + 1}`,
                );
            } else {
                seen.set(key, i + 1);
            }
        });
    }
    assert.deepEqual(offenders, [],
        `a repeated heading is two answers to one question:\n${offenders.join('\n')}`);
});
