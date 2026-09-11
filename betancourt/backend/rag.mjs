import { readFileSync } from 'node:fs';

const PROMPT = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8');
if (PROMPT.split('{context}').length !== 2) throw new Error('Prompt must contain exactly one {context} placeholder');
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const CHAT_MODEL = 'gpt-4.1-mini-2025-04-14';
export const DIMENSIONS = 1536;
export const TOP_K = 8;
export const NO_CONTEXT = 'В найденных фрагментах недостаточно данных для ответа. Уточните вопрос.';

export function loadRagConfig(env) {
  if (!env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required');
  if (!/^betancourt_[a-f0-9]{16}_[a-f0-9]{8}$/.test(env.QDRANT_COLLECTION ?? '')) {
    throw new Error('Set QDRANT_COLLECTION to the verified collection from kb/index-state.json');
  }
  const url = new URL(env.QDRANT_URL ?? '');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid QDRANT_URL');
  }
  return { openaiKey: env.OPENAI_API_KEY, qdrantUrl: url.href.replace(/\/$/, ''),
    qdrantKey: env.QDRANT_API_KEY ?? '', collection: env.QDRANT_COLLECTION };
}

export function sourcesFromPoints(points) {
  if (!Array.isArray(points) || points.length > TOP_K) throw new Error('Invalid retrieval result');
  const sources = new Map();
  for (const point of points) {
    const payload = point?.payload;
    const id = payload?.metadata?.chunk_id;
    const section = payload?.metadata?.section;
    const excerpt = payload?.content;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{2,79}$/.test(id) || typeof section !== 'string' || !section.trim() || section.length > 1000 ||
        typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > 8000) throw new Error('Invalid source document');
    const source = { id, section, excerpt };
    if (sources.has(id) && JSON.stringify(sources.get(id)) !== JSON.stringify(source)) throw new Error('Conflicting source document');
    sources.set(id, source);
  }
  return [...sources.values()];
}

export function createRag(config, { fetchImpl = fetch } = {}) {
  async function post(stage, url, headers, body, signal) {
    signal?.throwIfAborted();
    // No SDK retries or redirects: each question has one fixed provider sequence.
    const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal, redirect: 'error' });
    if (!res.ok) {
      await res.body?.cancel();
      const error = new Error(`Provider HTTP ${res.status}`);
      error.providerStage = stage;
      error.providerStatus = res.status;
      throw error;
    }
    return res.json();
  }
  return async function answerQuestion(question, { signal } = {}) {
    if (!config) throw new Error('RAG is not configured');
    const auth = { Authorization: `Bearer ${config.openaiKey}` };
    const embedding = await post('embedding', 'https://api.openai.com/v1/embeddings', auth,
      { model: EMBEDDING_MODEL, input: question, dimensions: DIMENSIONS, encoding_format: 'float' }, signal);
    const vector = embedding?.data?.[0]?.embedding;
    if (embedding?.data?.length !== 1 || embedding.data[0].index !== 0 || !Array.isArray(vector) || vector.length !== DIMENSIONS || !vector.every(Number.isFinite)) {
      throw new Error('Invalid embedding');
    }
    const matches = await post('retrieval', `${config.qdrantUrl}/collections/${encodeURIComponent(config.collection)}/points/query`,
      config.qdrantKey ? { 'api-key': config.qdrantKey } : {}, { query: vector, limit: TOP_K, with_payload: true, with_vector: false }, signal);
    const sources = sourcesFromPoints(matches?.result?.points);
    if (!sources.length) return { answer: NO_CONTEXT, sources };
    // Use a replacement callback so literal "$&" etc. in source text stay data.
    const system = PROMPT.replace('{context}', () => sources.map(s => s.excerpt).join('\n\n'));
    const completion = await post('completion', 'https://api.openai.com/v1/chat/completions', auth,
      { model: CHAT_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        temperature: 0, max_completion_tokens: 1000, stream: false, store: false }, signal);
    const choice = completion?.choices?.[0];
    const answer = choice?.message?.content;
    if (completion?.choices?.length !== 1 || choice.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls?.length ||
        typeof answer !== 'string' || !answer.trim() || answer.length > 20000) throw new Error('Invalid or incomplete completion');
    return { answer, sources };
  };
}
