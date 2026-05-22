const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'quantum-ia');
const port = Number(process.env.PORT || 4173);
const host = '127.0.0.1';

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

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${host}:${port}`).pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, 'Not found');
      return;
    }

    send(res, 200, data, contentTypes[path.extname(filePath)] || 'application/octet-stream');
  });
}).listen(port, host, () => {
  console.log(`Quantum.ia running at http://${host}:${port}/index.html`);
  console.log(`Escudo Holder running at http://${host}:${port}/Escudo%20Holder.html`);
});
