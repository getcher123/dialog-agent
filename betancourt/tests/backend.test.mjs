import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { createChatHandler, loadConfig } from '../backend/chat.mjs';

const token = 'a'.repeat(43);
const defaults = { enabled: true, token, allowedOrigins: ['https://getcher123.github.io', 'https://betankur.example'],
  trustedProxies: [], timeoutMs: 1000, rag: {} };
const prediction = () => ({ answer: '<script>not executable</script>', sources: [
  { id: 'fixture_source', section: 'Test section', excerpt: 'Не установлено. Устанавливает собственник.' },
] });

async function fixture(t, config = {}, implementation) {
  const calls = [];
  const logs = [];
  const answerQuestion = async (...args) => {
    calls.push(args);
    return implementation ? implementation(...args) : prediction();
  };
  const handler = createChatHandler({ ...defaults, ...config }, { log: line => logs.push(line), answerQuestion });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { message: 'Test question' }, headers = {}) => fetch(base + '/api/chat', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { calls, logs, base, post };
}

test('configuration validates credentials, collection and allowed origins only when enabled', () => {
  assert.throws(() => loadConfig({ CHAT_ENABLED: 'true' }));
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: 'https://valid.example/path' }));
  const env = { CHAT_ENABLED: 'true', PILOT_TOKEN: token, OPENAI_API_KEY: 'openai-server-key',
    QDRANT_URL: 'http://qdrant:6333', QDRANT_COLLECTION: 'betancourt_0123456789abcdef_01234567',
    ALLOWED_ORIGINS: 'https://getcher123.github.io,https://betankur.example' };
  assert.deepEqual(loadConfig(env).allowedOrigins, defaults.allowedOrigins);
  assert.throws(() => loadConfig({ ...env, OPENAI_API_KEY: token }));
  assert.equal(loadConfig({}).enabled, false);
});

test('health and disabled chat never invoke a provider', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await fetch(f.base + '/healthz')).status, 200);
  const head = await fetch(f.base + '/healthz', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await f.post()).status, 503);
  assert.equal(f.calls.length, 0);
});

test('S01 missing/wrong invitation is independently rate-limited before provider access', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await f.post(undefined, { Authorization: `Bearer wrong-${i}` })).status, 401);
  const limited = await f.post(undefined, { Authorization: 'Bearer still-wrong' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await f.post()).status, 200);
  assert.equal(f.calls.length, 1);
});

test('CORS permits both configured origins and rejects unrelated origins', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(undefined, { Origin: 'https://evil.example' })).status, 403);
  for (const origin of defaults.allowedOrigins) {
    const preflight = await fetch(f.base + '/api/chat', { method: 'OPTIONS', headers: { Origin: origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  }
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

test('S02 rejects oversized content-length and chunked bodies', async t => {
  const normal = await fixture(t);
  assert.equal((await normal.post({ message: 'x'.repeat(9000) })).status, 413);
  const chunked = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = request(chunked.base + '/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.write('{"message":"'); req.write('x'.repeat(9000)); req.end('"}');
  });
  assert.equal(status, 413);
  assert.equal(normal.calls.length + chunked.calls.length, 0);
});

test('S03 provider errors are technical errors without upstream details', async t => {
  const f = await fixture(t, {}, async () => { throw new Error('private upstream failure'); });
  const res = await f.post();
  assert.equal(res.status, 502);
  assert.deepEqual(Object.keys(await res.json()), ['error']);
});

test('S03 timeout cancels request and releases concurrency', async t => {
  let count = 0;
  const f = await fixture(t, { timeoutMs: 30 }, (_question, opts) => {
    if (count++) return prediction();
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
  const f = await fixture(t, {}, () => new Promise(resolve => releases.push(() => resolve(prediction()))));
  const first = f.post();
  const second = f.post();
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await f.post()).status, 429);
  assert.equal(f.calls.length, 2);
  releases.forEach(release => release());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
});

test('S05 returns only permitted fields and safe logs', async t => {
  const f = await fixture(t);
  const result = await (await f.post()).json();
  assert.deepEqual(Object.keys(result), ['answer', 'sources']);
  assert.deepEqual(Object.keys(result.sources[0]), ['id', 'section', 'excerpt']);
  assert.equal(result.sources[0].excerpt, prediction().sources[0].excerpt);
  assert.equal(result.answer, prediction().answer);
  assert.deepEqual(Object.keys(f.logs[0]), ['requestId', 'durationMs', 'result']);
});

test('S06 independent calls forward only the current question', async t => {
  const f = await fixture(t);
  await f.post({ message: 'One' }); await f.post({ message: 'Two' });
  assert.deepEqual(f.calls.map(([question]) => question), ['One', 'Two']);
  assert.ok(f.calls.every(([, options]) => options.signal instanceof AbortSignal));
});
