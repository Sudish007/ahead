// Playwright verification for the fluid layout + selectable theme (see layout-theme-plan.md §5).
// Usage:
//   node .agents/tasks/ahead-build/verify-layout-theme.mjs                       (local; starts scripts/serve.mjs on 8787 if needed)
//   node .agents/tasks/ahead-build/verify-layout-theme.mjs --live --base https://sudish007.github.io/ahead/
// Playwright is imported from the sibling project (PLAYWRIGHT_DIR); it is not a dependency of this repo.
// Writes docs/screenshots/{live-}{tab}-{width}-{theme}.png and layout-theme-evidence{-live}.json next to this file; exits 1 on any failure.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PW_DIR = process.env.PLAYWRIGHT_DIR ?? 'C:/Users/sudiskmr/Downloads/DomainClassification/hoshlab/node_modules';
const { chromium } = await import(pathToFileURL(`${PW_DIR}/playwright/index.mjs`).href);

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const baseIdx = argv.indexOf('--base');
const BASE = baseIdx >= 0 ? argv[baseIdx + 1] : 'http://127.0.0.1:8787/ahead/';
const ORIGIN = new URL(BASE).origin;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const EVIDENCE = path.join(HERE, LIVE ? 'layout-theme-evidence-live.json' : 'layout-theme-evidence.json');
const PREFIX = LIVE ? 'live-' : '';

const WIDTHS = LIVE ? [390, 2560] : [360, 390, 1024, 1440, 1920, 2560, 3840];
const SHOT_WIDTHS = LIVE ? [390, 2560] : [390, 1024, 1440, 1920, 2560];
const TABS = LIVE ? ['brief', 'research'] : ['brief', 'research', 'archive', 'learn', 'leaderboards'];
const SHOT_TABS = ['brief', 'research', 'archive', 'learn'];
const THEMES = ['light', 'dark'];
const READY = { brief: '.sections .entry', research: '.rows .row', archive: '.archive-list li', learn: '.learn-list input', leaderboards: '.cards .card' };
const expectedColumns = (w) => (w >= 2100 ? 4 : w >= 1500 ? 3 : w >= 900 ? 2 : 1);
const DARK_BG = 'rgb(15, 17, 21)';
const LIGHT_BG = 'rgb(250, 250, 250)';
const heightFor = (w) => (w <= 640 ? 844 : 1200);

const failures = [];
const check = (ok, msg) => { if (!ok) { failures.push(msg); console.log(`  FAIL ${msg}`); } return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// server + collectors

async function probe() { try { const r = await fetch(BASE, { signal: AbortSignal.timeout(4000) }); return r.ok; } catch { return false; } }
async function ensureServer() {
  if (await probe()) return null;
  if (LIVE) throw new Error(`cannot reach ${BASE}`);
  const child = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '8787' }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(100); if (await probe()) return child; }
  child.kill();
  throw new Error('scripts/serve.mjs did not answer on 8787');
}

const net = { errors: [], pageErrors: [], failedRequests: [], badResponses: [] };
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') net.errors.push(`${page.url()} :: ${m.text()}`); });
  page.on('pageerror', (e) => net.pageErrors.push(`${page.url()} :: ${e.message}`));
  page.on('requestfailed', (r) => net.failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) net.badResponses.push(`${r.status()} ${r.url()}`); });
}

// Seeds the theme (when given) and records data-theme at the moment <body> appears: proof the attribute is set before anything could paint.
function initScript(theme) {
  // Also runs inside the noopener popups (about:blank / stubbed third-party pages), where storage access is denied; ignore that.
  if (theme) { try { localStorage.setItem('ahead:theme', JSON.stringify(theme)); } catch { /* popup without storage */ } }
  window.__themeAtBody = undefined;
  const obs = new MutationObserver(() => {
    if (document.body) { window.__themeAtBody = document.documentElement.getAttribute('data-theme'); obs.disconnect(); }
  });
  obs.observe(document, { childList: true, subtree: true });
}
async function newContext(browser, { theme = null, colorScheme = 'dark' } = {}) {
  const ctx = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 1200 } });
  ctx.on('page', watch);
  // Popups opened by `o` point at third-party sites: answer them with a stub so the test stays offline and deterministic. The page's own CSP stays active.
  await ctx.route((url) => url.origin !== ORIGIN, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }));
  await ctx.addInitScript(initScript, theme);
  return ctx;
}
async function open(page, tab) {
  await page.goto(`${BASE}#${tab}`);
  await page.waitForSelector(READY[tab], { timeout: 45000 });
}

