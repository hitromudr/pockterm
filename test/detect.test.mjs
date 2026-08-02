// Run with: node --test test/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectQuestion } from '../web/js/detect.js';

// The cases are shared with the Go detector (internal/detect), which drives
// the Telegram notifications: one screen, one verdict, in both languages.
const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/menus.json', import.meta.url), 'utf8'),
);

for (const c of fixtures.cases) {
  test(`fixture: ${c.name}`, () => {
    const got = detectQuestion(c.lines);
    if (c.expect === null) {
      assert.equal(got, null);
      return;
    }
    assert.ok(got, 'expected a menu');
    assert.equal(got.prompt, c.expect.prompt);
    assert.deepEqual(
      got.options.map((o) => ({ key: o.key, label: o.label })),
      c.expect.options,
    );
  });
}
