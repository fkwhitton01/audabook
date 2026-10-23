// Builds the two things you can give her:
//   dist/Audabook.html  one self-contained file: open it in Chrome on the Chromebook, nothing to install
//   dist/web/           the installable web app (upload to GitHub Pages or any https host)
// and copies the web app into docs/, which is the folder GitHub Pages publishes.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', 'app');
const dist = join(here, '..', 'dist');
const read = (p) => readFileSync(join(appDir, p), 'utf8');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- single file -------------------------------------------------------------------------------
let html = read('index.html');
html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => `<style>\n${read(href)}\n</style>`);
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = read(src).replace(/<\/script/gi, '<\\/script');
  return `<script>\n${code}\n</script>`;
});
const svgIcon = 'data:image/svg+xml;base64,' + Buffer.from(read('icons/icon.svg')).toString('base64');
html = html
  .replace(/<link rel="manifest"[^>]*>\n/, '') // a local file can't be installed, and the manifest link would just error
  .replace(/<link rel="icon" href="icons\/icon-192.png"[^>]*>\n/, '')
  .replace('href="icons/icon.svg"', `href="${svgIcon}"`);
if (/<script src=|<link rel="stylesheet"/.test(html)) throw new Error('something was not inlined');
writeFileSync(join(dist, 'Audabook.html'), html);

// --- installable web app -----------------------------------------------------------------------
const web = join(dist, 'web');
cpSync(appDir, web, { recursive: true });
const hash = createHash('sha256');
for (const f of ['index.html', 'css/app.css', ...[...read('index.html').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])]) hash.update(read(f));
const version = hash.digest('hex').slice(0, 10);
const sw = read('sw.js').replace("'audabook-CACHE_VERSION'", `'audabook-${version}'`);
if (!sw.includes(`'audabook-${version}'`)) throw new Error('could not stamp the cache version into sw.js');
writeFileSync(join(web, 'sw.js'), sw);
writeFileSync(join(web, '.nojekyll'), ''); // GitHub Pages: serve files as-is

const docs = join(here, '..', 'docs');
rmSync(docs, { recursive: true, force: true });
cpSync(web, docs, { recursive: true });

console.log(`dist/Audabook.html  (${(html.length / 1024).toFixed(0)} KB)`);
console.log(`dist/web/ and docs/ (cache version ${version})`);
