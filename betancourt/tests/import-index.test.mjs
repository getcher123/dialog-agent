import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DIMENSIONS } from '../backend/rag.mjs';
import { importIndex, loadIndexFile } from '../backend/import-index.mjs';

async function indexFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'betancourt-index-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const points = Array.from({ length: 87 }, (_, index) => ({ id: randomUUID(), vector: Array(DIMENSIONS).fill(index / 1000), payload: {
    content: `Карточка ${index}`,
    metadata: { chunk_id: `fixture_${index}`, section: 'Раздел', scope: 'common', source_status: 'source_only', source_refs: ['Источник'] },
  } }));
  const sourceSha = 'a'.repeat(64);
  const manifest = { format: 'betancourt-qdrant-export-v1', source_sha256: sourceSha,
    collection: 'betancourt_0123456789abcdef_01234567', model: 'text-embedding-3-small', dimensions: DIMENSIONS,
    distance: 'Cosine', points: 87 };
  const bytes = Buffer.from([JSON.stringify(manifest), ...points.map(point => JSON.stringify(point))].join('\n') + '\n');
  const file = path.join(directory, 'index.jsonl');
  await writeFile(file, bytes);
  const archiveSha = createHash('sha256').update(bytes).digest('hex');
  return { directory, file, points, sourceSha, archiveSha };
}

test('private index loader verifies roots, hashes, manifest and all 87 vectors', async t => {
  const fixture = await indexFixture(t);
  const loaded = await loadIndexFile(fixture.file, { INDEX_DATA_DIR: fixture.directory,
    INDEX_SOURCE_SHA256: fixture.sourceSha, INDEX_ARCHIVE_SHA256: fixture.archiveSha });
  assert.equal(loaded.points.length, 87);
  await assert.rejects(() => loadIndexFile(fixture.file, { INDEX_DATA_DIR: fixture.directory,
    INDEX_SOURCE_SHA256: fixture.sourceSha, INDEX_ARCHIVE_SHA256: 'b'.repeat(64) }), /SHA-256 mismatch/);
});

test('matching collection is skipped and conflicting collection is never overwritten', async t => {
  const fixture = await indexFixture(t);
  const index = await loadIndexFile(fixture.file, { INDEX_DATA_DIR: fixture.directory,
    INDEX_SOURCE_SHA256: fixture.sourceSha, INDEX_ARCHIVE_SHA256: fixture.archiveSha });
  const calls = [];
  const matchingFetch = async (url, options) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (url.endsWith('/points/scroll')) return Response.json({ result: { points: fixture.points, next_page_offset: null } });
    return Response.json({ result: { config: { params: { vectors: { size: DIMENSIONS, distance: 'Cosine' } } } } });
  };
  assert.deepEqual(await importIndex(index, { qdrantUrl: 'http://qdrant:6333', qdrantKey: '' }, matchingFetch),
    { collection: index.manifest.collection, points: 87, skipped: true });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'POST']);
  const conflict = structuredClone(fixture.points);
  conflict[0].payload.content = 'Изменено';
  const conflictingFetch = async url => url.endsWith('/points/scroll')
    ? Response.json({ result: { points: conflict, next_page_offset: null } })
    : Response.json({ result: { config: { params: { vectors: { size: DIMENSIONS, distance: 'Cosine' } } } } });
  await assert.rejects(() => importIndex(index, { qdrantUrl: 'http://qdrant:6333', qdrantKey: '' }, conflictingFetch), /refusing to overwrite/);
});
