import { copyFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const [service, output] = process.argv.slice(2);
const files = {
  gateway: ['amvera.yaml', '.dockerignore', 'gateway/Dockerfile', 'gateway/chat.mjs', 'gateway/server.mjs', 'web/index.html', 'web/app.js', 'web/styles.css', 'web/config.js'],
  flowise: ['Dockerfile', 'amvera.yaml', 'disable-retries.mjs'],
};
if (!files[service] || !output) throw new Error('Usage: node tools/package-amvera.mjs gateway|flowise <new-empty-directory>');
await mkdir(output); // Never reuse a directory that could contain private or stale files.
const source = service === 'gateway' ? root : path.join(root, 'flowise');
for (const name of files[service]) {
  const input = path.join(source, name);
  if (!(await lstat(input)).isFile()) throw new Error(`Not a regular file: ${name}`);
  const destination = path.join(output, name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(input, destination);
}
console.log(`Prepared ${service} source directory without KB, credentials or runtime state: ${output}`);
