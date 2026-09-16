import { readFileSync } from 'node:fs';

const PROMPT = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8');
if (PROMPT.split('{context}').length !== 2) throw new Error('Prompt must contain exactly one {context} placeholder');
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const CHAT_MODEL = 'gpt-4.1-mini-2025-04-14';
export const DIMENSIONS = 1536;
export const TOP_K = 8;
export const MAX_SOURCES = 32;
export const DEFAULT_MAX_COMPLETION_TOKENS = 1000;
export const NO_CONTEXT = 'В найденных фрагментах недостаточно данных для ответа. Уточните вопрос.';
export const SECTION_TOO_LARGE = 'Вопрос затрагивает слишком большой раздел документа. Уточните, какой именно аспект вам нужен.';

function boundedInteger(value, fallback, name, { min, max }) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be from ${min} to ${max}`);
  return parsed;
}

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
    qdrantKey: env.QDRANT_API_KEY ?? '', collection: env.QDRANT_COLLECTION,
    maxCompletionTokens: boundedInteger(env.RAG_MAX_COMPLETION_TOKENS, DEFAULT_MAX_COMPLETION_TOKENS,
      'RAG_MAX_COMPLETION_TOKENS', { min: 1, max: 4096 }) };
}

export function sourcesFromPoints(points, { max = TOP_K } = {}) {
  if (!Array.isArray(points) || points.length > max) throw new Error('Invalid retrieval result');
  const sources = new Map();
  for (const point of points) {
    const payload = point?.payload;
    const id = payload?.metadata?.chunk_id;
    const section = payload?.metadata?.section;
    const excerpt = payload?.content;
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_]{2,79}$/.test(id) || typeof section !== 'string' || !section.trim() || section.length > 1000 ||
        typeof excerpt !== 'string' || !excerpt.trim() || excerpt.length > 8000) throw new Error('Invalid source document');
    const source = { id, section, excerpt };
    // Retained internally for deterministic source order; it is non-enumerable
    // and therefore never reaches the public API response.
    Object.defineProperty(source, 'sourceRefs', { value: payload.metadata.source_refs, enumerable: false });
    if (sources.has(id) && JSON.stringify(sources.get(id)) !== JSON.stringify(source)) throw new Error('Conflicting source document');
    sources.set(id, source);
  }
  return [...sources.values()];
}

function safeTrace(trace, record) {
  try { trace?.(record); } catch { /* Diagnostics must never change an answer. */ }
}

function tracePoints(points) {
  return points.map(point => ({ pointId: String(point?.id ?? ''), chunkId: point?.payload?.metadata?.chunk_id,
    ...(typeof point?.score === 'number' ? { score: point.score } : {}) }));
}

function explicitlyRequestedSection(question) {
  // A quoted section name is data from the user, not a filter expression. It is
  // still resolved only through an exact Qdrant metadata match below.
  return question.match(/(?:^|\s)раздел(?:е|а|ом)?\s*[«"]([^»"]{1,1000})[»"]/iu)?.[1]?.trim();
}

function requestsVerbatimSection(question) {
  return /(?:что\s+именно[\s\S]{0,80}?сказано|полный\s+перечень|все\s+строки|покажи(?:те)?\s+все|перечисли(?:те)?\s+все)/iu.test(question);
}

function sourceOrder(left, right) {
  const depth = source => source.section.split(' / ').length;
  if (depth(left) !== depth(right)) return depth(left) - depth(right);
  const visualOrder = source => Number(source.sourceRefs?.[0]?.match(/(?:^|\/)I(\d+)\b/)?.[1] ?? Number.MAX_SAFE_INTEGER);
  if (visualOrder(left) !== visualOrder(right)) return visualOrder(left) - visualOrder(right);
  const part = source => Number(source.excerpt.match(/(?:законченная\s+)?часть\s+раздела\s+(\d+)/iu)?.[1] ?? 0);
  return part(left) - part(right);
}

async function sectionSources(config, sections, post, signal, trace) {
  const sources = new Map();
  for (const section of sections) {
    // Request one extra point: a section that cannot fit is never silently truncated.
    const result = await post('section_retrieval',
      `${config.qdrantUrl}/collections/${encodeURIComponent(config.collection)}/points/scroll`,
      config.qdrantKey ? { 'api-key': config.qdrantKey } : {},
      { filter: { must: [{ key: 'metadata.section', match: { value: section } }] }, limit: MAX_SOURCES + 1,
        with_payload: true, with_vector: false }, signal);
    const points = result?.result?.points;
    if (!Array.isArray(points) || result?.result?.next_page_offset !== null && result?.result?.next_page_offset !== undefined) {
      throw new Error('Invalid section retrieval result');
    }
    const sectionEntries = sourcesFromPoints(points, { max: MAX_SOURCES + 1 });
    safeTrace(trace, { stage: 'section_retrieval', section, points: tracePoints(points) });
    if (sectionEntries.some(source => source.section !== section) || sectionEntries.length > MAX_SOURCES) return null;
    for (const source of sectionEntries) {
      const previous = sources.get(source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new Error('Conflicting section source document');
      sources.set(source.id, source);
      if (sources.size > MAX_SOURCES) return null;
    }
  }
  return [...sources.values()];
}

export function createRag(config, { fetchImpl = fetch, trace: defaultTrace } = {}) {
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
  return async function answerQuestion(question, { signal, trace = defaultTrace } = {}) {
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
    const initialPoints = matches?.result?.points;
    const initialSources = sourcesFromPoints(initialPoints);
    safeTrace(trace, { stage: 'retrieval', points: tracePoints(initialPoints ?? []) });
    if (!initialSources.length) return { answer: NO_CONTEXT, sources: initialSources };
    const requestedSection = explicitlyRequestedSection(question);
    const exactSources = requestedSection ? await sectionSources(config, [requestedSection], post, signal, trace) : [];
    if (exactSources === null) return { answer: SECTION_TOO_LARGE, sources: [] };
    // An explicit section must not be contaminated by a similarly named section
    // from another scope. Keep only its semantic children, such as a split table.
    const relatedInitialSources = exactSources.length && requestedSection
      ? initialSources.filter(source => source.section.startsWith(`${requestedSection} /`))
      : initialSources;
    const byId = new Map([...exactSources, ...relatedInitialSources].map(source => [source.id, source]));
    const expandedSources = await sectionSources(config, [...new Set(relatedInitialSources.map(source => source.section))], post, signal, trace);
    if (expandedSources === null) return { answer: SECTION_TOO_LARGE, sources: [] };
    for (const source of expandedSources) {
      const previous = byId.get(source.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new Error('Conflicting source document');
      byId.set(source.id, source);
    }
    const sources = [...byId.values()].sort(sourceOrder);
    if (sources.length > MAX_SOURCES) return { answer: SECTION_TOO_LARGE, sources: [] };
    safeTrace(trace, { stage: 'context', sourceChunkIds: sources.map(source => source.id) });
    if (exactSources.length && requestsVerbatimSection(question)) {
      // A quoted full-section request must return every supplied row, even when
      // a generative summary would choose only representative examples.
      return { answer: sources.map(source => source.excerpt).join('\n\n'), sources };
    }
    // Use a replacement callback so literal "$&" etc. in source text stay data.
    const system = PROMPT.replace('{context}', () => sources.map(s => s.excerpt).join('\n\n'));
    const completion = await post('completion', 'https://api.openai.com/v1/chat/completions', auth,
      { model: CHAT_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        temperature: 0, max_completion_tokens: config.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
        stream: false, store: false }, signal);
    const choice = completion?.choices?.[0];
    const answer = choice?.message?.content;
    if (completion?.choices?.length !== 1 || choice.finish_reason !== 'stop' || choice.message?.refusal || choice.message?.tool_calls?.length ||
        typeof answer !== 'string' || !answer.trim() || answer.length > 20000) throw new Error('Invalid or incomplete completion');
    return { answer, sources };
  };
}
