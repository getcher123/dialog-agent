import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { CHAT_MODEL, DEFAULT_MAX_COMPLETION_TOKENS, DIMENSIONS, EMBEDDING_MODEL, MAX_SOURCES, NO_CONTEXT, SECTION_TOO_LARGE, TOP_K,
  createRag, loadRagConfig, serviceRouteForQuestion, sourcesFromPoints } from '../backend/rag.mjs';

const config = { openaiKey: 'openai-secret', qdrantUrl: 'http://qdrant:6333', qdrantKey: 'qdrant-secret',
  collection: 'betancourt_0123456789abcdef_01234567', maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS };
const vector = Array(DIMENSIONS).fill(0.125);
function point(id = 'fixture_source', section = 'Раздел', content = 'Не предусмотрено. Устанавливает собственник.') {
  return { payload: { content, metadata: {
    chunk_id: id, section, scope: 'commercial', source_status: 'source_only', source_refs: ['Источник'] } } };
}

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
  assert.equal(createHash('sha256').update(prompt).digest('hex'), '9955a40abc419c3945932043b2b5262a5544b4f520760d670fce9913cd803eeb');
});

test('broad resident and management service questions use only their canonical routes', () => {
  for (const question of [
    'Какие сервисы есть для жильцов?',
    'Какие услуги предусмотрены для жителей?',
    'Какие удобства доступны собственникам?',
    'Какая инфраструктура предусмотрена для жильцов?',
  ]) assert.equal(serviceRouteForQuestion(question)?.id, 'resident_services', question);
  assert.equal(serviceRouteForQuestion('Какие услуги УК доступны жильцам?')?.id, 'management_services');
  assert.equal(serviceRouteForQuestion('Какие сервисы предоставляет управляющая компания?')?.id, 'management_services');
  assert.equal(serviceRouteForQuestion('Какие услуги связи доступны жильцам?'), null);
  assert.equal(serviceRouteForQuestion('Что сказано в разделе «Техническое описание / Сервис для жильцов»?'), null);
});

test('resident services route loads exact sections without embedding or semantic retrieval', async () => {
  const calls = [];
  const traces = [];
  const resident = point('resident_services', 'Техническое описание / Сервис для жильцов', 'Спортзал, коворкинг и гостевой санузел предусмотрены проектом.');
  const management = point('management_services', 'Концепция эксплуатации / Конкурентные преимущества сервиса', 'Круглосуточная диспетчерская, управляющий и клининг предусмотрены концепцией.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ result: { points: [resident], next_page_offset: null } }),
    Response.json({ result: { points: [management], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'По проектным материалам доступны два блока сервисов.' } }] }),
  ], calls) });
  const result = await rag('Какие сервисы есть для жильцов?', { trace: record => traces.push(record) });
  assert.deepEqual(result.sources.map(source => source.id), ['resident_services', 'management_services']);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => !/\/embeddings$|\/points\/query$/.test(call.url)));
  assert.deepEqual(calls[0].body.filter, { must: [{ key: 'metadata.section', match: { value: resident.payload.metadata.section } }] });
  assert.deepEqual(calls[1].body.filter, { must: [{ key: 'metadata.section', match: { value: management.payload.metadata.section } }] });
  assert.match(calls[2].body.messages[0].content, /ровно двумя блоками/i);
  assert.match(calls[2].body.messages[0].content, /Группа «Инфраструктура для жильцов»[\s\S]*Группа «Сервисы управляющей компании»/);
  assert.deepEqual(traces[0], { stage: 'route', route: 'resident_services', sections: [resident.payload.metadata.section, management.payload.metadata.section] });
});

test('management service route takes precedence and does not load resident infrastructure', async () => {
  const calls = [];
  const management = point('management_services', 'Концепция эксплуатации / Конкурентные преимущества сервиса', 'Круглосуточная диспетчерская и управляющий.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ result: { points: [management], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Сервисы УК перечислены.' } }] }),
  ], calls) });
  const result = await rag('Какие услуги УК доступны жильцам?');
  assert.deepEqual(result.sources.map(source => source.id), ['management_services']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body.filter, { must: [{ key: 'metadata.section', match: { value: management.payload.metadata.section } }] });
  assert.match(calls[1].body.messages[0].content, /одним блоком/i);
});

