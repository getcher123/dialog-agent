import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createChatHandler, loadConfig } from '../gateway/chat.mjs';

const token = 'a'.repeat(43);
const defaults = { enabled: true, token, flowiseUrl: 'http://flowise:3000', flowId: 'test-flow',
  flowiseKey: 'server-only-flowise-key', origin: 'https://getcher123.github.io', trustedProxies: [], timeoutMs: 1000 };
const prediction = () => ({ text: '<script>not executable</script>', sourceDocuments: [
  { pageContent: 'Не установлено. Устанавливает собственник.', metadata: { chunk_id: 'fixture_source', section: 'Test section', private: 'hidden' } },
  { pageContent: 'Не установлено. Устанавливает собственник.', metadata: { chunk_id: 'fixture_source', section: 'Test section' } }
], chatId: 'private-id', apiKey: 'private-key' });

async function fixture(t, config = {}, implementation) {
  const calls = [];
  const logs = [];
  const handler = createChatHandler({ ...defaults, ...config }, { log: line => logs.push(line), fetchImpl: async (...args) => {
    calls.push(args);
    return implementation ? implementation(...args) : Response.json(prediction());
  } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { message: 'Test question' }, headers = {}) => fetch(base + '/api/chat', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { calls, logs, base, post };
}

test('configuration refuses weak/shared credentials when enabled', () => {
  assert.throws(() => loadConfig({ CHAT_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ CHAT_ENABLED: 'true', PILOT_TOKEN: token, FLOWISE_API_KEY: token, FLOWISE_FLOW_ID: 'flow' }));
  assert.equal(loadConfig({}).enabled, false);
});
test('health and disabled chat never invoke a provider', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await fetch(f.base + '/healthz')).status, 200);
  assert.equal((await f.post()).status, 503);
  assert.equal(f.calls.length, 0);
});
test('S01 missing/wrong invitation rejected before provider access', async t => {
  const f = await fixture(t);
  for (const auth of ['', 'Bearer incorrect']) assert.equal((await f.post(undefined, { Authorization: auth })).status, 401);
  assert.equal(f.calls.length, 0);
});
test('CORS permits the exact Pages origin and rejects unrelated origins', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(undefined, { Origin: 'https://evil.example' })).status, 403);
  const preflight = await fetch(f.base + '/api/chat', { method: 'OPTIONS', headers: { Origin: defaults.origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), defaults.origin);
  assert.equal(f.calls.length, 0);
});
test('S02 rejects overrides, history, uploads, arrays and empty messages', async t => {
  const bodies = [{ message: 'test', overrideConfig: {} }, { message: 'test', history: [] }, { message: 'test', uploads: [] }, [], { message: ' ' }, { message: 'x'.repeat(2001) }];
  for (const body of bodies) {
    const f = await fixture(t);
    assert.equal((await f.post(body)).status, 400);
    assert.equal(f.calls.length, 0);
  }
});
test('S02 rejects oversized content-length bodies', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ message: 'x'.repeat(9000) })).status, 413);
  assert.equal(f.calls.length, 0);
});
test('S02 rejects oversized chunked bodies without Content-Length', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(f.base + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write('{"message":"'); req.write('x'.repeat(9000)); req.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(f.calls.length, 0);
});
test('S03 provider errors are technical errors without upstream details', async t => {
  const f = await fixture(t, {}, () => new Response('private upstream failure', { status: 500 }));
  const res = await f.post();
  assert.equal(res.status, 502);
  assert.deepEqual(Object.keys(await res.json()), ['error']);
});
test('S03 timeout cancels request and releases concurrency', async t => {
  let count = 0;
  const f = await fixture(t, { timeoutMs: 30 }, (_url, opts) => {
    if (count++) return Response.json(prediction());
    return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  });
  assert.equal((await f.post()).status, 504);
  assert.equal((await f.post()).status, 200);
});
test('S04 spoofed forwarding headers do not bypass IP limits', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.post(undefined, { 'X-Forwarded-For': `192.0.2.${i + 1}` })).status, 200);
  assert.equal((await f.post(undefined, { 'X-Forwarded-For': '198.51.100.2' })).status, 429);
  assert.equal(f.calls.length, 5);
});
test('S04 global rate limit applies across trusted proxy client IPs', async t => {
  const f = await fixture(t, { trustedProxies: ['127.0.0.1/32'] });
  for (let i = 1; i <= 30; i++) assert.equal((await f.post(undefined, { 'X-Forwarded-For': `192.0.2.${i}` })).status, 200);
  assert.equal((await f.post(undefined, { 'X-Forwarded-For': '198.51.100.1' })).status, 429);
  assert.equal(f.calls.length, 30);
});
test('S04 rejects third concurrent request without invoking provider', async t => {
  const releases = [];
  const f = await fixture(t, {}, () => new Promise(resolve => releases.push(() => resolve(Response.json(prediction())))));
  const first = f.post();
  const second = f.post();
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await f.post()).status, 429);
  assert.equal(f.calls.length, 2);
  releases.forEach(release => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});
test('S05 returns only permitted fields, de-duplicates sources, preserves negation', async t => {
  const f = await fixture(t);
  const result = await (await f.post()).json();
  assert.deepEqual(Object.keys(result), ['answer', 'sources']);
  assert.equal(result.sources.length, 1);
  assert.deepEqual(Object.keys(result.sources[0]), ['id', 'section', 'excerpt']);
  assert.equal(result.sources[0].excerpt, prediction().sourceDocuments[0].pageContent);
  assert.equal(result.answer, prediction().text);
  assert.deepEqual(Object.keys(f.logs[0]), ['requestId', 'durationMs', 'result']);
});
test('S05 malformed sources fail closed; genuinely empty retrieval is distinguished', async t => {
  const invalid = await fixture(t, {}, () => Response.json({ text: 'answer', sourceDocuments: [{ pageContent: 'content' }] }));
  assert.equal((await invalid.post()).status, 502);
  const empty = await fixture(t, {}, () => Response.json({ text: 'unsubstantiated answer', sourceDocuments: [] }));
  const res = await (await empty.post()).json();
  assert.notEqual(res.answer, 'unsubstantiated answer');
  assert.deepEqual(res.sources, []);
});
test('S06 independent calls forward only question and streaming, with a distinct server key', async t => {
  const f = await fixture(t);
  await f.post({ message: 'One' }); await f.post({ message: 'Two' });
  assert.deepEqual(f.calls.map(([, options]) => JSON.parse(options.body)), [{ question: 'One', streaming: false }, { question: 'Two', streaming: false }]);
  assert.equal(f.calls[0][1].headers.Authorization, `Bearer ${defaults.flowiseKey}`);
});
