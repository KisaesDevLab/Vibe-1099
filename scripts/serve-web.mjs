/**
 * Vibe 1099 — native web server (replaces the nginx container for a Dockerless
 * install). Serves the built SPA from apps/web/dist with an index.html fallback
 * and reverse-proxies /api to the API process. Zero dependencies — Node built-ins
 * only — so it needs nothing installed beyond the Node runtime already required.
 *
 * Mirrors apps/web/nginx.conf: listen 8211, SPA try_files fallback, /api proxy,
 * 12 MB client_max_body_size, and the X-Forwarded-* headers the API rate limiter
 * keys on (TRUST_PROXY_HOPS=1 in a native install — this proxy is the only hop).
 *
 *   WEB_PORT      listen port                 (default 8211)
 *   API_TARGET    API origin for /api/*       (default http://127.0.0.1:8210)
 *   WEB_ROOT      static dir                  (default ../apps/web/dist)
 */
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT || 8211);
const ROOT = path.resolve(process.env.WEB_ROOT || path.join(HERE, '..', 'apps', 'web', 'dist'));
const API = new URL(process.env.API_TARGET || 'http://127.0.0.1:8210');
const MAX_BODY = 12 * 1024 * 1024; // matches nginx client_max_body_size 12m

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function proxyToApi(req, res) {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
    res.writeHead(413).end('Payload Too Large');
    return;
  }
  const clientIp = req.socket.remoteAddress || '';
  const priorXff = req.headers['x-forwarded-for'];
  const upstream = http.request(
    {
      protocol: API.protocol,
      hostname: API.hostname,
      port: API.port || 80,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `${API.hostname}:${API.port || 80}`,
        'x-forwarded-for': priorXff ? `${priorXff}, ${clientIp}` : clientIp,
        'x-real-ip': clientIp,
        'x-forwarded-proto': 'http',
        'x-forwarded-host': req.headers.host || '',
      },
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`Bad Gateway: API unreachable (${err.code || err.message})`);
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  // Resolve within ROOT; never escape it (path traversal guard).
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let stat = await fs.stat(filePath).catch(() => null);
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = await fs.stat(filePath).catch(() => null);
  }
  if (!stat) {
    // SPA fallback — everything else renders index.html (client-side routing).
    filePath = path.join(ROOT, 'index.html');
    stat = await fs.stat(filePath).catch(() => null);
    if (!stat) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found. Did you build the web app? (pnpm --filter @vibe1099/web build)');
      return;
    }
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) return proxyToApi(req, res);
  serveStatic(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Internal error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`vibe1099-web serving ${ROOT} on :${PORT} → /api ⇒ ${API.origin}`);
});
