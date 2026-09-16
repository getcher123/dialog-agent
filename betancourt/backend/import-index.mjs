import { createHash } from 'node:crypto';
import { readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DIMENSIONS } from './rag.mjs';

const FORMAT = 'betancourt-qdrant-export-v2';
const COLLECTION_RE = /^betancourt_[a-f0-9]{16}_[a-f0-9]{8}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SCOPES = new Set(['residential', 'commercial', 'parking', 'common', 'comparison']);
const STATUSES = new Set(['source_only', 'preliminary', 'planned', 'conflict', 'missing']);
const MAX_INDEX_POINTS = 5000;

function expectedPointCount(value) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INDEX_POINTS) {
    throw new Error(`INDEX_POINTS must be an integer from 1 to ${MAX_INDEX_POINTS}`);
  }
  return count;
}

function assertPayload(payload) {
  if (!payload || Object.keys(payload).sort().join(',') !== 'content,metadata' || typeof payload.content !== 'string' || !payload.content.trim()) {
    throw new Error('Invalid point payload');
  }
  const metadata = payload.metadata;
  if (!metadata || Object.keys(metadata).sort().join(',') !== 'chunk_id,scope,section,source_refs,source_status' ||
      !/^[a-z][a-z0-9_]{2,79}$/.test(metadata.chunk_id) || typeof metadata.section !== 'string' || !metadata.section.trim() ||
      !SCOPES.has(metadata.scope) || !STATUSES.has(metadata.source_status) || !Array.isArray(metadata.source_refs) ||
      !metadata.source_refs.length || metadata.source_refs.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('Invalid point metadata');
  }
}

export async function loadIndexFile(file, expected = process.env) {
  const dataRoot = await realpath(expected.INDEX_DATA_DIR ?? '/data');
  const resolved = await realpath(file);
  if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) throw new Error('Index file must be inside INDEX_DATA_DIR');
  const bytes = await readFile(resolved);
  if (bytes.length > 32 * 1024 * 1024) throw new Error('Index file exceeds 32 MiB');
  const archiveSha = createHash('sha256').update(bytes).digest('hex');
  if (!SHA_RE.test(expected.INDEX_ARCHIVE_SHA256 ?? '') || archiveSha !== expected.INDEX_ARCHIVE_SHA256) {
    throw new Error('Index archive SHA-256 mismatch');
  }
  if (!SHA_RE.test(expected.INDEX_CARDS_SHA256 ?? '')) throw new Error('INDEX_CARDS_SHA256 must be a SHA-256 digest');
  if (!COLLECTION_RE.test(expected.INDEX_COLLECTION ?? '')) throw new Error('INDEX_COLLECTION is invalid');
  const pointsExpected = expectedPointCount(expected.INDEX_POINTS);

  const lines = bytes.toString('utf8').trimEnd().split('\n');
  const manifest = JSON.parse(lines.shift() ?? 'null');
  if (!manifest || manifest.format !== FORMAT || manifest.cards_sha256 !== expected.INDEX_CARDS_SHA256 ||
      manifest.collection !== expected.INDEX_COLLECTION || manifest.model !== 'text-embedding-3-small' ||
      manifest.dimensions !== DIMENSIONS || manifest.distance !== 'Cosine' || manifest.points !== pointsExpected ||
      !SHA_RE.test(manifest.cards_sha256) || lines.length !== manifest.points) {
    throw new Error('Invalid index manifest');
  }

  const ids = new Set();
  const chunkIds = new Set();
  const points = lines.map(line => {
    const point = JSON.parse(line);
    if (!point || Object.keys(point).sort().join(',') !== 'id,payload,vector' || !UUID_RE.test(point.id) || ids.has(point.id) ||
        !Array.isArray(point.vector) || point.vector.length !== DIMENSIONS || !point.vector.every(Number.isFinite)) throw new Error('Invalid index point');
    assertPayload(point.payload);
    if (chunkIds.has(point.payload.metadata.chunk_id)) throw new Error('Duplicate chunk_id');
    ids.add(point.id);
    chunkIds.add(point.payload.metadata.chunk_id);
    return point;
  });
  return { resolved, archiveSha, manifest, points };
}

