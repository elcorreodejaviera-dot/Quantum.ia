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

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
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
      send(res, 200, data, contentTypes[ext] || 'application/octet-stream');
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
