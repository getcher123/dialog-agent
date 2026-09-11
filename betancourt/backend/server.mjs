import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createChatHandler, loadConfig } from './chat.mjs';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const chat = createChatHandler(loadConfig());
const assets = new Map([
  ['/betancourt/', ['index.html', 'text/html; charset=utf-8']],
  ['/betancourt/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/betancourt/config.js', ['config.js', 'text/javascript; charset=utf-8']],
  ['/betancourt/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);
const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if ((path === '/' || path === '/betancourt') && ['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(302, { Location: '/betancourt/' }); res.end(); return;
  }
  if (assets.has(path) && ['GET', 'HEAD'].includes(req.method)) {
    const [name, mime] = assets.get(path);
    try {
      const data = await readFile(`${web}${name}`);
      res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(404); res.end(); }
    return;
  }
  if (req.url?.startsWith('/betancourt/')) req.url = req.url.slice('/betancourt'.length);
  await chat(req, res);
});
server.requestTimeout = 65000;
server.headersTimeout = 15000;
server.listen(Number(process.env.PORT ?? 3310), process.env.HOST ?? '127.0.0.1', () => console.log('Betancourt backend started'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 65000).unref();
});
