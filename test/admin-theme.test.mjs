import test from 'node:test';
import assert from 'node:assert/strict';
import { adminStyles } from '../src/admin-styles.mjs';

function colors(selector) {
  const declarations = adminStyles.slice(adminStyles.indexOf(selector) + selector.length).split('}')[0];
  return Object.fromEntries([...declarations.matchAll(/--([a-z-]+):(#(?:[0-9a-f]{6}|[0-9a-f]{3}))(?=;|$)/g)].map(m => [m[1], m[2]]));
}
function luminance(hex) {
  const value = hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex;
  const channels = [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels.reduce((total, c, i) => total + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + 0.05) / (low + 0.05);
}
for (const [name, selector] of [['light', ':root{'], ['dark', ':root[data-theme=dark]{']]) {
  test(`admin ${name} theme text, statuses and control boundaries meet contrast thresholds`, () => {
    const c = colors(selector);
    for (const surface of ['paper', 'bg', 'raised']) for (const text of ['ink', 'muted', 'accent']) {
      assert.ok(contrast(c[text], c[surface]) >= 4.5, `${name} ${text} on ${surface}`);
    }
    for (const state of ['green', 'red', 'amber']) assert.ok(contrast(c[state], c[state + '-bg']) >= 4.5, `${name} ${state} status`);
    assert.ok(contrast(c.control, c.paper) >= 3, `${name} input boundary`);
    assert.ok(contrast(c.focus, c.paper) >= 3, `${name} keyboard focus`);
  });
}
test('system dark fallback uses the same readable colors and placeholders do not reduce contrast', () => {
  assert.deepEqual(colors(':root:not([data-theme]){'), colors(':root[data-theme=dark]{'));
  assert.doesNotMatch(adminStyles, /\[aria-busy=true\]\{[^}]*opacity:/, 'Loading results retain readable text contrast');
  assert.match(adminStyles, /input::placeholder\{color:var\(--muted\);opacity:1\}/);
});
