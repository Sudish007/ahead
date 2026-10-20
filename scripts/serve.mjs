#!/usr/bin/env node
// Tiny static server for local checks: serves the project root under both / and /ahead/.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portEnv = Number(process.env.PORT);
const PORT = Number.isInteger(portEnv) && portEnv >= 1 && portEnv <= 65535 ? portEnv : 8787;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.xml': 'application/xml',
};

function send(res, status, headers, body, method) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  if (method === 'HEAD') res.end(); else res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD', 'Content-Length': 18 }, 'method not allowed', req.method);
  let pathname;
  try {
    const rawPath = decodeURIComponent(String(req.url).split('?')[0]);
    if (rawPath.split(/[\\/]/).includes('..')) return notFound(res, req.method);
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch { return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 11 }, 'bad request', req.method); }
  pathname = pathname.replace(/^\/ahead(?=\/|$)/, '') || '/';
  let file = path.resolve(ROOT, `.${pathname}`);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return notFound(res, req.method);
  try {
    let st = await stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file); }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': type, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    return notFound(res, req.method);
  }
});

function notFound(res, method) {
  return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 9 }, 'not found', method);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ahead at http://127.0.0.1:${PORT}/ and http://127.0.0.1:${PORT}/ahead/`);
});
