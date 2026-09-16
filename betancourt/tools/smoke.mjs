import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const env = { ...parseEnv(await fs.readFile('.env', 'utf8')), ...process.env };
const base = env.SMOKE_BASE_URL || 'http://127.0.0.1:3310/betancourt';
if (!env.PILOT_TOKEN) throw new Error('PILOT_TOKEN is required');
const questionsFile = path.resolve(option('--questions') ?? 'tests/questions.jsonl');
const reportDirectory = path.resolve(option('--report-dir') ?? 'reports');
const cases = (await fs.readFile(questionsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const requestedIds = option('--ids')?.split(',').map(value => value.trim()).filter(Boolean);
const selected = process.argv.includes('--all') ? cases : requestedIds ? cases.filter(q => requestedIds.includes(q.id))
  : cases.filter(q => ['Q03', 'Q04', 'Q05', 'Q06', 'Q09'].includes(q.id));
if (!selected.length) throw new Error('No selected questions');
if (requestedIds && selected.length !== requestedIds.length) throw new Error('One or more requested question IDs were not found');
const intervalMs = Number(env.SMOKE_INTERVAL_MS || 13000);
if (!Number.isInteger(intervalMs) || intervalMs < 13000) throw new Error('SMOKE_INTERVAL_MS must be an integer of at least 13000');
const health = await fetch(`${base}/healthz`);
if (!health.ok) throw new Error(`Health: HTTP ${health.status}`);
const denied = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"test"}' });
if (denied.status !== 401) throw new Error(`Unauthenticated request: HTTP ${denied.status}`);
await fs.mkdir(reportDirectory, { recursive: true, mode: 0o700 });
const report = path.join(reportDirectory, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const metadataPath = option('--metadata');
const metadata = metadataPath ? JSON.parse(await fs.readFile(path.resolve(metadataPath), 'utf8')) : {};
const header = { record: 'run', at: new Date().toISOString(), questionsFile, questionsSha256: createHash('sha256').update(await fs.readFile(questionsFile)).digest('hex'),
  selected: selected.length, intervalMs, base, ...metadata };
await fs.writeFile(report, JSON.stringify(header) + '\n', { mode: 0o600 });
let failed = 0;
for (let i = 0; i < selected.length; i++) {
  if (i) await sleep(intervalMs); // Stay below the configured IP and provider request limits.
  const started = Date.now();
  let result;
  let status = 0;
  let error;
  try {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PILOT_TOKEN}` },
      body: JSON.stringify({ message: selected[i].question }), signal: AbortSignal.timeout(65000) });
    status = response.status;
    result = await response.json();
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); result = {}; }
  const ok = status === 200 && typeof result.answer === 'string' && Array.isArray(result.sources) && result.sources.length <= 32;
  if (!ok) failed++;
  const record = { record: 'answer', id: selected[i].id, question: selected[i].question, status, durationMs: Date.now() - started,
    expectedFacts: selected[i].expected_facts ?? selected[i].required_facts ?? [], forbiddenClaims: selected[i].forbidden_claims ?? [],
    sourceRefs: selected[i].source_refs ?? [], expectedBehavior: selected[i].expected_behavior, ...result, ...(error ? { error } : {}) };
  await fs.appendFile(report, JSON.stringify(record) + '\n');
  console.log(JSON.stringify({ id: record.id, status: record.status, durationMs: record.durationMs, sources: record.sources?.map(source => source.id), error }));
}
console.log(JSON.stringify({ report, total: selected.length, technicalFailures: failed,
  semanticReview: 'REQUIRED: inspect every private answer against expected facts, forbidden claims and original evidence.' }));
if (failed) process.exitCode = 1;
