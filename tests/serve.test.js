import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net, { createServer } from 'node:net';
import path from 'node:path';
import { ROOT } from './helpers.js';

let child;
let base;

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve.mjs did not start')), 10_000);
    child.stdout.on('data', (d) => { if (/Ahead at/.test(String(d))) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code}`)); });
  });
});

after(() => { child?.kill(); });

const get = (p, init) => fetch(`${base}${p}`, { redirect: 'manual', ...init });

test('/ and /ahead/ serve index.html with the right headers', async () => {
  for (const p of ['/', '/ahead/', '/ahead', '/index.html', '/ahead/index.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(r.headers.get('content-length'));
    const text = await r.text();
    assert.ok(text.includes('<title>Ahead'), p);
  }
});

test('MIME types for css/js/json/svg', async () => {
  assert.equal((await get('/ahead/styles.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal((await get('/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('/package.json')).headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await get('/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await get('/ahead/package.json')).status, 200);
});

/** Send a raw request line so the client cannot normalize `..` away. */
function rawStatus(target) {
  return new Promise((resolve, reject) => {
    const { createConnection } = net;
    const port = Number(new URL(base).port);
    const sock = createConnection({ host: '127.0.0.1', port }, () => sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => { data += d; });
    sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1])));
    sock.on('error', reject);
  });
}

test('traversal and malformed URIs are rejected', async () => {
  assert.notEqual(await rawStatus('/../package.json'), 200);
  assert.notEqual(await rawStatus('/ahead/../../package.json'), 200);
  assert.notEqual(await rawStatus('/%2e%2e/package.json'), 200);
  assert.notEqual(await rawStatus('/ahead/%2e%2e/%2e%2e/package.json'), 200);
  assert.notEqual(await rawStatus('/..%2fpackage.json'), 200);
  assert.equal((await get('/%ZZ')).status, 400);
  assert.equal((await get('/missing-file.txt')).status, 404);
  const nf = await get('/missing-file.txt');
  assert.equal(nf.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await nf.text(), 'not found');
});

test('POST -> 405, HEAD -> 200 without a body', async () => {
  const post = await get('/', { method: 'POST' });
  assert.equal(post.status, 405);
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.text()).length, 0);
  assert.ok(Number(head.headers.get('content-length')) > 0);
});
