'use strict';
/* Key extraction for the i18n coverage test (run directly to list the keys).
 * Keys are the US-English source strings: literal T("…") / N("…") calls and
 * withKey("…") labels in the engine client (native/*.ts), rule refusal
 * reasons, and the content tables' display text. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const unescape = (s) => s.replace(/\\(['"\\])/g, '$1');

function sourceKeys() {
  const keys = new Set();
  const call = /(?<![\w$.])(?:T|N|withKey)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const dir = path.join(ROOT, 'native');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
  }
  // Rule refusal reasons (rules.js illegalReason), translated at display.
  const rules = fs.readFileSync(path.join(ROOT, 'rules.js'), 'utf8');
  const fn = rules.slice(rules.indexOf('function illegalReason'), rules.indexOf('return null;', rules.indexOf('function illegalReason')));
  for (const m of fn.matchAll(/return '([^']+)'/g)) keys.add(m[1]);
  return keys;
}

function contentKeys() {
  const C = require('../content.js');
  const keys = new Set();
  for (const t of C.TUTORIALS) { keys.add(t.title); keys.add(t.text); }
  for (const t of C.THEMES) keys.add(t.name);
  return keys;
}

const ALL = new Set([...sourceKeys(), ...contentKeys()]);
module.exports = { ALL, sourceKeys, contentKeys };
if (require.main === module) for (const k of ALL) console.log(k);
