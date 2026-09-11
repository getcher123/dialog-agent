import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CHAT_MODEL, DIMENSIONS, EMBEDDING_MODEL, NO_CONTEXT, TOP_K, createRag, sourcesFromPoints } from '../backend/rag.mjs';

const config = { openaiKey: 'openai-secret', qdrantUrl: 'http://qdrant:6333', qdrantKey: 'qdrant-secret',
  collection: 'betancourt_0123456789abcdef_01234567' };
const vector = Array(DIMENSIONS).fill(0.125);
const point = { payload: { content: 'Не предусмотрено. Устанавливает собственник.', metadata: {
  chunk_id: 'fixture_source', section: 'Раздел', scope: 'commercial', source_status: 'source_only', source_refs: ['Источник'] } } };

function responseQueue(items, calls) {
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const next = items.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

test('verified prompt is unchanged from the accepted configuration', async () => {
  const prompt = await readFile(new URL('../backend/prompt.txt', import.meta.url));
  assert.equal(createHash('sha256').update(prompt).digest('hex'), '5e0e9c086fdfaf305409d7d4331bf9391c6a351007c2f5e1cd734699c0441261');
});

test('direct RAG performs one embedding, one Qdrant query and one completion', async () => {
  const calls = [];
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [point] } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Краткий ответ.' } }] }),
  ], calls) });
  const result = await rag('Что предусмотрено?');
  assert.equal(result.answer, 'Краткий ответ.');
  assert.deepEqual(result.sources, [{ id: 'fixture_source', section: 'Раздел', excerpt: point.payload.content }]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body, { model: EMBEDDING_MODEL, input: 'Что предусмотрено?', dimensions: DIMENSIONS, encoding_format: 'float' });
  assert.match(calls[1].url, /\/points\/query$/);
  assert.deepEqual(calls[1].body, { query: vector, limit: TOP_K, with_payload: true, with_vector: false });
  assert.equal(calls[1].options.headers['api-key'], config.qdrantKey);
  assert.deepEqual(calls[2].body.messages.map(message => message.role), ['system', 'user']);
  assert.equal(calls[2].body.messages[1].content, 'Что предусмотрено?');
  assert.ok(calls[2].body.messages[0].content.includes(point.payload.content));
  assert.equal(calls[2].body.model, CHAT_MODEL);
  assert.equal(calls[2].body.max_completion_tokens, 1000);
  assert.equal(calls[2].body.temperature, 0);
  assert.equal(calls[2].body.stream, false);
  assert.equal(calls[2].body.store, false);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('empty retrieval returns no-context response without completion', async () => {
  const calls = [];
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [] } }),
  ], calls) });
  assert.deepEqual(await rag('Неизвестный вопрос'), { answer: NO_CONTEXT, sources: [] });
  assert.equal(calls.length, 2);
});

test('malformed vectors, sources, incomplete completions and provider failures fail closed', async () => {
  const scenarios = [
    [Response.json({ data: [{ index: 0, embedding: [1] }] })],
    [Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [{ payload: { content: 'x' } }] } })],
    [Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [point] } }), Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })],
    [new Response('private', { status: 500 })],
  ];
  for (const responses of scenarios) {
    const rag = createRag(config, { fetchImpl: responseQueue(responses, []) });
    await assert.rejects(() => rag('test'));
  }
});

test('source validation de-duplicates exact points and rejects conflicts', () => {
  assert.equal(sourcesFromPoints([point, point]).length, 1);
  const conflict = structuredClone(point);
  conflict.payload.content = 'Другое содержание';
  assert.throws(() => sourcesFromPoints([point, conflict]));
});
