import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const file = (name) => readFileSync(path.join(ROOT, name), 'utf8');
const size = (name) => statSync(path.join(ROOT, name)).size;

test('file budgets', () => {
  assert.ok(size('index.html') < 10 * 1024, `index.html ${size('index.html')}`);
  assert.ok(size('app.js') < 60 * 1024, `app.js ${size('app.js')}`);
  assert.ok(size('styles.css') < 15 * 1024, `styles.css ${size('styles.css')}`);
  assert.ok(size('favicon.svg') < 2048);
});

test('index.html: CSP meta, ten tabs, landmarks, relative URLs, no inline style/script', () => {
  const html = file('index.html');
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'">/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 10);
  assert.equal((html.match(/role="tablist"/g) ?? []).length, 1);
  for (const tag of ['<header', '<nav aria-label="Sections">', '<main>', '<footer>']) assert.ok(html.includes(tag), tag);
  assert.ok(html.includes('<script type="module" src="app.js">'));
  assert.ok(html.includes('href="styles.css"'));
  assert.ok(html.includes('href="favicon.svg"'));
  assert.ok(!/ style="/.test(html), 'no inline style attributes');
  assert.ok(!/<style[\s>]/.test(html), 'no style blocks');
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline scripts');
  assert.ok(!/(href|src)="\//.test(html), 'no root-absolute asset URLs');
  for (const tab of ['brief', 'research', 'news', 'labs', 'blogs', 'releases', 'media', 'leaderboards', 'learn', 'archive']) assert.ok(html.includes(`data-tab="${tab}"`), tab);
  assert.ok(/role="tabpanel"/.test(html));
  assert.ok(/role="alert"/.test(html));
  assert.ok(/<template id="row-template">/.test(html) && /<template id="entry-template">/.test(html));
});

test('app.js: no innerHTML, no setAttribute(style, no absolute fetch paths, relative data references', () => {
  const js = file('app.js');
  assert.ok(!/innerHTML/.test(js));
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js));
  assert.ok(!/fetch\(\s*['"`]\//.test(js));
  assert.ok(!/['"`]\/data\//.test(js), 'data references must be relative');
  for (const ref of ['data/meta.json', 'data/digests/index.json', 'data/items.json', 'data/digests/']) assert.ok(js.includes(ref), ref);
  assert.ok(/if \(globalThis\.document\) start\(\);/.test(js));
  assert.ok(/'ahead:lastVisit'/.test(js));
  assert.ok(!/pagehide|visibilitychange/.test(js), 'lastVisit is written only when the Brief renders (D5)');
  assert.ok(/window\.open\([^)]*'noopener'\)/.test(js));
  assert.ok(/rel = 'noopener noreferrer'/.test(js));
  assert.ok(/No data yet\. The first refresh runs within six hours; trigger one with /.test(js));
});

test('styles.css: custom properties, light scheme, focus-visible, reduced motion, 640px breakpoint', () => {
  const css = file('styles.css');
  for (const v of ['--bg: #0f1115', '--fg: #e7e9ee', '--muted: #9aa3ad', '--accent: #7ab7ff', '--why: #f0c674']) assert.ok(css.includes(v), v);
  assert.ok(/@media \(prefers-color-scheme: light\)/.test(css));
  for (const v of ['--bg: #fafafa', '--fg: #111', '--muted: #555', '--accent: #0a58ca', '--why: #7a5200']) assert.ok(css.includes(v), v);
  assert.ok(/:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px;? \}/.test(css));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(css));
  assert.ok(/@media \(max-width: 640px\)/.test(css));
  assert.ok(/font-variant-numeric: tabular-nums/.test(css));
  assert.ok(/max-width: 1100px/.test(css));
});
