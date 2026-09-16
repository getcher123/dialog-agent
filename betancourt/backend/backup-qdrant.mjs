import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_POINTS = 10000;

function qdrantRoot(value) {
  const base = new URL(value);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid QDRANT_URL');
  }
  return base.href.replace(/\/$/, '');
}

async function outputPath(file, dataDirectory) {
  if (!file) throw new Error('BACKUP_FILE is required');
  const root = await realpath(dataDirectory ?? '/data');
  const output = path.resolve(file);
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Backup file must be inside BACKUP_DATA_DIR');
  }
  await mkdir(path.dirname(output), { recursive: true });
  return output;
}

async function requestJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Qdrant request failed: HTTP ${response.status}`);
  return body?.result;
}

export async function backupQdrant({ qdrantUrl, fetchImpl = fetch }) {
  const root = qdrantRoot(qdrantUrl);
  const listed = await requestJson(fetchImpl, `${root}/collections`);
  if (!Array.isArray(listed?.collections)) throw new Error('Invalid Qdrant collections response');

  const collections = [];
  let totalPoints = 0;
  for (const { name } of listed.collections) {
    if (typeof name !== 'string' || !name) throw new Error('Invalid Qdrant collection name');
    const collectionUrl = `${root}/collections/${encodeURIComponent(name)}`;
    const config = await requestJson(fetchImpl, collectionUrl);
    const points = [];
    let offset = null;
    do {
      const page = await requestJson(fetchImpl, `${collectionUrl}/points/scroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100, offset, with_payload: true, with_vector: true }),
      });
      if (!Array.isArray(page?.points)) throw new Error('Invalid Qdrant scroll response');
      points.push(...page.points);
      totalPoints += page.points.length;
      if (totalPoints > MAX_POINTS) throw new Error(`Qdrant backup exceeds ${MAX_POINTS} points`);
      offset = page.next_page_offset ?? null;
    } while (offset !== null);
    collections.push({ name, config, points });
  }
  return { format: 'betancourt-qdrant-backup-v1', createdAt: new Date().toISOString(), collections, totalPoints };
}

async function main() {
  const backup = await backupQdrant({ qdrantUrl: process.env.QDRANT_URL ?? '' });
  const output = await outputPath(process.env.BACKUP_FILE, process.env.BACKUP_DATA_DIR);
  const bytes = Buffer.from(JSON.stringify(backup) + '\n');
  await writeFile(output, bytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({
    event: 'qdrant_backup_complete',
    file: path.basename(output),
    collections: backup.collections.length,
    points: backup.totalPoints,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'qdrant_backup_failed', error: error.message }));
    process.exitCode = 1;
  });
}
