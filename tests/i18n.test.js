'use strict';
/* Every player-facing string exists in all nine locales (node --test).
 * Keys are the US-English source strings (see tests/i18n-keys.js). */
const test = require('node:test');
const assert = require('node:assert/strict');
const DICTS = require('../assets/strings.json');
const LOCALES = Object.keys(DICTS);
const { ALL } = require('./i18n-keys.js');

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 150, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key used in markup and code is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('regional variants inherit', () => {
  assert.equal(DICTS['de-DE'].Settings, 'Einstellungen');
  assert.equal(DICTS['fr-CA'].Score, 'Pointage');
  assert.equal(DICTS['fr-CA'].Hint, 'Indice');
  assert.equal(DICTS['es-ES'].Settings, 'Ajustes');
  assert.equal(DICTS['es-ES'].Hint, 'Pista');
  assert.equal(DICTS['en-US'].Hint, 'Hint');
});
