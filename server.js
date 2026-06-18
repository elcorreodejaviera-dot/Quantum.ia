const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const STATIC_EXTENSIONS = new Set(Object.keys(contentTypes).filter(e => e !== '.html'));

// (JAV-39 #19 / JAV-83) CSP ENFORCING. Incluye el dominio propio de Clerk en producción
// (*.portal-quantum.com → clerk./accounts.) además de las instancias compartidas de Clerk, y el
// beacon de analítica de Cloudflare. Verificado en headless que Clerk monta bajo esta política.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.clerk.accounts.dev https://*.clerk.com https://*.portal-quantum.com https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com https://*.portal-quantum.com",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://*.clerk.com https://*.clerk.accounts.dev https://*.portal-quantum.com https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// (JAV-39 #19) Cabeceras de seguridad en TODAS las respuestas.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': CSP,
};

// (JAV-39 #20) Cache: no-cache para HTML/SPA/dinámico; immutable para assets versionados (el nombre
// lleva hash de Vite → seguro cachear 1 año). Evita servir un index viejo y 404 de hashes antiguos.
const NO_CACHE = 'no-cache, no-store, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function send(res, status, body, contentType = 'text/plain; charset=utf-8', cacheControl = NO_CACHE) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': cacheControl, 'Content-Type': contentType });
  res.end(body);
}

function serveFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not found');
      return;
    }
    send(res, status, data, contentTypes[path.extname(filePath)] || 'application/octet-stream');
  });
}

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${displayHost}:${port}`).pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  if (pathname === '/health') {
    send(res, 200, JSON.stringify({ ok: true, app: 'quantum-ia' }), 'application/json; charset=utf-8');
    return;
  }

  const filePath = path.normalize(path.join(root, pathname === '/' ? '/index.html' : pathname));
  if (!filePath.startsWith(root)) {
    send(res, 403, 'Forbidden');
    return;
  }

  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (!err) {
      // (JAV-39 #20) assets versionados (/assets/*, con hash) → immutable; resto → no-cache.
      const cache = pathname.startsWith('/assets/') ? IMMUTABLE : NO_CACHE;
      send(res, 200, data, contentTypes[ext] || 'application/octet-stream', cache);
      return;
    }

    // Archivo estático faltante (js, css, png...) → 404 real
    if (STATIC_EXTENSIONS.has(ext)) {
      serveFile(res, path.join(root, '404.html'), 404);
      return;
    }

    // SPA fallback: cualquier ruta desconocida → index.html
    serveFile(res, path.join(root, 'index.html'));
  });
}).listen(port, host, () => {
  console.log(`Quantum.ia running at http://${displayHost}:${port}/`);
  console.log(`Health check running at http://${displayHost}:${port}/health`);
});
