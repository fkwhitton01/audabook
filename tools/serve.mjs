// Tiny static file server for trying the app locally: node tools/serve.mjs [folder] [port] [github]
// With "github" it caches like GitHub Pages (browsers may reuse files for 10 minutes), for testing updates.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] || 'app');
const port = Number(process.argv[3] || 5173);
const likeGitHub = process.argv[4] === 'github';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside root');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
    if (likeGitHub) {
      const etag = '"' + info.mtimeMs.toString(36) + '-' + info.size.toString(36) + '"';
      Object.assign(headers, { 'Cache-Control': 'max-age=600', ETag: etag, 'Last-Modified': info.mtime.toUTCString() });
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
    } else {
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://localhost:${port}/${likeGitHub ? ' (GitHub-style caching)' : ''}`));
