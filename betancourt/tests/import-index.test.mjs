import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DIMENSIONS } from '../backend/rag.mjs';
import { importIndex, loadIndexFile, verifyBackupFile } from '../backend/import-index.mjs';

async function indexFixture(t, count = 101) {
  const directory = await mkdtemp(path.join(tmpdir(), 'betancourt-index-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const points = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), vector: Array(DIMENSIONS).fill(index / 1000), payload: {
    content: `Карточка ${index}`,
    metadata: { chunk_id: `fixture_${index}`, section: 'Раздел', scope: 'common', source_status: 'source_only', source_refs: ['Источник'] },
  } }));
  const cardsSha = 'a'.repeat(64);
  const collection = 'betancourt_0123456789abcdef_01234567';
  const manifest = { format: 'betancourt-qdrant-export-v2', cards_sha256: cardsSha, collection,
    model: 'text-embedding-3-small', dimensions: DIMENSIONS, distance: 'Cosine', points: count };
  const bytes = Buffer.from([JSON.stringify(manifest), ...points.map(point => JSON.stringify(point))].join('\n') + '\n');
  const file = path.join(directory, 'index.jsonl');
  await writeFile(file, bytes);
  const archiveSha = createHash('sha256').update(bytes).digest('hex');
  const environment = { INDEX_DATA_DIR: directory, INDEX_CARDS_SHA256: cardsSha, INDEX_COLLECTION: collection,
    INDEX_POINTS: String(count), INDEX_ARCHIVE_SHA256: archiveSha };
  return { directory, file, points, cardsSha, collection, archiveSha, environment };
}

test('private index loader verifies dynamic counts, hashes, manifest and all vectors', async t => {
  const fixture = await indexFixture(t, 101);
  const loaded = await loadIndexFile(fixture.file, fixture.environment);
  assert.equal(loaded.points.length, 101);
  await assert.rejects(() => loadIndexFile(fixture.file, { ...fixture.environment, INDEX_ARCHIVE_SHA256: 'b'.repeat(64) }), /SHA-256 mismatch/);
  await assert.rejects(() => loadIndexFile(fixture.file, { ...fixture.environment, INDEX_POINTS: '100' }), /Invalid index manifest/);
  await assert.rejects(() => loadIndexFile(fixture.file, { ...fixture.environment, INDEX_COLLECTION: 'wrong' }), /INDEX_COLLECTION/);
});

test('private index loader rejects a damaged vector before any Qdrant call', async t => {
  const fixture = await indexFixture(t, 2);
  const lines = (await (await import('node:fs/promises')).readFile(fixture.file, 'utf8')).trimEnd().split('\n');
  const point = JSON.parse(lines[1]);
  point.vector.pop();
  lines[1] = JSON.stringify(point);
  const bytes = Buffer.from(`${lines.join('\n')}\n`);
  await writeFile(fixture.file, bytes);
  await assert.rejects(() => loadIndexFile(fixture.file, { ...fixture.environment,
    INDEX_ARCHIVE_SHA256: createHash('sha256').update(bytes).digest('hex') }), /Invalid index point/);
});

test('import requires a valid Qdrant backup inside the private data directory', async t => {
  const fixture = await indexFixture(t, 1);
  const backupPath = path.join(fixture.directory, 'qdrant-backup.json');
  await writeFile(backupPath, JSON.stringify({ format: 'betancourt-qdrant-backup-v1', collections: [{ name: 'legacy', points: [] }], totalPoints: 0 }));
  const backup = await verifyBackupFile(backupPath, fixture.environment);
  assert.equal(backup.collections, 1);
  await writeFile(backupPath, JSON.stringify({ format: 'wrong', collections: [], totalPoints: 0 }));
  await assert.rejects(() => verifyBackupFile(backupPath, fixture.environment), /Invalid Qdrant backup/);
});

test('matching multi-page collection is skipped and conflicting collection is never overwritten', async t => {
  const fixture = await indexFixture(t, 101);
  const index = await loadIndexFile(fixture.file, fixture.environment);
  const calls = [];
  const matchingFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body && JSON.parse(options.body) });
    if (url.endsWith('/points/scroll')) {
      const offset = JSON.parse(options.body).offset;
      return Response.json({ result: offset === null
        ? { points: fixture.points.slice(0, 100), next_page_offset: 'second-page' }
        : { points: fixture.points.slice(100), next_page_offset: null } });
    }
    return Response.json({ result: { config: { params: { vectors: { size: DIMENSIONS, distance: 'Cosine' } } } } });
  };
  assert.deepEqual(await importIndex(index, { qdrantUrl: 'http://qdrant:6333', qdrantKey: '' }, matchingFetch),
    { collection: index.manifest.collection, points: 101, skipped: true });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST', 'POST']);
  const conflict = structuredClone(fixture.points);
  conflict[0].payload.content = 'Изменено';
  const conflictingFetch = async (url, options = {}) => url.endsWith('/points/scroll')
    ? Response.json({ result: { points: conflict, next_page_offset: null } })
    : Response.json({ result: { config: { params: { vectors: { size: DIMENSIONS, distance: 'Cosine' } } } } });
  await assert.rejects(() => importIndex(index, { qdrantUrl: 'http://qdrant:6333', qdrantKey: '' }, conflictingFetch), /refusing to overwrite/);
});

test('a missing collection is created, uploaded in batches, and verified by a repeat read', async t => {
  const fixture = await indexFixture(t, 65);
  const index = await loadIndexFile(fixture.file, fixture.environment);
  let exists = false;
  const uploaded = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === undefined) return exists
      ? Response.json({ result: { config: { params: { vectors: { size: DIMENSIONS, distance: 'Cosine' } } } } })
      : new Response('', { status: 404 });
    if (options.method === 'PUT' && url.includes('/collections/') && !url.includes('/points')) { exists = true; return Response.json({ result: true }); }
    if (url.endsWith('/points?wait=true')) { uploaded.push(...JSON.parse(options.body).points); return Response.json({ result: { status: 'completed' } }); }
    if (url.endsWith('/points/scroll')) return Response.json({ result: { points: uploaded, next_page_offset: null } });
    throw new Error(`Unexpected request ${options.method} ${url}`);
  };
  assert.deepEqual(await importIndex(index, { qdrantUrl: 'http://qdrant:6333', qdrantKey: '' }, fetchImpl),
    { collection: index.manifest.collection, points: 65, skipped: false });
  assert.equal(uploaded.length, 65);
});