test('narrow resident service question remains on the semantic retrieval path', async () => {
  const calls = [];
  const source = point('resident_connection', 'Техническое описание / Слаботочные системы', 'Описание подключения к интернету.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [source] } }),
    Response.json({ result: { points: [source], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Ответ о связи.' } }] }),
  ], calls) });
  await rag('Какие услуги связи доступны жильцам?');
  assert.match(calls[0].url, /\/embeddings$/);
  assert.match(calls[1].url, /\/points\/query$/);
});

test('resident route fails closed when one canonical section is unavailable', async () => {
  const calls = [];
  const resident = point('resident_services', 'Техническое описание / Сервис для жильцов', 'Спортзал предусмотрен проектом.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ result: { points: [resident], next_page_offset: null } }),
    Response.json({ result: { points: [], next_page_offset: null } }),
  ], calls) });
  assert.deepEqual(await rag('Какие сервисы есть для жильцов?'), { answer: NO_CONTEXT, sources: [] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !/\/embeddings$|\/points\/query$|\/chat\/completions$/.test(call.url)));
});

test('direct RAG performs one embedding, one Qdrant query, section expansion and one completion', async () => {
  const calls = [];
  const source = point('fixture_source', 'Раздел', '| Название | Значение |\n| --- | --- |\n| Первая строка | Не предусмотрено |\n\nСобственник выполняет работы сам.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [source] } }),
    Response.json({ result: { points: [source], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Краткий ответ.' } }] }),
  ], calls) });
  const result = await rag('Что предусмотрено?');
  assert.equal(result.answer, 'Краткий ответ.');
  assert.deepEqual(result.sources, [{ id: 'fixture_source', section: 'Раздел', excerpt: source.payload.content }]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].body, { model: EMBEDDING_MODEL, input: 'Что предусмотрено?', dimensions: DIMENSIONS, encoding_format: 'float' });
  assert.match(calls[1].url, /\/points\/query$/);
  assert.deepEqual(calls[1].body, { query: vector, limit: TOP_K, with_payload: true, with_vector: false });
  assert.match(calls[2].url, /\/points\/scroll$/);
  assert.deepEqual(calls[2].body, { filter: { must: [{ key: 'metadata.section', match: { value: 'Раздел' } }] },
    limit: MAX_SOURCES + 1, with_payload: true, with_vector: false });
  assert.equal(calls[1].options.headers['api-key'], config.qdrantKey);
  assert.deepEqual(calls[3].body.messages.map(message => message.role), ['system', 'user']);
  assert.equal(calls[3].body.messages[1].content, 'Что предусмотрено?');
  assert.ok(calls[3].body.messages[0].content.includes(source.payload.content));
  assert.equal(calls[3].body.model, CHAT_MODEL);
  assert.equal(calls[3].body.max_completion_tokens, DEFAULT_MAX_COMPLETION_TOKENS);
  assert.equal(calls[3].body.temperature, 0);
  assert.equal(calls[3].body.stream, false);
  assert.equal(calls[3].body.store, false);
  assert.ok(calls.every(call => call.options.redirect === 'error'));
});

test('RAG sends every card in an identified split section to the model', async () => {
  const calls = [];
  const first = point('split_one', 'Таблица конкурентов', 'Первая часть таблицы.');
  const second = point('split_two', 'Таблица конкурентов', 'Вторая часть таблицы.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [first] } }),
    Response.json({ result: { points: [first, second], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Полный ответ.' } }] }),
  ], calls) });
  const result = await rag('Перечислите конкурентов');
  assert.deepEqual(result.sources.map(source => source.id), ['split_one', 'split_two']);
  assert.match(calls[3].body.messages[0].content, /Первая часть таблицы\.[\s\S]*Вторая часть таблицы\./);
});

test('an explicitly quoted section is added with an exact metadata lookup', async () => {
  const calls = [];
  const semantic = point('semantic_result', 'Соседний раздел', 'Близкий, но не запрошенный текст.');
  const requested = point('requested_section', 'Техническое описание ВПП / Пол', 'Пол ВПП — точный раздел.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [semantic] } }),
    Response.json({ result: { points: [requested], next_page_offset: null } }),
  ], calls) });
  const result = await rag('Что именно в КП сказано в разделе «Техническое описание ВПП / Пол»?');
  assert.deepEqual(result.sources.map(source => source.id), ['requested_section']);
  assert.deepEqual(calls[2].body.filter, { must: [{ key: 'metadata.section', match: { value: 'Техническое описание ВПП / Пол' } }] });
  assert.equal(result.answer, 'Пол ВПП — точный раздел.');
  assert.equal(calls.length, 3);
});

