import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

const root = resolve(process.argv[2] || 'dist');
const base = process.env.BASE_PATH || '/';
const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base)) throw new Error('Outside preview base');
    const file = resolve(root, pathname.slice(base.length) || 'index.html');
    if (!file.startsWith(root + '/')) throw new Error('Outside preview root');
    const data = await readFile(file);
    response.writeHead(200, {
      'Content-Type': (mime[extname(file)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch {
    response.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + base));
