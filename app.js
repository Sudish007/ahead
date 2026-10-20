// Ahead frontend. Pure helpers are exported for Node tests; all DOM work lives in start().
const CATEGORIES = ['research', 'news', 'labs', 'blogs', 'releases', 'media'];
const RANGES = { '24h': 24 * 3.6e6, '3d': 3 * 86.4e6, '7d': 7 * 86.4e6 };
const TABS = ['brief', 'research', 'news', 'labs', 'blogs', 'releases', 'media', 'leaderboards', 'learn', 'archive'];
const KEY_TABS = { 1: 'brief', 2: 'research', 3: 'news', 4: 'labs', 5: 'blogs', 6: 'releases', 7: 'media', 8: 'leaderboards', 9: 'learn', 0: 'archive' };
const CATEGORY_TABS = new Set(CATEGORIES);
const DAY_MS = 86.4e6;
const READ_RETENTION_MS = 30 * DAY_MS;
const PAGE = 100;

// ---------------------------------------------------------------------------
// Pure helpers

const isPlainRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const validId = (k) => typeof k === 'string' && k.length > 0 && k.length <= 200;
const validTs = (v) => Number.isInteger(v) && v >= 0;
const isHttp = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };

export function sanitizeReadMap(v, nowMs = Date.now()) {
  const out = Object.create(null);
  if (!isPlainRecord(v)) return out;
  for (const [k, ts] of Object.entries(v)) if (validId(k) && validTs(ts) && ts >= nowMs - READ_RETENTION_MS) out[k] = ts;
  return out;
}
export function sanitizeLearnMap(v) {
  const out = Object.create(null);
  if (!isPlainRecord(v)) return out;
  for (const [k, ts] of Object.entries(v)) if (validId(k) && validTs(ts)) out[k] = ts;
  return out;
}
export function sanitizeSavedMap(v) {
  const out = Object.create(null);
  if (!isPlainRecord(v)) return out;
  for (const [k, s] of Object.entries(v)) {
    if (!validId(k) || !isPlainRecord(s)) continue;
    const ok = typeof s.title === 'string' && s.title.length >= 1 && s.title.length <= 200
      && typeof s.url === 'string' && s.url.length <= 2048 && isHttp(s.url)
      && Array.isArray(s.sourceNames) && s.sourceNames.length <= 16 && s.sourceNames.every((n) => typeof n === 'string' && n.length >= 1 && n.length <= 100)
      && typeof s.publishedAt === 'string' && s.publishedAt.length <= 40 && Number.isFinite(Date.parse(s.publishedAt))
      && CATEGORIES.includes(s.category) && validTs(s.savedAt);
    if (ok) out[k] = { title: s.title, url: s.url, sourceNames: [...s.sourceNames], publishedAt: s.publishedAt, category: s.category, savedAt: s.savedAt };
  }
  return out;
}
export const sanitizeLastVisit = (v) => (validTs(v) ? v : 0);
export const sanitizeRange = (v) => (v in RANGES ? v : '7d');
export const sanitizeTheme = (v) => (v === 'light' || v === 'dark' ? v : 'system');
/** System -> Light -> Dark -> System. */
export const nextTheme = (t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system');

export function createStore(storage, warn = () => {}) {
  let memory = null;
  let storageWarned = false;
  let corruptWarned = false;
  const useMemory = (err) => {
    if (!storageWarned) { storageWarned = true; warn(`localStorage unavailable (${err && err.message ? err.message : err}); keeping state in memory for this session`); }
    if (!memory) memory = new Map();
  };
  return {
    get(key, sanitize) {
      if (memory) return sanitize(memory.get(key));
      let raw;
      try { raw = storage.getItem(key); } catch (err) { useMemory(err); return sanitize(undefined); }
      if (raw === null || raw === undefined) return sanitize(undefined);
      try { return sanitize(JSON.parse(raw)); } catch {
        if (!corruptWarned) { corruptWarned = true; warn(`stored ${key} was not valid JSON; resetting it`); }
        return sanitize(undefined);
      }
    },
    set(key, value) {
      if (memory) { memory.set(key, value); return; }
      try { storage.setItem(key, JSON.stringify(value)); } catch (err) { useMemory(err); memory.set(key, value); }
    },
    get inMemory() { return memory !== null; },
  };
}

/** D5: days strictly after the UTC date of the previous visit and strictly before `newestDate`; newest first; at most 14. */
export function selectCatchUpDays(indexDays, previousVisitMs, newestDate) {
  const visitDate = previousVisitMs > 0 ? new Date(previousVisitMs).toISOString().slice(0, 10) : '';
  return (indexDays ?? [])
    .filter((d) => d && typeof d.date === 'string' && d.date > visitDate && d.date < newestDate)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 14);
}

