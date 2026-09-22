import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];

test('the page script compiles, and the tabs match the views the script knows', () => {
  assert.doesNotThrow(() => new vm.Script(script, { filename: 'dashboard/index.html' }));
  const tabs = [...page.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  const views = JSON.parse(/const VIEWS = (\[[^\]]*\]);/.exec(script)[1].replace(/'/g, '"'));
  assert.deepEqual(tabs, views);
  assert.deepEqual(tabs, ['board', 'timeline', 'table', 'projects', 'flow', 'matrix', 'groups']);
  for (const view of views) assert.match(script, new RegExp(`state\\.view === '${view}'|else renderBoard`), `render() handles ${view}`);
});

test('the page loads nothing from the internet', () => {
  assert.doesNotMatch(page, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  assert.match(page, /Content-Security-Policy[^>]*default-src 'self'/);
});