test('an explicitly quoted parent section retains only its related child sections', async () => {
  const calls = [];
  const parent = point('parent', 'Конкурентное окружение', 'Заголовок конкурентного окружения.');
  const child = point('child', 'Конкурентное окружение / Описание конкурентов', 'Строка таблицы конкурентов.');
  const unrelated = point('unrelated', 'Описание дома / Конкурентное окружение', 'Нерелевантный текст.');
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [child, unrelated] } }),
    Response.json({ result: { points: [parent], next_page_offset: null } }),
    Response.json({ result: { points: [child], next_page_offset: null } }),
  ], calls) });
  const result = await rag('Что именно сказано в разделе «Конкурентное окружение»?');
  assert.deepEqual(result.sources.map(source => source.id), ['parent', 'child']);
  assert.match(result.answer, /Заголовок конкурентного окружения\.[\s\S]*Строка таблицы конкурентов\./);
  assert.equal(calls.length, 4);
});

test('optional retrieval trace contains point scores but never changes the API response', async () => {
  const source = { ...point(), id: '00000000-0000-4000-8000-000000000001', score: 0.88 };
  const traces = [];
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [source] } }),
    Response.json({ result: { points: [source], next_page_offset: null } }),
    Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Ответ.' } }] }),
  ], []) });
  const result = await rag('Вопрос', { trace: record => traces.push(record) });
  assert.deepEqual(Object.keys(result).sort(), ['answer', 'sources']);
  assert.deepEqual(traces[0], { stage: 'retrieval', points: [{ pointId: source.id, chunkId: 'fixture_source', score: 0.88 }] });
  assert.deepEqual(traces.at(-1), { stage: 'context', sourceChunkIds: ['fixture_source'] });
});

test('section that exceeds the context source limit asks for clarification without completion', async () => {
  const calls = [];
  const first = point('large_0', 'Большой раздел');
  const all = Array.from({ length: MAX_SOURCES + 1 }, (_, index) => point(`large_${index}`, 'Большой раздел', `Часть ${index}`));
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }),
    Response.json({ result: { points: [first] } }),
    Response.json({ result: { points: all, next_page_offset: null } }),
  ], calls) });
  assert.deepEqual(await rag('Покажите весь большой раздел'), { answer: SECTION_TOO_LARGE, sources: [] });
  assert.equal(calls.length, 3);
});

test('empty retrieval returns no-context response without section lookup or completion', async () => {
  const calls = [];
  const rag = createRag(config, { fetchImpl: responseQueue([
    Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [] } }),
  ], calls) });
  assert.deepEqual(await rag('Неизвестный вопрос'), { answer: NO_CONTEXT, sources: [] });
  assert.equal(calls.length, 2);
});

test('configured completion limit is validated and passed to the provider', () => {
  const env = { OPENAI_API_KEY: 'test', QDRANT_URL: 'http://qdrant:6333', QDRANT_COLLECTION: config.collection,
    RAG_MAX_COMPLETION_TOKENS: '4096' };
  assert.equal(loadRagConfig(env).maxCompletionTokens, 4096);
  assert.throws(() => loadRagConfig({ ...env, RAG_MAX_COMPLETION_TOKENS: '4097' }), /RAG_MAX_COMPLETION_TOKENS/);
});

test('malformed vectors, sources, incomplete completions and provider failures fail closed', async () => {
  const source = point();
  const scenarios = [
    [Response.json({ data: [{ index: 0, embedding: [1] }] })],
    [Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [{ payload: { content: 'x' } }] } })],
    [Response.json({ data: [{ index: 0, embedding: vector }] }), Response.json({ result: { points: [source] } }),
      Response.json({ result: { points: [source], next_page_offset: null } }),
      Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })],
    [new Response('private', { status: 500 })],
  ];
  for (const responses of scenarios) {
    const rag = createRag(config, { fetchImpl: responseQueue(responses, []) });
    await assert.rejects(() => rag('test'));
  }
});

test('source validation de-duplicates exact points and rejects conflicts', () => {
  const source = point();
  assert.equal(sourcesFromPoints([source, source]).length, 1);
  const conflict = structuredClone(source);
  conflict.payload.content = 'Другое содержание';
  assert.throws(() => sourcesFromPoints([source, conflict]));
});