export async function verifyBackupFile(file, expected = process.env) {
  if (!file) throw new Error('QDRANT_BACKUP_FILE is required');
  const dataRoot = await realpath(expected.INDEX_DATA_DIR ?? '/data');
  const resolved = await realpath(file);
  if (resolved !== dataRoot && !resolved.startsWith(`${dataRoot}${path.sep}`)) throw new Error('Backup file must be inside INDEX_DATA_DIR');
  const bytes = await readFile(resolved);
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Qdrant backup exceeds 64 MiB');
  const backup = JSON.parse(bytes);
  if (backup?.format !== 'betancourt-qdrant-backup-v1' || !Array.isArray(backup.collections) ||
      !Number.isSafeInteger(backup.totalPoints) || backup.totalPoints < 0 ||
      backup.collections.some(collection => typeof collection?.name !== 'string' || !Array.isArray(collection.points))) {
    throw new Error('Invalid Qdrant backup');
  }
  return { resolved, sha256: createHash('sha256').update(bytes).digest('hex'), collections: backup.collections.length, points: backup.totalPoints };
}

function sameVector(left, right) {
  return Array.isArray(right) && left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= 1e-6);
}

export async function importIndex(index, config, fetchImpl = fetch) {
  const base = new URL(config.qdrantUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid QDRANT_URL');
  const root = base.href.replace(/\/$/, '');
  const collectionUrl = `${root}/collections/${encodeURIComponent(index.manifest.collection)}`;
  const headers = { 'Content-Type': 'application/json', ...(config.qdrantKey ? { 'api-key': config.qdrantKey } : {}) };
  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { ...options, headers: { ...headers, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    const body = await response.json().catch(() => null);
    return { response, body };
  };
  const current = await request(collectionUrl);
  if (current.response.ok) {
    const vectors = current.body?.result?.config?.params?.vectors;
    if (vectors?.size !== DIMENSIONS || String(vectors?.distance).toLowerCase() !== 'cosine') {
      throw new Error('Existing collection has incompatible vector configuration');
    }
    const existing = [];
    let offset = null;
    do {
      const page = await request(`${collectionUrl}/points/scroll`, {
        method: 'POST',
        body: JSON.stringify({ limit: 100, offset, with_payload: true, with_vector: true }),
      });
      if (!page.response.ok || !Array.isArray(page.body?.result?.points)) throw new Error('Failed to verify existing collection');
      existing.push(...page.body.result.points);
      offset = page.body.result.next_page_offset ?? null;
    } while (offset !== null);
    const expected = new Map(index.points.map(point => [point.id, point]));
    if (existing.length !== expected.size || existing.some(point => {
      const wanted = expected.get(String(point.id));
      return !wanted || JSON.stringify(point.payload) !== JSON.stringify(wanted.payload) || !sameVector(wanted.vector, point.vector);
    })) throw new Error('Existing collection is partial or conflicting; refusing to overwrite it');
    return { collection: index.manifest.collection, points: existing.length, skipped: true };
  }
  if (current.response.status !== 404) throw new Error(`Qdrant collection check failed: HTTP ${current.response.status}`);

  const created = await request(collectionUrl, { method: 'PUT', body: JSON.stringify({ vectors: { size: DIMENSIONS, distance: 'Cosine' } }) });
  if (!created.response.ok) throw new Error(`Qdrant collection creation failed: HTTP ${created.response.status}`);
  for (let start = 0; start < index.points.length; start += 32) {
    const uploaded = await request(`${collectionUrl}/points?wait=true`, {
      method: 'PUT',
      body: JSON.stringify({ points: index.points.slice(start, start + 32) }),
    });
    if (!uploaded.response.ok) throw new Error(`Qdrant point upload failed: HTTP ${uploaded.response.status}`);
  }
  const verified = await importIndex(index, config, fetchImpl);
  return { ...verified, skipped: false };
}

async function main() {
  const file = process.env.INDEX_FILE;
  if (!file) throw new Error('INDEX_FILE is required');
  const backup = await verifyBackupFile(process.env.QDRANT_BACKUP_FILE);
  const index = await loadIndexFile(file);
  const result = await importIndex(index, { qdrantUrl: process.env.QDRANT_URL ?? '', qdrantKey: process.env.QDRANT_API_KEY ?? '' });
  if (process.env.DELETE_INDEX_AFTER_IMPORT === 'true') await unlink(index.resolved);
  console.log(JSON.stringify({ event: 'index_import_complete', ...result, cardsSha256: index.manifest.cards_sha256, archiveSha256: index.archiveSha, backupSha256: backup.sha256, backupCollections: backup.collections, backupPoints: backup.points }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(JSON.stringify({ event: 'index_import_failed', error: error.message }));
  process.exitCode = 1;
});
