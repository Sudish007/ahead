import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

test('index.html: CSP meta, ten tabs, landmarks, relative URLs, no inline style, one hash-listed inline script', () => {
  const html = file('index.html');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
  assert.match(csp, /^default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self' 'sha256-[A-Za-z0-9+/]{43}='; connect-src 'self'; base-uri 'none'; form-action 'none'$/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, 10);
  assert.equal((html.match(/role="tablist"/g) ?? []).length, 1);
  for (const tag of ['<header', '<nav aria-label="Sections">', '<main>', '<footer>']) assert.ok(html.includes(tag), tag);
  assert.ok(html.includes('<script type="module" src="app.js">'));
  assert.ok(html.includes('href="styles.css"'));
  assert.ok(html.includes('href="favicon.svg"'));
  assert.ok(!/ style="/.test(html), 'no inline style attributes');
  assert.ok(!/<style[\s>]/.test(html), 'no style blocks');
  // Exactly one inline script: the theme bootstrap, single-line, placed after the theme-color meta and before the stylesheet, allowed by its CSP hash.
  const inline = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([^]*?)<\/script>/g)];
  assert.equal(inline.length, 1, 'exactly one inline script');
  const body = inline[0][1];
  assert.ok(!body.includes('\n'), 'bootstrap is a single line');
  assert.ok(body.includes("'ahead:theme'") && body.includes('data-theme') && body.includes('prefers-color-scheme: dark'));
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`), 'CSP hash matches the inline script');
  assert.ok(html.includes('<meta name="theme-color" id="theme-color" content="#0f1115">'));
  assert.ok(html.indexOf('id="theme-color"') < inline[0].index && inline[0].index < html.indexOf('href="styles.css"'), 'bootstrap runs after the meta and before the stylesheet');
  assert.match(html, /<button id="theme" class="theme" type="button"[^>]*aria-label="Theme: System"/);
  assert.ok(html.includes('<kbd>t</kbd> theme'));
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
  assert.ok(/'ahead:theme'/.test(js) && /case 't':/.test(js), 'theme is persisted and bound to t');
  for (const wrapper of ["el('div', 'sections')", "el('div', 'rows')", "el('div', 'learn-groups')"]) assert.ok(js.includes(wrapper), wrapper);
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
  assert.ok(/max-width: 2200px/.test(css));
});

test('styles.css: fluid container, grids, both themes defined identically', () => {
  const css = file('styles.css');
  assert.match(css, /html \{[^}]*font-size: clamp\(/);
  assert.match(css, /padding: 0 clamp\(/);
  assert.ok(css.includes('overflow-wrap: anywhere'));
  assert.ok(css.includes('scroll-margin-top'));
  for (const bp of ['@media (min-width: 900px)', '@media (min-width: 1500px)', '@media (min-width: 2100px)']) assert.ok(css.includes(bp), bp);
  assert.ok(css.includes('.sections, .rows { grid-template-columns: repeat(2, minmax(0, 1fr)); }'));
  assert.ok(css.includes('.sections, .rows { grid-template-columns: repeat(3, minmax(0, 1fr)); }'));
  assert.ok(css.includes('.sections, .rows { grid-template-columns: repeat(4, minmax(0, 1fr)); }'));
  assert.ok(css.includes('.sections > .section[data-key="must-know"] { grid-column: span 2; }'));
  for (const token of ['--read-opacity', '--tag-bg', '--tag-fg', '--cursor-bg', '--line-strong', '--visited']) assert.ok(css.includes(`${token}:`), token);
  assert.ok(css.includes('color-scheme: light') && css.includes('color-scheme: dark'));
  const dark = css.match(/^:root \{([^}]*)\}/m)[1];
  const system = css.match(/:root:not\(\[data-theme="dark"\]\) \{([^}]*)\}/)[1].trim();
  const forced = css.match(/^:root\[data-theme="light"\] \{([^}]*)\}/m)[1].trim();
  assert.equal(forced, system, 'forced-light and system-light palettes must be identical');
  const tokens = (block) => [...block.matchAll(/--[a-z-]+(?=:)/g)].map((m) => m[0]).sort();
  assert.deepEqual(tokens(forced), tokens(dark), 'every dark token has a light counterpart');
  assert.ok(tokens(dark).length >= 15);
});
