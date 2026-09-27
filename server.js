import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest, handleHealthRequest } from './lib/quant-api.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') {
      const response = handleHealthRequest();
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      return res.end(await response.text());
    }
    if (url.pathname.startsWith('/api/')) {
      const response = await handleApiRequest(new Request(url, { method: req.method, headers: req.headers }));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    const requested = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(root, requested);
    if (file !== root && !file.startsWith(root + path.sep)) return res.writeHead(403).end('Forbidden');
    fs.readFile(file, (error, content) => {
      if (error) return res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(content);
    });
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message || '服务器内部错误' }));
  }
});
server.on('error', error => console.error('QuantPilot server error:', error));
server.listen(port, host, () => console.log(`QuantPilot is available at http://${host}:${port}`));