// ---------------------------------------------------------------------------
// layout pass: every width x theme x tab

function measureInPage(tab) {
  const cs = (el) => getComputedStyle(el);
  const columns = {};
  const tracks = {};
  for (const sel of ['.sections', '.rows', '.cards', '.learn-groups', '.archive-list']) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const list = cs(el).gridTemplateColumns.trim().split(/\s+/);
    tracks[sel] = list.map((t) => Math.round(parseFloat(t))).join(' ');
    columns[sel] = list.filter((t) => parseFloat(t) > 0).length; // auto-fit collapses unused tracks to 0px
  }
  const tl = document.getElementById('tablist');
  const out = {
    scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
    rootFontSize: cs(document.documentElement).fontSize, bodyWidth: document.body.clientWidth, columns, tracks,
    tablist: { scrollWidth: tl.scrollWidth, clientWidth: tl.clientWidth },
  };
  if (tab === 'brief') {
    const p = document.querySelector('.overview p');
    if (p) {
      const s = cs(p); const colW = parseFloat(s.columnWidth); const gap = parseFloat(s.columnGap); const w = p.clientWidth;
      const n = Math.max(1, Math.min(3, Math.floor((w + gap) / (colW + gap))));
      out.overview = { widthPx: w, colWidthPx: colW, gapPx: gap, columns: n, lineCh: Math.round((((w - (n - 1) * gap) / n) / (colW / 42)) * 10) / 10 };
    }
    const mk = document.querySelector('.sections > .section[data-key="must-know"]');
    const rs = document.querySelector('.sections > .section[data-key="research"]');
    if (mk && rs) out.sectionWidths = { mustKnow: mk.getBoundingClientRect().width, research: rs.getBoundingClientRect().width };
    out.sectionCount = document.querySelectorAll('.sections > .section').length;
    out.entryCount = document.querySelectorAll('.sections .entry').length;
  }
  if (tab === 'research') {
    out.rowCount = document.querySelectorAll('.rows .row').length;
    out.chipCount = document.querySelectorAll('#chips .chip').length;
    out.filtersPosition = cs(document.getElementById('filters')).position;
  }
  if (tab === 'learn') out.groupCount = document.querySelectorAll('.learn-groups > .learn-group').length;
  if (tab === 'archive') out.dayCount = document.querySelectorAll('.archive-list li').length;
  if (tab === 'leaderboards') out.cardCount = document.querySelectorAll('.cards > .card').length;
  return out;
}

