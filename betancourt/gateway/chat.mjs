import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';

const MAX_BODY = 8192;
const NO_CONTEXT = 'В найденных фрагментах недостаточно данных для ответа. Уточните вопрос.';
const sha = value => createHash('sha256').update(value).digest();

export function loadConfig(env = process.env) {
  const config = {
    enabled: env.CHAT_ENABLED === 'true',
    token: env.PILOT_TOKEN ?? '',
    flowiseUrl: env.FLOWISE_URL ?? '',
    flowId: env.FLOWISE_FLOW_ID ?? '',
    flowiseKey: env.FLOWISE_API_KEY ?? '',
    origin: env.PAGES_ORIGIN ?? 'https://getcher123.github.io',
    trustedProxies: (env.TRUSTED_PROXY_CIDRS ?? '').split(',').map(v => v.trim()).filter(Boolean),
    timeoutMs: 60000,
  };
  if (config.enabled) {
    if (config.token.length < 43 || !config.flowiseKey || config.token === config.flowiseKey || !/^[\w-]+$/.test(config.flowId)) {
      throw new Error('Configure separate PILOT_TOKEN (32 random bytes), FLOWISE_API_KEY and FLOWISE_FLOW_ID before enabling chat');
    }
    const url = new URL(config.flowiseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid FLOWISE_URL');
  }
  return config;
}

export function sanitizePrediction(body) {
  if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000 || !Array.isArray(body.sourceDocuments)) {
    throw new Error('Invalid prediction');
  }
  const sources = new Map();
  if (body.sourceDocuments.length > 8) throw new Error('Unexpected retrieval size');
  for (const doc of body.sourceDocuments) {
    const id = doc?.metadata?.chunk_id;
    const section = doc?.metadata?.section;
    const excerpt = doc?.pageContent;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{2,79}$/.test(id) || typeof section !== 'string' || !section.trim() || section.length > 1000 ||
        typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > 8000) throw new Error('Invalid source document');
    const source = { id, section, excerpt };
    if (sources.has(id) && JSON.stringify(sources.get(id)) !== JSON.stringify(source)) throw new Error('Conflicting source document');
    sources.set(id, source);
  }
  return { answer: sources.size ? body.text : NO_CONTEXT, sources: [...sources.values()] };
}

export function createChatHandler(config, { fetchImpl = fetch, now = Date.now, log = record => console.log(JSON.stringify(record)) } = {}) {
  const trusted = new BlockList();
  for (const cidr of config.trustedProxies) {
    const [address, prefix] = cidr.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (!isIP(address)) throw new Error('Invalid TRUSTED_PROXY_CIDRS');
    if (prefix === undefined) trusted.addAddress(address, family);
    else trusted.addSubnet(address, Number(prefix), family);
  }
  const normalize = ip => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
  const isTrusted = ip => isIP(ip) && trusted.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
  function clientIp(req) {
    let ip = normalize(req.socket.remoteAddress) || 'unknown';
    if (!isTrusted(ip)) return ip;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(v => normalize(v.trim()));
    for (let i = forwarded.length - 1; i >= 0 && isTrusted(ip); i--) {
      if (!isIP(forwarded[i])) break;
      ip = forwarded[i];
    }
    return ip;
  }
  let globalRequests = [];
  const perIp = new Map();
  let active = 0;
  return async function handle(req, res) {
    const path = req.url?.split('?')[0];
    const requestId = randomUUID();
    const started = now();
    function reply(status, body, extra = {}) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'X-Request-Id': requestId, ...extra });
      res.end(JSON.stringify(body));
    }
    res.setHeader('Vary', 'Origin');
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) return reply(403, { error: 'Этот сайт не имеет доступа к API.' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (path === '/healthz' && req.method === 'GET') return reply(200, { ok: true, service: 'betancourt-gateway', chatEnabled: config.enabled });
    if (path !== '/api/chat') return reply(404, { error: 'Маршрут не найден.' });
    if (req.method === 'OPTIONS') return reply(204, {}, { 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
    if (req.method !== 'POST') return reply(405, { error: 'Используйте POST.' }, { Allow: 'POST' });
    if (!config.enabled) return reply(503, { error: 'Чат временно отключён.' });
    const supplied = req.headers.authorization ?? '';
    if (!timingSafeEqual(sha(supplied), sha(`Bearer ${config.token}`))) return reply(401, { error: 'Введите действующий код приглашения.' });
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, { error: 'Требуется application/json.' });
    if (Number(req.headers['content-length']) > MAX_BODY) return reply(413, { error: 'Сообщение слишком большое.' });
    const timestamp = now();
    globalRequests = globalRequests.filter(t => timestamp - t < 60000);
    for (const [ip, entries] of perIp) {
      const live = entries.filter(t => timestamp - t < 60000);
      if (live.length) perIp.set(ip, live); else perIp.delete(ip);
    }
    const ip = clientIp(req);
    const attempts = perIp.get(ip) ?? [];
    if (globalRequests.length >= 30 || attempts.length >= 5) return reply(429, { error: 'Слишком много запросов. Попробуйте через минуту.' }, { 'Retry-After': '60' });
    if (active >= 2) return reply(429, { error: 'Сейчас обрабатываются другие вопросы. Попробуйте чуть позже.' }, { 'Retry-After': '5' });
    globalRequests.push(timestamp);
    perIp.set(ip, [...attempts, timestamp]);
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    let result = 'invalid_request';
    try {
      const body = await new Promise((resolve, reject) => {
        let length = 0;
        const chunks = [];
        const abort = () => { cleanup(); reject(new Error('aborted')); };
        const cleanup = () => { req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', fail); controller.signal.removeEventListener('abort', abort); };
        const fail = error => { cleanup(); reject(error); };
        const data = chunk => { length += chunk.length; if (length > MAX_BODY) { reply(413, { error: 'Сообщение слишком большое.' }); fail(new Error('too_large')); req.resume(); } else chunks.push(chunk); };
        const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid_json')); } };
        req.on('data', data); req.on('end', end); req.on('error', fail); controller.signal.addEventListener('abort', abort, { once: true });
      });
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) {
        return reply(400, { error: 'Передайте только message: непустой вопрос до 2000 символов.' });
      }
      result = 'upstream_error';
      const upstream = await fetchImpl(`${config.flowiseUrl.replace(/\/$/, '')}/api/v1/prediction/${encodeURIComponent(config.flowId)}`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.flowiseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: body.message.trim(), streaming: false }), signal: controller.signal,
      });
      if (!upstream.ok) return reply(502, { error: 'Сервис ответа временно недоступен. Попробуйте позже.' });
      const response = sanitizePrediction(await upstream.json());
      result = 'ok';
      reply(200, response);
    } catch (error) {
      if (controller.signal.aborted) { result = 'timeout_or_cancelled'; reply(504, { error: 'Сервис не успел ответить. Попробуйте позже.' }); }
      else if (error.message === 'invalid_json') reply(400, { error: 'Некорректный JSON.' });
      else reply(502, { error: 'Сервис ответа временно недоступен. Попробуйте позже.' });
    } finally {
      clearTimeout(timer);
      res.removeListener('close', onClose);
      active--;
      log({ requestId, durationMs: now() - started, result });
    }
  };
}
