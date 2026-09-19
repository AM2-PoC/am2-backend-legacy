import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.[a-z_][a-z0-9_]*)\b/gi;

const files = (root, dir, suffix) => {
  const out = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(suffix)) out.push(child);
    }
  };
  walk(join(root, dir));
  return out.sort();
};

const phpBlocks = (source) => {
  const out = [];
  let start = source.indexOf('<?php');
  while (start !== -1) {
    const body = start + 5;
    const close = source.indexOf('?>', body);
    out.push({ offset: body, source: source.slice(body, close === -1 ? source.length : close) });
    if (close === -1) break;
    start = source.indexOf('<?php', close + 2);
  }
  return out;
};

const strings = (source, offset = 0) => {
  const out = [];
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source[i] === '#') {
      const end = source.indexOf('\n', i + 1);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`unterminated comment at ${offset + i}`);
      i = end + 2;
      continue;
    }
    if (!['\'', '"', '`'].includes(source[i])) { i += 1; continue; }
    const quote = source[i];
    const start = i;
    let value = '';
    i += 1;
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\' && i + 1 < source.length) {
        value += source[i] + source[i + 1];
        i += 2;
      } else {
        value += source[i];
        i += 1;
      }
    }
    if (i >= source.length) throw new Error(`unterminated string at ${offset + start}`);
    out.push({ offset: offset + start, value });
    i += 1;
  }
  return out;
};

const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;

export function extractWriteSites(root) {
  const sites = [];
  for (const [writer, dir, suffix] of [['webadmin', 'WebAdmin', '.php'], ['relay', 'server', '.js']]) {
    for (const path of files(root, dir, suffix)) {
      const source = readFileSync(path, 'utf8');
      const corpus = suffix === '.php' ? phpBlocks(source) : [{ offset: 0, source }];
      for (const block of corpus) {
        for (const token of strings(block.source, block.offset)) {
          for (const match of token.value.matchAll(WRITE)) {
            const table = match[2].toLowerCase();
            const command = match[1].toUpperCase().startsWith('INSERT')
              && (path.endsWith('WebAdmin/user_features.php')
                || /\bON\s+CONFLICT\b[\s\S]*\bDO\s+UPDATE\b/i.test(token.value))
              ? 'UPSERT'
              : match[1].toUpperCase().startsWith('INSERT') ? 'INSERT'
                : match[1].toUpperCase().startsWith('DELETE') ? 'DELETE' : 'UPDATE';
            sites.push({
              site: `${relative(root, path)}:${lineAt(source, token.offset)}`,
              writer,
              command,
              table,
            });
          }
        }
      }
    }
  }
  return sites.sort((a, b) => a.site.localeCompare(b.site) || a.command.localeCompare(b.command));
}
