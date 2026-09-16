import assert from 'node:assert/strict';
import test from 'node:test';
import { backupQdrant } from '../backend/backup-qdrant.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('Qdrant backup reads every collection and paginated point payloads without writes', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === 'http://qdrant:6333/collections') return json({ result: { collections: [{ name: 'first' }, { name: 'second' }] } });
    if (url === 'http://qdrant:6333/collections/first') return json({ result: { config: { params: { vectors: { size: 1536 } } } } });
    if (url === 'http://qdrant:6333/collections/second') return json({ result: { config: { params: { vectors: { size: 1536 } } } } });
    if (url === 'http://qdrant:6333/collections/first/points/scroll') {
      const body = JSON.parse(options.body);
      return body.offset === null ? json({ result: { points: [{ id: 'one' }], next_page_offset: 'next' } }) : json({ result: { points: [{ id: 'two' }], next_page_offset: null } });
    }
    if (url === 'http://qdrant:6333/collections/second/points/scroll') return json({ result: { points: [{ id: 'three' }], next_page_offset: null } });
    throw new Error(`Unexpected request ${url}`);
  };

  const backup = await backupQdrant({ qdrantUrl: 'http://qdrant:6333', fetchImpl });
  assert.equal(backup.format, 'betancourt-qdrant-backup-v1');
  assert.equal(backup.totalPoints, 3);
  assert.deepEqual(backup.collections.map(collection => collection.points.map(point => point.id)), [['one', 'two'], ['three']]);
  assert.equal(calls.some(call => call.options.method && call.options.method !== 'POST'), false);
});