async function layoutPass(browser) {
  const widths = {};
  for (const theme of THEMES) {
    const ctx = await newContext(browser, { theme });
    for (const W of WIDTHS) {
      const page = await ctx.newPage();
      await page.setViewportSize({ width: W, height: heightFor(W) });
      const rec = (widths[W] ??= {});
      const trec = (rec[theme] = { tabs: {} });
      for (const tab of TABS) {
        await open(page, tab);
        if (tab === 'brief') {
          trec.themeAtBody = await page.evaluate(() => window.__themeAtBody);
          check(trec.themeAtBody === theme, `${W} ${theme}: data-theme at <body> creation was ${trec.themeAtBody}`);
        }
        const m = await page.evaluate(measureInPage, tab);
        trec.tabs[tab] = m;
        const tag = `${W} ${theme} ${tab}`;
        check(m.scrollWidth <= m.innerWidth, `${tag}: horizontal overflow scrollWidth ${m.scrollWidth} > innerWidth ${m.innerWidth}`);
        if (tab === 'brief') {
          check(m.columns['.sections'] === expectedColumns(W), `${tag}: .sections has ${m.columns['.sections']} columns, expected ${expectedColumns(W)}`);
          check(m.sectionCount === 6 && m.entryCount >= 6, `${tag}: ${m.sectionCount} sections / ${m.entryCount} entries`);
          if (m.sectionWidths) {
            const { mustKnow, research } = m.sectionWidths;
            if (W >= 1500) check(mustKnow > 1.8 * research, `${tag}: must-know ${mustKnow} should span two columns (research ${research})`);
            else check(Math.abs(mustKnow - research) < 1.5, `${tag}: must-know ${mustKnow} should equal research ${research}`);
          }
          if (m.overview) check(m.overview.lineCh <= 80, `${tag}: overview lines are ${m.overview.lineCh}ch`);
        }
        if (tab === 'research') {
          check(m.columns['.rows'] === expectedColumns(W), `${tag}: .rows has ${m.columns['.rows']} columns, expected ${expectedColumns(W)}`);
          check(m.rowCount > 0 && m.chipCount > 0, `${tag}: ${m.rowCount} rows / ${m.chipCount} chips`);
          check(m.filtersPosition === (W >= 900 ? 'sticky' : 'relative') || (W < 900 && m.filtersPosition === 'static'), `${tag}: filters position ${m.filtersPosition}`);
        }
        if (W >= 1024) check(m.tablist.scrollWidth <= m.tablist.clientWidth + 1, `${tag}: tablist scrolls (${m.tablist.scrollWidth} > ${m.tablist.clientWidth})`);
        if (SHOT_WIDTHS.includes(W) && SHOT_TABS.includes(tab)) {
          const file = path.join(SHOTS, `${PREFIX}${tab}-${W}-${theme}.png`);
          await page.screenshot({ path: file, fullPage: tab === 'brief' });
          m.screenshot = path.relative(ROOT, file).split(path.sep).join('/');
        }
      }
      await page.close();
    }
    await ctx.close();
  }
  return widths;
}

// ---------------------------------------------------------------------------
// theme toggle: button cycle, t shortcut, persistence, OS fallback