export function healthStatus(meta, nowMs = Date.now()) {
  const failed = Number.isInteger(meta?.failedCount) ? meta.failedCount : 0;
  const ageMs = nowMs - Date.parse(meta?.generatedAt);
  const stale = !(Number.isFinite(ageMs) && ageMs < 12 * 3.6e6);
  const state = failed > 5 || stale ? 'red' : failed >= 1 ? 'amber' : 'green';
  const hours = Number.isFinite(ageMs) ? Math.floor(ageMs / 3.6e6) : 0;
  const text = failed > 0 ? `${failed} ${failed === 1 ? 'source' : 'sources'} failed` : stale ? `Data is ${hours} h old` : 'All sources OK';
  return { state, text };
}

/** D6: the registry homepage when present, else the item URL's origin. */
export function sourceChipHref(sourceMeta, itemUrl) {
  if (sourceMeta && typeof sourceMeta.homepage === 'string' && isHttp(sourceMeta.homepage)) return sourceMeta.homepage;
  try {
    const u = new URL(itemUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

export function relativeAge(iso, nowMs = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const m = Math.max(0, Math.round((nowMs - t) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
export function compactNumber(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}m`;
}
export function signalText(signals = {}) {
  const parts = [];
  if (signals.hnPoints !== undefined) parts.push(`▲${compactNumber(signals.hnPoints)}`);
  if (signals.hfUpvotes !== undefined) parts.push(`▲${compactNumber(signals.hfUpvotes)} HF`);
  if (signals.hnComments !== undefined) parts.push(`${compactNumber(signals.hnComments)} comments`);
  if (signals.redditScore !== undefined) parts.push(`${compactNumber(signals.redditScore)}↑`);
  if (signals.ghStars !== undefined) parts.push(`${compactNumber(signals.ghStars)}★`);
  if (signals.hfLikes !== undefined) parts.push(`${compactNumber(signals.hfLikes)} likes`);
  if (signals.ytViews !== undefined) parts.push(`${compactNumber(signals.ytViews)} views`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// DOM application

export function start() {
  const doc = globalThis.document;
  const $ = (id) => doc.getElementById(id);
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const store = createStore(globalThis.localStorage, (m) => console.warn(m));
  const S = {
    meta: null, index: null, digest: null, items: null, itemsPromise: null, itemsError: null,
    tab: 'brief', archiveDate: null, view: 'list', selected: new Set(), savedOnly: false, query: '', cursor: 0, shown: PAGE,
    read: store.get('ahead:read', (v) => sanitizeReadMap(v, Date.now())),
    saved: store.get('ahead:saved', sanitizeSavedMap),
    learn: store.get('ahead:learn', sanitizeLearnMap),
    previousVisit: store.get('ahead:lastVisit', sanitizeLastVisit),
    range: store.get('ahead:range', sanitizeRange),
    theme: store.get('ahead:theme', sanitizeTheme),
    noData: false,
  };
  store.set('ahead:read', S.read); store.set('ahead:saved', S.saved); store.set('ahead:learn', S.learn); store.set('ahead:range', S.range);
  const panel = $('panel');
  const alertBox = $('alert');
  const filters = $('filters');
  const search = $('search');
  const rowTpl = $('row-template');
  const entryTpl = $('entry-template');
  const nav = doc.querySelector('nav');

  // ----- theme: data-theme on <html> (absent = follow the OS), persisted as 'ahead:theme'; the inline head script applies it before first paint.
  const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
  const themeBtn = $('theme');
  const themeMeta = $('theme-color');
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const root = doc.documentElement;
    if (S.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', S.theme);
    themeBtn.dataset.mode = S.theme;
    const label = `Theme: ${THEME_LABELS[S.theme]}`;
    themeBtn.setAttribute('aria-label', label); themeBtn.title = `${label} (t)`;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (themeMeta && bg) themeMeta.content = bg;
  }
  function cycleTheme() { S.theme = nextTheme(S.theme); store.set('ahead:theme', S.theme); applyTheme(); }
  themeBtn.addEventListener('click', cycleTheme);
  darkQuery.addEventListener('change', () => { if (S.theme === 'system') applyTheme(); });
  applyTheme();

  // ----- sticky offsets: the nav (and the filter row on wide screens) cover the top of the viewport; rows scroll into view below them.
  const wide = window.matchMedia('(min-width: 900px)');
  function measureSticky() {
    const navH = nav.offsetHeight;
    const filtersH = !filters.hidden && wide.matches ? filters.offsetHeight : 0;
    doc.documentElement.style.setProperty('--nav-h', `${navH}px`);
    doc.documentElement.style.setProperty('--sticky-h', `${navH + filtersH}px`);
  }
  if ('ResizeObserver' in window) { const ro = new ResizeObserver(measureSticky); ro.observe(nav); ro.observe(filters); }

  const safeUrl = (u) => (typeof u === 'string' && isHttp(u) ? u : null);
  const setLink = (a, textNode, url, label) => {
    const ok = safeUrl(url);
    if (ok) { a.href = ok; a.textContent = label; a.hidden = false; textNode.hidden = true; }
    else { a.hidden = true; textNode.textContent = label; textNode.hidden = false; }
  };
  const showAlert = (msg) => { $('alert-text').textContent = msg; alertBox.hidden = false; };
  const hideAlert = () => { alertBox.hidden = true; };
  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const sourceName = (id) => S.meta?.sources?.[id]?.name ?? id;

  async function fetchJson(url, { label, buster } = {}) {
    const res = await fetch(buster ? `${url}?v=${encodeURIComponent(buster)}` : url, { cache: 'no-cache' });
    if (!res.ok) { const e = new Error(`${label ?? url}: HTTP ${res.status}`); e.status = res.status; e.file = label ?? url; throw e; }
    try { return await res.json(); } catch { const e = new Error(`${label ?? url}: invalid JSON`); e.file = label ?? url; throw e; }
  }

  // ----- header
  function renderHeader() {
    if (S.meta) {
      const h = healthStatus(S.meta, Date.now());
      const btn = $('health');
      btn.dataset.state = h.state; btn.setAttribute('aria-label', h.text); btn.title = h.text;
      $('health-summary').textContent = h.text;
      const list = $('health-list'); clear(list);
      for (const [id, s] of Object.entries(S.meta.sources ?? {})) {
        const li = el('li', null, `${s.name ?? id} · ${s.status} · ${s.kept}${s.error ? ` · ${s.error}` : ''}`);
        li.dataset.status = s.status;
        list.appendChild(li);
      }
      $('source-count').textContent = `${Object.keys(S.meta.sources ?? {}).length} sources`;
      renderRefreshed();
    }
    if (S.digest) {
      $('digest-date').textContent = `${S.digest.date} UTC`;
      $('read-time').textContent = `${S.digest.readingMinutes} min read`;
    }
  }
  function renderRefreshed() {
    if (!S.meta) return;
    $('refreshed').textContent = `refreshed ${relativeAge(S.meta.generatedAt)}`;
  }

  // ----- rows
  function rowFor(item, { snapshot = false } = {}) {
    const node = rowTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = item.id; node.dataset.url = item.url;
    node.querySelector('.score').textContent = snapshot ? '★' : Number(item.score).toFixed(1);
    setLink(node.querySelector('.title'), node.querySelector('.title-text'), item.url, item.title);
    const chips = node.querySelector('.chips-inline');
    for (const s of item.sources ?? []) {
      const href = sourceChipHref(S.meta?.sources?.[s.id], item.url);
      const label = sourceName(s.id);
      if (href) { const a = el('a', null, label); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; chips.appendChild(a); }
      else chips.appendChild(el('span', null, label));
    }
    if (snapshot) for (const n of item.sourceNames ?? []) chips.appendChild(el('span', null, n));
    const age = node.querySelector('.age');
    const at = item.surfacedAt ?? item.publishedAt;
    age.textContent = relativeAge(at); age.title = new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    node.querySelector('.signals').textContent = signalText(item.signals);
    node.querySelector('.summary').textContent = item.summary ?? '';
    const disc = node.querySelector('.discussion');
    const du = safeUrl(item.discussionUrl);
    if (du) { disc.href = du; disc.hidden = false; }
    if (snapshot && !S.items?.some((x) => x.id === item.id)) node.querySelector('.summary').appendChild(el('span', 'hint', ' no longer in the 7-day window'));
    if (S.read[item.id]) node.classList.add('is-read');
    if (S.saved[item.id]) node.classList.add('is-saved');
    node.querySelector('.read').addEventListener('click', (e) => { e.stopPropagation(); toggleRead(item.id); });
    node.querySelector('.save').addEventListener('click', (e) => { e.stopPropagation(); toggleSaved(item); });
    return node;
  }
  function snapshotOf(item) {
    return { title: item.title, url: item.url, sourceNames: (item.sources ?? []).map((s) => sourceName(s.id)).slice(0, 16), publishedAt: item.publishedAt, category: item.category, savedAt: Date.now() };
  }
  function toggleRead(id) {
    if (S.read[id]) delete S.read[id]; else S.read[id] = Date.now();
    store.set('ahead:read', S.read);
    panel.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((n) => n.classList.toggle('is-read', Boolean(S.read[id])));
  }
  function toggleSaved(item) {
    if (S.saved[item.id]) delete S.saved[item.id]; else S.saved[item.id] = snapshotOf(item);
    store.set('ahead:saved', S.saved);
    panel.querySelectorAll(`[data-id="${CSS.escape(item.id)}"]`).forEach((n) => n.classList.toggle('is-saved', Boolean(S.saved[item.id])));
    if (S.savedOnly) render();
  }

  // ----- items
  function ensureItems() {
    if (S.items || S.itemsPromise) return S.itemsPromise ?? Promise.resolve(S.items);
    S.itemsError = null;
    S.itemsPromise = fetchJson('data/items.json', { label: 'data/items.json', buster: S.meta?.generatedAt })
      .then((file) => { S.items = Array.isArray(file?.items) ? file.items : []; return S.items; })
      .catch((err) => { S.itemsError = err; console.error(err); return null; })
      .finally(() => { S.itemsPromise = null; if (CATEGORY_TABS.has(S.tab)) render(); });
    return S.itemsPromise;
  }
  function visibleItems() {
    const since = Date.now() - RANGES[S.range];
    const q = S.query.trim().toLowerCase();
    let list = (S.items ?? []).filter((it) => it.category === S.tab && Date.parse(it.surfacedAt) >= since);
    if (S.selected.size) list = list.filter((it) => it.sources.some((s) => S.selected.has(s.id)));
    if (q.length >= 2) list = list.filter((it) => `${it.title} ${it.summary}`.toLowerCase().includes(q));
    return list;
  }

  // ----- panels
  function renderAlso() {
    const more = (S.meta?.static?.more ?? []).filter((l) => l.tab === S.tab);
    if (!more.length) return null;
    const strip = el('div', 'also', 'Also: ');
    more.forEach((l, i) => {
      const a = el('a', null, l.name); const u = safeUrl(l.url);
      if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = l.blurb ?? ''; strip.appendChild(a); }
      else strip.appendChild(el('span', null, l.name));
      if (i < more.length - 1) strip.appendChild(doc.createTextNode(' · '));
    });
    return strip;
  }
  function renderChips() {
    const chips = $('chips'); clear(chips);
    const counts = new Map();
    const since = Date.now() - RANGES[S.range];
    for (const it of S.items ?? []) {
      if (it.category !== S.tab || Date.parse(it.surfacedAt) < since) continue;
      for (const s of it.sources) counts.set(s.id, (counts.get(s.id) ?? 0) + 1);
    }
    for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      const b = el('button', 'chip', sourceName(id)); b.type = 'button';
      b.setAttribute('aria-pressed', String(S.selected.has(id)));
      b.appendChild(el('span', 'count', String(n)));
      b.addEventListener('click', () => { if (S.selected.has(id)) S.selected.delete(id); else S.selected.add(id); S.shown = PAGE; render(); });
      chips.appendChild(b);
    }
    $('saved-chip').setAttribute('aria-pressed', String(S.savedOnly));
    doc.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === S.range)));
  }
  function renderCategory() {
    const also = renderAlso();
    if (also) panel.appendChild(also);
    if (S.savedOnly) {
      const snaps = Object.entries(S.saved).sort((a, b) => b[1].savedAt - a[1].savedAt);
      if (!snaps.length) { panel.appendChild(el('p', 'notice', 'Nothing saved yet. Press s on a row to save it.')); return; }
      const list = el('div', 'rows');
      for (const [id, snap] of snaps) list.appendChild(rowFor({ id, ...snap, sources: [], signals: {} }, { snapshot: true }));
      panel.appendChild(list);
      return;
    }
    if (!S.items) {
      if (S.itemsError) {
        const box = el('div', 'alert'); box.setAttribute('role', 'alert');
        box.appendChild(el('span', null, `Could not load ${S.itemsError.file} (${S.itemsError.status ? `HTTP ${S.itemsError.status}` : S.itemsError.message})`));
        const retry = el('button', null, 'Retry'); retry.type = 'button'; retry.addEventListener('click', () => { S.itemsError = null; ensureItems(); render(); });
        box.appendChild(retry); panel.appendChild(box);
      } else {
        ensureItems();
        panel.appendChild(el('p', 'notice', 'Loading 7 days of items…'));
      }
      return;
    }
    renderChips();
    const list = visibleItems();
    if (!list.length) { panel.appendChild(el('p', 'notice', 'Nothing here for this range and filter.')); return; }
    const grid = el('div', 'rows');
    for (const it of list.slice(0, S.shown)) grid.appendChild(rowFor(it));
    panel.appendChild(grid);
    if (list.length > S.shown) {
      const more = el('button', 'more', `Show ${Math.min(PAGE, list.length - S.shown)} more`); more.type = 'button';
      more.addEventListener('click', () => { S.shown += PAGE; render({ keepCursor: true }); });
      panel.appendChild(more);
    }
  }
  function entryFor(e) {
    const node = entryTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = e.id; node.dataset.url = e.url;
    setLink(node.querySelector('.title'), node.querySelector('.title-text'), e.url, e.title);
    node.querySelector('.sources').textContent = (e.sourceNames ?? []).join(', ');
    const age = node.querySelector('.age'); age.textContent = relativeAge(e.publishedAt); age.title = `${e.publishedAt}`;
    const disc = node.querySelector('.discussion'); const du = safeUrl(e.discussionUrl);
    if (du) { disc.href = du; disc.hidden = false; }
    node.querySelector('.summary').textContent = e.summary ?? '';
    node.querySelector('.why').textContent = e.why ?? '';
    return node;
  }
  function renderDigest(digest, { dayLabel } = {}) {
    if (digest.overview && digest.overview.text) {
      const o = el('div', 'overview');
      const h = el('div'); h.appendChild(el('strong', null, 'Overview')); h.appendChild(el('span', 'tag', 'AI-written')); o.appendChild(h);
      o.appendChild(el('p', null, digest.overview.text));
      panel.appendChild(o);
    }
    const grid = el('div', 'sections');
    for (const section of digest.sections ?? []) {
      const sec = el('section', 'section');
      sec.dataset.key = typeof section.key === 'string' ? section.key : '';
      const h2 = el('h2', null, section.title);
      if (dayLabel) h2.appendChild(el('span', 'day', dayLabel));
      sec.appendChild(h2);
      if (!section.entries?.length) sec.appendChild(el('p', 'notice', 'Nothing new today'));
      else { const ol = el('ol'); for (const e of section.entries) ol.appendChild(entryFor(e)); sec.appendChild(ol); }
      grid.appendChild(sec);
    }
    panel.appendChild(grid);
  }
  function renderBrief() {
    if (S.noData) { renderNoData(); return; }
    if (!S.digest) { panel.appendChild(el('p', 'notice', 'Loading the brief…')); return; }
    renderDigest(S.digest);
    store.set('ahead:lastVisit', Date.now());
  }
  function renderNoData() {
    const p = el('p', 'notice', 'No data yet. The first refresh runs within six hours; trigger one with ');
    p.appendChild(el('code', null, 'gh workflow run refresh.yml')); p.appendChild(doc.createTextNode('.'));
    panel.appendChild(p);
  }
  function renderCards(list) {
    const ul = el('ul', 'cards');
    for (const l of list) {
      const li = el('li', 'card');
      const a = el('a', 'name', l.name); const u = safeUrl(l.url);
      if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.appendChild(a); } else li.appendChild(el('span', 'name', l.name));
      li.appendChild(el('p', 'blurb', l.blurb ?? ''));
      ul.appendChild(li);
    }
    panel.appendChild(ul);
  }
  function renderLeaderboards() {
    const list = S.meta?.static?.leaderboards;
    if (!list) { panel.appendChild(el('p', 'notice', 'Leaderboards appear once the first refresh has run.')); return; }
    renderCards(list);
  }
  function renderLearn() {
    const list = S.meta?.static?.learn;
    if (!list) { panel.appendChild(el('p', 'notice', 'The learning list appears once the first refresh has run.')); return; }
    const done = list.filter((e) => S.learn[e.id]).length;
    panel.appendChild(el('p', 'counter', `${done}/${list.length} done`));
    const groups = el('div', 'learn-groups');
    for (const [kind, title] of [['course', 'Courses'], ['book', 'Books'], ['paper', 'Papers']]) {
      const group = list.filter((e) => e.kind === kind);
      if (!group.length) continue;
      const wrap = el('div', 'learn-group'); wrap.appendChild(el('h2', null, title));
      const ul = el('ul', 'learn-list');
      for (const e of group) {
        const li = el('li', S.learn[e.id] ? 'done' : '');
        const cb = doc.createElement('input'); cb.type = 'checkbox'; cb.checked = Boolean(S.learn[e.id]); cb.setAttribute('aria-label', `Done: ${e.title}`);
        cb.addEventListener('change', () => { if (cb.checked) S.learn[e.id] = Date.now(); else delete S.learn[e.id]; store.set('ahead:learn', S.learn); render(); });
        li.appendChild(cb);
        const a = el('a', null, e.title); const u = safeUrl(e.url);
        if (u) { a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; li.appendChild(a); } else li.appendChild(el('span', null, e.title));
        ul.appendChild(li);
      }
      wrap.appendChild(ul); groups.appendChild(wrap);
    }
    panel.appendChild(groups);
  }
  const digestCache = new Map();
  function loadDigest(date) {
    if (!digestCache.has(date)) {
      digestCache.set(date, fetchJson(`data/digests/${date}.json`, { label: `data/digests/${date}.json` }).catch((err) => { digestCache.delete(date); throw err; }));
    }
    return digestCache.get(date);
  }
  function renderArchive() {
    const days = S.index?.days ?? [];
    if (!days.length) { if (S.noData) renderNoData(); else panel.appendChild(el('p', 'notice', 'No archived briefs yet.')); return; }
    if (S.archiveDate) {
      const back = el('button', 'back', '← All days'); back.type = 'button'; back.addEventListener('click', () => { location.hash = '#archive'; });
      panel.appendChild(back);
      const holder = el('div'); panel.appendChild(holder);
      loadDigest(S.archiveDate).then((d) => {
        if (S.tab !== 'archive' || S.archiveDate !== d.date) return;
        if (!Array.isArray(d.sections)) throw Object.assign(new Error(`data/digests/${d.date}.json: missing sections`), { file: `data/digests/${d.date}.json` });
        panel.appendChild(el('p', 'muted', `${d.date} UTC · ${d.readingMinutes} min read`));
        renderDigest(d); resetCursor();
      }).catch((err) => showAlert(err.message));
      return;
    }
    const tools = el('div', 'archive-tools');
    const newest = days[0].date;
    const selection = selectCatchUpDays(days, S.previousVisit, newest);
    const btn = el('button', null, selection.length === 0 ? 'Nothing to catch up on'
      : S.previousVisit === 0 ? 'Catch up' : `Catch up since ${new Date(S.previousVisit).toISOString().slice(0, 10)}`);
    btn.type = 'button'; btn.disabled = selection.length === 0;
    btn.addEventListener('click', () => renderCatchUp(selection));
    tools.appendChild(btn);
    tools.appendChild(el('span', 'muted', `${days.length} days archived`));
    panel.appendChild(tools);
    const ul = el('ul', 'archive-list');
    for (const d of days) {
      const li = el('li');
      const b = el('button', null, d.date); b.type = 'button'; b.addEventListener('click', () => { location.hash = `#archive/${d.date}`; });
      li.appendChild(b);
      li.appendChild(el('span', 'muted', `${d.readingMinutes} min read · ${d.entryCount} entries`));
      ul.appendChild(li);
    }
    panel.appendChild(ul);
  }
  async function renderCatchUp(selection) {
    clear(panel);
    const back = el('button', 'back', '← Archive'); back.type = 'button'; back.addEventListener('click', () => render()); panel.appendChild(back);
    panel.appendChild(el('p', 'notice', `Loading ${selection.length} briefs…`));
    let digests;
    try { digests = await Promise.all(selection.map((d) => loadDigest(d.date))); } catch (err) { showAlert(err.message); return; }
    if (S.tab !== 'archive') return;
    clear(panel); panel.appendChild(back);
    const seen = new Set();
    for (const d of digests) {
      const copy = { ...d, overview: null, sections: (d.sections ?? []).map((s) => ({ ...s, entries: s.entries.filter((e) => { if (seen.has(e.id)) return false; seen.add(e.id); return true; }) })).filter((s) => s.entries.length) };
      panel.appendChild(el('h2', 'day-heading', `${d.date} · ${d.readingMinutes} min read`));
      if (!copy.sections.length) panel.appendChild(el('p', 'notice', 'Nothing new that day'));
      renderDigest(copy, { dayLabel: d.date });
    }
    resetCursor();
  }

  // ----- render + routing
  function render({ keepCursor = false } = {}) {
    clear(panel);
    doc.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === S.tab)));
    panel.setAttribute('aria-labelledby', `tab-${S.tab}`);
    filters.hidden = !CATEGORY_TABS.has(S.tab);
    if (S.tab === 'brief') renderBrief();
    else if (CATEGORY_TABS.has(S.tab)) renderCategory();
    else if (S.tab === 'leaderboards') renderLeaderboards();
    else if (S.tab === 'learn') renderLearn();
    else renderArchive();
    if (!keepCursor) resetCursor(); else moveCursor(0);
    measureSticky();
  }
  function route() {
    const hash = location.hash.replace(/^#/, '');
    const [tab, rest] = hash.split('/');
    const next = TABS.includes(tab) ? tab : 'brief';
    S.archiveDate = next === 'archive' && /^\d{4}-\d{2}-\d{2}$/.test(rest ?? '') && (S.index?.days ?? []).some((d) => d.date === rest) ? rest : null;
    if (next !== S.tab) { S.selected.clear(); S.shown = PAGE; }
    S.tab = next;
    if (!TABS.includes(tab) && hash !== '') history.replaceState(null, '', '#brief');
    render();
  }
  function rows() { return [...panel.querySelectorAll('.row, .entry')]; }
  function resetCursor() { S.cursor = 0; moveCursor(0); }
  function moveCursor(delta) {
    const list = rows();
    list.forEach((r) => r.removeAttribute('aria-current'));
    if (!list.length) return;
    S.cursor = Math.max(0, Math.min(list.length - 1, S.cursor + delta));
    const cur = list[S.cursor];
    cur.setAttribute('aria-current', 'true');
    if (delta !== 0) cur.scrollIntoView({ block: 'nearest' });
  }
  function currentRow() { return rows()[S.cursor]; }
  function openRow(row) { const u = safeUrl(row?.dataset.url); if (u) window.open(u, '_blank', 'noopener'); }
  function itemById(id) { return (S.items ?? []).find((it) => it.id === id) ?? null; }

  doc.addEventListener('keydown', (e) => {
    const target = e.target;
    const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'Escape') { if (inInput) { if (search.value) { search.value = ''; S.query = ''; S.shown = PAGE; render(); } target.blur(); } return; }
    if (inInput || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key in KEY_TABS) { location.hash = `#${KEY_TABS[e.key]}`; e.preventDefault(); return; }
    switch (e.key) {
      case 'j': moveCursor(1); e.preventDefault(); break;
      case 'k': moveCursor(-1); e.preventDefault(); break;
      case 'o': case 'Enter': if (target === doc.body || target === panel || target?.closest?.('.row, .entry')) { openRow(currentRow()); e.preventDefault(); } break;
      case 'r': { const row = currentRow(); if (row?.dataset.id) toggleRead(row.dataset.id); break; }
      case 's': { const row = currentRow(); const it = row && itemById(row.dataset.id); if (it) toggleSaved(it); else if (row?.dataset.id && S.saved[row.dataset.id]) toggleSaved({ id: row.dataset.id }); break; }
      case '/': if (!filters.hidden) { search.focus(); e.preventDefault(); } break;
      case 't': cycleTheme(); break;
      default: break;
    }
  });
  panel.addEventListener('click', (e) => {
    const row = e.target.closest('.row, .entry');
    if (!row) return;
    const idx = rows().indexOf(row);
    if (idx >= 0) { S.cursor = idx; moveCursor(0); }
    if (e.target.closest('a, button, input')) return;
    openRow(row);
  });
  doc.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener('click', () => { location.hash = `#${t.dataset.tab}`; }));
  doc.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { S.range = sanitizeRange(b.dataset.range); store.set('ahead:range', S.range); S.shown = PAGE; render(); }));
  $('saved-chip').addEventListener('click', () => { S.savedOnly = !S.savedOnly; S.shown = PAGE; render(); });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { S.query = search.value; S.shown = PAGE; if (!S.items) ensureItems(); render(); }, 120);
  });
  $('health').addEventListener('click', () => { const d = $('health-details'); d.open = !d.open; $('health').setAttribute('aria-expanded', String(d.open)); });
  $('retry').addEventListener('click', () => { hideAlert(); loadCore(); });
  window.addEventListener('hashchange', route);
  setInterval(renderRefreshed, 60_000);

  async function loadCore() {
    S.noData = false;
    const [metaRes, indexRes] = await Promise.allSettled([
      fetchJson('data/meta.json', { label: 'data/meta.json' }),
      fetchJson('data/digests/index.json', { label: 'data/digests/index.json' }),
    ]);
    try {
      if (metaRes.status === 'fulfilled' && metaRes.value && typeof metaRes.value === 'object') S.meta = metaRes.value;
      renderHeader();
      if (metaRes.status === 'rejected') throw metaRes.reason;
      if (!S.meta) throw Object.assign(new Error('data/meta.json has an unexpected shape'), { file: 'data/meta.json' });
      if (indexRes.status === 'rejected') throw indexRes.reason;
      const index = indexRes.value;
      if (!Array.isArray(index?.days)) throw Object.assign(new Error('data/digests/index.json has an unexpected shape'), { file: 'data/digests/index.json' });
      S.index = index;
      if (index.days.length) {
        const newest = index.days[0].date;
        const digest = await fetchJson(`data/digests/${newest}.json`, { label: `data/digests/${newest}.json`, buster: S.meta.generatedAt });
        if (!Array.isArray(digest?.sections)) throw Object.assign(new Error(`data/digests/${newest}.json: missing sections`), { file: `data/digests/${newest}.json` });
        S.digest = digest; digestCache.set(newest, Promise.resolve(digest));
      }
      hideAlert();
    } catch (err) {
      if (err.status === 404 && err.file === 'data/meta.json') S.noData = true;
      else { console.error(err); showAlert(`Could not load ${err.file ?? 'data'} (${err.status ? `HTTP ${err.status}` : err.message})`); }
    }
    renderHeader();
    route();
  }
  route();
  loadCore();
}

if (globalThis.document) start();
