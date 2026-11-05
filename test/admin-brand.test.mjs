import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStyles } from '../src/admin-styles.mjs';
import { document } from '../src/admin-pages.mjs';

test('brand hover overrides ordinary link underline without removing keyboard focus', () => {
  assert.match(adminStyles, /a:hover\{text-decoration:underline\}/);
  assert.match(adminStyles, /\.brand:hover\{text-decoration:none\}/);
  assert.ok(adminStyles.indexOf('.brand:hover{') > adminStyles.indexOf('a:hover{'));
  assert.match(adminStyles, /a:focus-visible[^}]*\{outline:2px solid var\(--focus\);outline-offset:3px\}/);
});

for (const active of [undefined, 'sessions', 'messages', 'approvals']) {
  test(`brand remains a named navigation link in ${active ?? 'login'} shell`, () => {
    const html = document('', { active, csrf: 'unit-test' });
    assert.match(html, /<a href="\/admin\/sessions" class="brand"><span class="brand-mark" aria-hidden="true">»<\/span><span>Psst<small>Broker administration<\/small><\/span><\/a>/);
    assert.ok(html.includes(`<style>${adminStyles}</style>`));
  });
}