async function themePass(browser) {
  const out = { steps: [] };
  const state = (page) => page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    canvasBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    meta: document.getElementById('theme-color').content,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    label: document.getElementById('theme').getAttribute('aria-label'),
    mode: document.getElementById('theme').dataset.mode,
    stored: localStorage.getItem('ahead:theme'),
    atBody: window.__themeAtBody,
  }));
  const ctx = await newContext(browser, { theme: null, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await open(page, 'brief');
  let s = await state(page); out.steps.push({ step: 'load (OS dark, nothing stored)', ...s });
  check(s.attr === null && s.canvasBg === DARK_BG && s.label === 'Theme: System' && s.mode === 'system' && s.stored === null && s.meta === '#0f1115' && s.scheme === 'dark', `theme: initial state ${JSON.stringify(s)}`);
  await page.click('#theme'); s = await state(page); out.steps.push({ step: 'click -> Light', ...s });
  check(s.attr === 'light' && s.canvasBg === LIGHT_BG && s.meta === '#fafafa' && s.scheme === 'light' && s.label === 'Theme: Light' && s.stored === '"light"' && s.bodyColor === 'rgb(17, 17, 17)', `theme: after 1st click ${JSON.stringify(s)}`);
  await page.click('#theme'); s = await state(page); out.steps.push({ step: 'click -> Dark', ...s });
  check(s.attr === 'dark' && s.canvasBg === DARK_BG && s.meta === '#0f1115' && s.scheme === 'dark' && s.label === 'Theme: Dark' && s.stored === '"dark"' && s.bodyColor === 'rgb(231, 233, 238)', `theme: after 2nd click ${JSON.stringify(s)}`);
  await page.click('#theme'); s = await state(page); out.steps.push({ step: 'click -> System', ...s });
  check(s.attr === null && s.canvasBg === DARK_BG && s.label === 'Theme: System' && s.stored === '"system"', `theme: after 3rd click ${JSON.stringify(s)}`);
  await page.keyboard.press('t'); s = await state(page); out.steps.push({ step: 't -> Light', ...s });
  check(s.attr === 'light' && s.canvasBg === LIGHT_BG && s.stored === '"light"', `theme: after t ${JSON.stringify(s)}`);
  await page.reload(); await page.waitForSelector(READY.brief);
  s = await state(page); out.steps.push({ step: 'reload (light persisted)', ...s });
  check(s.attr === 'light' && s.atBody === 'light' && s.canvasBg === LIGHT_BG && s.label === 'Theme: Light', `theme: light did not persist across reload ${JSON.stringify(s)}`);
  await page.keyboard.press('t'); await page.reload(); await page.waitForSelector(READY.brief);
  s = await state(page); out.steps.push({ step: 't -> Dark, reload', ...s });
  check(s.attr === 'dark' && s.atBody === 'dark' && s.canvasBg === DARK_BG, `theme: dark did not persist across reload ${JSON.stringify(s)}`);
  // typing in the search field must not toggle the theme
  await page.goto(`${BASE}#research`); await page.waitForSelector(READY.research);
  await page.focus('#search'); await page.keyboard.type('t'); const typed = await state(page);
  check(typed.attr === 'dark' && (await page.inputValue('#search')) === 't', 'theme: t inside the search field toggled the theme');
  await page.keyboard.press('Escape');
  await ctx.close();
  // OS light, nothing stored -> light via the media query; OS light + stored dark -> forced dark
  const ctxL = await newContext(browser, { theme: null, colorScheme: 'light' });
  const pL = await ctxL.newPage(); await open(pL, 'brief');
  s = await state(pL); out.steps.push({ step: 'OS light, nothing stored', ...s });
  check(s.attr === null && s.canvasBg === LIGHT_BG && s.meta === '#fafafa' && s.scheme === 'light', `theme: OS light fallback ${JSON.stringify(s)}`);
  await ctxL.close();
  const ctxLD = await newContext(browser, { theme: 'dark', colorScheme: 'light' });
  const pLD = await ctxLD.newPage(); await open(pLD, 'brief');
  s = await state(pLD); out.steps.push({ step: 'OS light, stored dark', ...s });
  check(s.attr === 'dark' && s.canvasBg === DARK_BG && s.meta === '#0f1115' && s.scheme === 'dark' && s.atBody === 'dark', `theme: forced dark on a light OS ${JSON.stringify(s)}`);
  await ctxLD.close();
  return out;
}

// ---------------------------------------------------------------------------
// keyboard: j/k/o/r/s// in the grids, cursor visibility, sticky bars

const cursorState = () => {
  const list = [...document.querySelectorAll('.row, .entry')];
  const index = list.findIndex((r) => r.getAttribute('aria-current') === 'true');
  const cur = list[index];
  const rect = cur ? cur.getBoundingClientRect() : null;
  const cs = cur ? getComputedStyle(cur) : null;
  const filters = document.getElementById('filters');
  return {
    index, count: list.length, url: cur?.dataset.url ?? null, id: cur?.dataset.id ?? null,
    left: rect?.left, top: rect?.top, bottom: rect?.bottom, innerHeight: window.innerHeight,
    firstLeft: list[0]?.getBoundingClientRect().left,
    outlineColor: cs?.outlineColor, outlineWidth: cs?.outlineWidth, outlineStyle: cs?.outlineStyle,
    accent: getComputedStyle(document.querySelector('footer a')).color,
    filtersBottom: filters.hidden ? 0 : filters.getBoundingClientRect().bottom,
    isRead: cur?.classList.contains('is-read') ?? null, isSaved: cur?.classList.contains('is-saved') ?? null,
  };
};
async function pressOpen(ctx, page) {
  const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 15000 }), page.keyboard.press('o')]);
  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  const url = popup.url();
  await popup.close();
  return url;
}

