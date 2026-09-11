import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../web/', import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node tools/build-pages.mjs <artifact-directory>/betancourt');
const apiBase = process.env.BETANCOURT_API_BASE || '';
if (apiBase) {
  const url = new URL(apiBase);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('BETANCOURT_API_BASE must be a public HTTPS gateway URL without credentials');
}
await mkdir(destination, { recursive: true });
// Deliberate allowlist: never publish the KB, flow, fixtures, reports or .env.
for (const name of ['index.html', 'styles.css', 'app.js']) await copyFile(path.join(source, name), path.join(destination, name));
await writeFile(path.join(destination, 'config.js'), `window.BETANCOURT_CONFIG = ${JSON.stringify({ apiBase }).replace(/</g, '\\u003c')};\n`);
console.log(`Built public Betancourt files; API ${apiBase ? 'configured' : 'disabled until deployment'}`);