async function keyboardPass(browser) {
  const out = {};
  const ctx = await newContext(browser, { theme: 'dark' });
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 2560, height: 1200 });
  await open(page, 'brief');
  let s = await page.evaluate(cursorState);
  check(s.index === 0 && s.count >= 6, `keyboard brief: initial cursor ${s.index} of ${s.count}`);
  await page.keyboard.press('j'); s = await page.evaluate(cursorState); check(s.index === 1, `keyboard brief: j -> ${s.index}`);
  await page.keyboard.press('k'); s = await page.evaluate(cursorState); check(s.index === 0, `keyboard brief: k -> ${s.index}`);
  for (let i = 0; i < 4; i++) await page.keyboard.press('j');
  s = await page.evaluate(cursorState);
  check(s.index === 4, `keyboard brief: j x4 -> ${s.index}`);
  check(s.left > s.firstLeft + 100, `keyboard brief: entry 4 should sit in the next column (left ${s.left} vs ${s.firstLeft})`);
  check(s.top >= 0 && s.bottom <= s.innerHeight, `keyboard brief: current entry off-screen (${s.top}..${s.bottom} of ${s.innerHeight})`);
  check(s.outlineStyle === 'solid' && s.outlineWidth === '2px' && s.outlineColor === s.accent, `keyboard brief: cursor outline ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor} (accent ${s.accent})`);
  const briefUrl = s.url;
  const openedBrief = await pressOpen(ctx, page);
  check(openedBrief === briefUrl, `keyboard brief: o opened ${openedBrief}, expected ${briefUrl}`);
  out.brief = { afterJx4: s, opened: openedBrief };

  await open(page, 'research');
  await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('k');
  s = await page.evaluate(cursorState);
  check(s.index === 1, `keyboard research: j j k -> ${s.index}`);
  const rowUrl = s.url;
  const openedRow = await pressOpen(ctx, page);
  check(openedRow === rowUrl, `keyboard research: o opened ${openedRow}, expected ${rowUrl}`);
  await page.keyboard.press('r'); s = await page.evaluate(cursorState); check(s.isRead === true, 'keyboard research: r did not mark the row read');
  await page.keyboard.press('s'); s = await page.evaluate(cursorState); check(s.isSaved === true, 'keyboard research: s did not save the row');
  const stored = await page.evaluate((id) => ({ read: Boolean(JSON.parse(localStorage.getItem('ahead:read'))[id]), saved: Boolean(JSON.parse(localStorage.getItem('ahead:saved'))[id]) }), s.id);
  check(stored.read && stored.saved, `keyboard research: read/saved not persisted ${JSON.stringify(stored)}`);
  await page.keyboard.press('r'); await page.keyboard.press('s');
  s = await page.evaluate(cursorState); check(s.isRead === false && s.isSaved === false, 'keyboard research: r/s did not toggle back');
  await page.keyboard.press('/');
  check((await page.evaluate(() => document.activeElement?.id)) === 'search', 'keyboard research: / did not focus the search field');
  await page.keyboard.press('Escape');
  check((await page.evaluate(() => document.activeElement?.id)) !== 'search', 'keyboard research: Escape did not blur the search field');
  await page.keyboard.press('2'); await page.waitForSelector(READY.research);
  await page.keyboard.press('1'); await page.waitForSelector(READY.brief);
  check((await page.evaluate(() => location.hash)) === '#brief', 'keyboard: digit shortcuts did not switch tabs');
  out.research = { afterJJK: s, opened: openedRow, stored };

  // sticky bars at 1440: after scrolling, the filter row sits right under the nav, and k never parks the current row under them
  await page.setViewportSize({ width: 1440, height: 1200 });
  await open(page, 'research');
  await page.evaluate(() => window.scrollTo(0, 2000));
  await sleep(100);
  const sticky = await page.evaluate(() => {
    const nav = document.querySelector('nav').getBoundingClientRect();
    const f = document.getElementById('filters').getBoundingClientRect();
    const root = getComputedStyle(document.documentElement);
    return { navTop: nav.top, navBottom: nav.bottom, filtersTop: f.top, filtersBottom: f.bottom, navH: root.getPropertyValue('--nav-h').trim(), stickyH: root.getPropertyValue('--sticky-h').trim(), scrollY: window.scrollY };
  });
  check(sticky.scrollY > 1000 && Math.abs(sticky.navTop) < 1 && Math.abs(sticky.filtersTop - sticky.navBottom) < 1.5, `sticky: nav ${sticky.navTop}..${sticky.navBottom}, filters top ${sticky.filtersTop}`);
  check(parseFloat(sticky.stickyH) > parseFloat(sticky.navH) && parseFloat(sticky.navH) > 0, `sticky: --nav-h ${sticky.navH}, --sticky-h ${sticky.stickyH}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  for (let i = 0; i < 24; i++) await page.keyboard.press('j');
  let minGap = Infinity;
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('k');
    s = await page.evaluate(cursorState);
    minGap = Math.min(minGap, s.top - s.filtersBottom);
  }
  check(s.index === 0 && minGap >= -1, `sticky: a row was parked under the sticky bars (min gap ${minGap}px)`);
  out.sticky = { ...sticky, minGapAboveFiltersPx: round(minGap) };
  await ctx.close();
  return out;
}

// ---------------------------------------------------------------------------
// contrast from computed colours

function contrastInPage(tab) {
  const cs = (el) => getComputedStyle(el);
  const parse = (c) => {
    if (!c) return null;
    let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const l1 = lum(a); const l2 = lum(b); return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100; };
  const blend = (c, over, a) => ({ r: c.r * a + over.r * (1 - a), g: c.g * a + over.g * (1 - a), b: c.b * a + over.b * (1 - a), a: 1 });
  const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const bgOf = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) { const c = parse(cs(n).backgroundColor); if (c && c.a > 0) return c; }
    return parse(cs(document.documentElement).backgroundColor);
  };
  const pageBg = parse(cs(document.documentElement).backgroundColor);
  const token = (name) => parse(cs(document.documentElement).getPropertyValue(name));
  const pairs = [];
  const add = (name, fg, bg, min) => { if (fg && bg) pairs.push({ name, fg: hex(fg), bg: hex(bg), ratio: ratio(fg, bg), min, pass: ratio(fg, bg) >= min }); };
  const q = (sel) => document.querySelector(sel);
  if (tab === 'brief') {
    add('body text on page background', parse(cs(document.body).color), pageBg, 4.5);
    add('muted text on page background', parse(cs(q('#digest-date')).color), pageBg, 4.5);
    add('link (accent) on page background', parse(cs(q('footer a')).color), pageBg, 4.5);
    add('kbd text on page background', parse(cs(q('footer kbd')).color), pageBg, 4.5);
    const entry = q('.sections .entry:not([aria-current="true"])');
    const title = entry.querySelector('.title'); add('entry title on section card', parse(cs(title).color), bgOf(title), 4.5);
    const meta = entry.querySelector('.meta'); add('entry meta (muted) on section card', parse(cs(meta).color), bgOf(meta), 4.5);
    const summary = entry.querySelector('.summary'); add('entry summary (muted) on section card', parse(cs(summary).color), bgOf(summary), 4.5);
    const why = entry.querySelector('.why'); add('why-line on section card', parse(cs(why).color), bgOf(why), 4.5);
    const link = q('.sections .entry .discussion:not([hidden])') ?? q('footer a'); add('accent link on section card', parse(cs(link).color), bgOf(entry), 4.5);
    const tag = q('.overview .tag'); add('AI-WRITTEN badge text on badge background', parse(cs(tag).color), parse(cs(tag).backgroundColor), 4.5);
    const h2 = q('.section h2'); add('section heading on section card', parse(cs(h2).color), bgOf(h2), 4.5);
    const cur = q('[aria-current="true"]'); add('cursor outline on cursor background (3:1)', parse(cs(cur).outlineColor), parse(cs(cur).backgroundColor), 3);
    add('cursor title on cursor background', parse(cs(cur.querySelector('.title')).color), parse(cs(cur).backgroundColor), 4.5);
    add('cursor meta (muted) on cursor background', parse(cs(cur.querySelector('.meta')).color), parse(cs(cur).backgroundColor), 4.5);
    const health = q('#health'); add('health dot on its button (3:1)', parse(cs(health.querySelector('.dot')).backgroundColor), parse(cs(health).backgroundColor), 3);
    const theme = q('#theme'); add('theme button glyph on its button', parse(cs(theme).color), parse(cs(theme).backgroundColor), 4.5);
    add('control border (--line-strong) on page background (3:1)', parse(cs(theme).borderTopColor), pageBg, 3);
    const tab1 = q('.tablist [aria-selected="true"]'); add('selected tab text on chip background', parse(cs(tab1).color), parse(cs(tab1).backgroundColor), 4.5);
    add('selected tab border on page background (3:1)', parse(cs(tab1).borderTopColor), pageBg, 3);
    add('visited title (--visited) on section card', token('--visited'), token('--panel'), 4.5);
    add('alert text (--bad) on page background', token('--bad'), pageBg, 4.5);
    add('amber health dot (--warn) on chip background (3:1)', token('--warn'), token('--chip'), 3);
    add('red health dot (--bad) on chip background (3:1)', token('--bad'), token('--chip'), 3);
    add('green health dot (--ok) on chip background (3:1)', token('--ok'), token('--chip'), 3);
    add('card border (--line) on page background (decorative)', token('--line'), pageBg, 1);
  }
  if (tab === 'research') {
    const row = q('.rows .row:not([aria-current="true"]):not(.is-read):not(.is-saved)');
    add('row title on row card', parse(cs(row.querySelector('.title')).color), bgOf(row.querySelector('.title')), 4.5);
    add('row meta (muted) on row card', parse(cs(row.querySelector('.meta')).color), bgOf(row.querySelector('.meta')), 4.5);
    add('row summary (muted) on row card', parse(cs(row.querySelector('.summary')).color), bgOf(row.querySelector('.summary')), 4.5);
    const score = row.querySelector('.score'); add('score pill text on pill background', parse(cs(score).color), parse(cs(score).backgroundColor), 4.5);
    const inlineChip = row.querySelector('.chips-inline a, .chips-inline span'); if (inlineChip) add('inline source chip text on chip background', parse(cs(inlineChip).color), parse(cs(inlineChip).backgroundColor), 4.5);
    const icon = row.querySelector('.icon'); add('row action icon on its button', parse(cs(icon).color), parse(cs(icon).backgroundColor), 4.5);
    const pressed = q('.chip[aria-pressed="true"]'); add('pressed chip text on accent fill', parse(cs(pressed).color), parse(cs(pressed).backgroundColor), 4.5);
    const chip = q('#chips .chip[aria-pressed="false"]'); add('source chip text on chip background', parse(cs(chip).color), parse(cs(chip).backgroundColor), 4.5);
    const search = q('#search'); add('search field border on page background (3:1)', parse(cs(search).borderTopColor), pageBg, 3);
    add('search text on search field', parse(cs(search).color), parse(cs(search).backgroundColor), 4.5);
    const read = q('.rows .row.is-read');
    if (read) {
      const a = parseFloat(cs(read).opacity);
      const cardBg = blend(parse(cs(read).backgroundColor), pageBg, a);
      add(`read-dimmed title (opacity ${a}) on dimmed row card`, blend(parse(cs(read.querySelector('.title')).color), pageBg, a), cardBg, 4.5);
      add(`read-dimmed meta (opacity ${a}) on dimmed row card (3:1, de-emphasised)`, blend(parse(cs(read.querySelector('.meta')).color), pageBg, a), cardBg, 3);
      add(`read-dimmed check icon (opacity ${a}) on dimmed button (3:1)`, blend(parse(cs(read.querySelector('.read')).color), pageBg, a), blend(parse(cs(read.querySelector('.read')).backgroundColor), pageBg, a), 3);
    }
    const saved = q('.rows .row.is-saved .save'); if (saved) add('saved star (--why) on its button', parse(cs(saved).color), parse(cs(saved).backgroundColor), 4.5);
  }
  return pairs;
}

async function contrastPass(browser, theme) {
  const ctx = await newContext(browser, { theme });
  const page = await ctx.newPage();
  await open(page, 'brief');
  const tokens = await page.evaluate(() => Object.fromEntries(['--bg', '--panel', '--chip', '--line', '--line-strong', '--fg', '--muted', '--accent', '--visited', '--why', '--cursor-bg', '--read-opacity', '--tag-bg', '--tag-fg', '--ok', '--warn', '--bad'].map((t) => [t, getComputedStyle(document.documentElement).getPropertyValue(t).trim()])));
  const pairs = await page.evaluate(contrastInPage, 'brief');
  await open(page, 'research');
  // mark row 1 read + saved, move the cursor back to row 0 so the dimmed row is measured without the cursor background, let the 0.15s opacity transition finish
  await page.keyboard.press('j'); await page.keyboard.press('r'); // row 1 read
  await page.keyboard.press('j'); await page.keyboard.press('s'); // row 2 saved
  await page.keyboard.press('k'); await page.keyboard.press('k'); // cursor back on row 0
  await sleep(400);
  pairs.push(...await page.evaluate(contrastInPage, 'research'));
  const dimmed = await page.evaluate(() => getComputedStyle(document.querySelector('.rows .row.is-read')).opacity);
  check(parseFloat(dimmed) < 1 && dimmed === tokens['--read-opacity'], `contrast ${theme}: read row opacity ${dimmed}, token ${tokens['--read-opacity']}`);
  await page.keyboard.press('j'); await page.keyboard.press('r'); await page.keyboard.press('j'); await page.keyboard.press('s');
  for (const p of pairs) check(p.pass, `contrast ${theme}: ${p.name} ${p.fg} on ${p.bg} = ${p.ratio} < ${p.min}`);
  check(pairs.some((p) => p.name.startsWith('read-dimmed title')) && pairs.some((p) => p.name.startsWith('AI-WRITTEN')) && pairs.some((p) => p.name.startsWith('pressed chip')), `contrast ${theme}: a required pair was not measured`);
  await ctx.close();
  return { tokens, pairs };
}

// ---------------------------------------------------------------------------

const server = await ensureServer();
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch();
const evidence = { base: BASE, mode: LIVE ? 'live' : 'local', generatedAt: new Date().toISOString(), chromium: browser.version(), widths: null, theme: null, keyboard: null, contrast: {}, console: net, failures };
try {
  console.log(`layout pass (${WIDTHS.join(', ')}) x (${THEMES.join(', ')}) x (${TABS.join(', ')})`);
  evidence.widths = await layoutPass(browser);
  console.log('theme pass');
  evidence.theme = await themePass(browser);
  console.log('keyboard pass');
  evidence.keyboard = await keyboardPass(browser);
  for (const theme of THEMES) { console.log(`contrast pass (${theme})`); evidence.contrast[theme] = await contrastPass(browser, theme); }
} catch (err) {
  failures.push(`exception: ${err.stack ?? err}`);
  console.log(`  FAIL exception ${err.stack ?? err}`);
} finally {
  await browser.close();
  if (server) server.kill();
}
check(net.errors.length === 0, `console errors: ${JSON.stringify(net.errors)}`);
check(net.pageErrors.length === 0, `page errors: ${JSON.stringify(net.pageErrors)}`);
check(net.failedRequests.length === 0, `failed requests: ${JSON.stringify(net.failedRequests)}`);
check(net.badResponses.length === 0, `responses >= 400: ${JSON.stringify(net.badResponses)}`);
writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

// summary
console.log('\ncolumns per width (root font / body width):');
for (const [w, rec] of Object.entries(evidence.widths ?? {})) {
  const t = rec.dark?.tabs ?? rec.light?.tabs ?? {};
  const cols = Object.assign({}, ...Object.values(t).map((m) => m.columns));
  console.log(`  ${w.padStart(4)} ${t.brief?.rootFontSize ?? '?'} / ${t.brief?.bodyWidth ?? '?'}px  ${JSON.stringify(cols)}  overview ${t.brief?.overview?.columns ?? '-'} col ${t.brief?.overview?.lineCh ?? '-'}ch  scrollWidth<=innerWidth ${Object.values(t).every((m) => m.scrollWidth <= m.innerWidth)}`);
}
for (const theme of THEMES) {
  console.log(`\ncontrast ${theme}:`);
  for (const p of evidence.contrast[theme]?.pairs ?? []) console.log(`  ${p.pass ? 'ok  ' : 'FAIL'} ${p.ratio.toFixed(2).padStart(6)} (>= ${p.min}) ${p.name}: ${p.fg} on ${p.bg}`);
}
console.log(`\nconsole errors ${net.errors.length}, page errors ${net.pageErrors.length}, failed requests ${net.failedRequests.length}, responses >= 400 ${net.badResponses.length}`);
console.log(`${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`} -> ${path.relative(ROOT, EVIDENCE)}`);
process.exit(failures.length === 0 ? 0 : 1);
