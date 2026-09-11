import fs from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const env = { ...parseEnv(await fs.readFile('.env', 'utf8')), ...process.env };
const base = env.SMOKE_BASE_URL || 'http://127.0.0.1:3310/betancourt';
if (!env.PILOT_TOKEN) throw new Error('PILOT_TOKEN is required');
const cases = (await fs.readFile('tests/questions.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
const selected = process.argv.includes('--all') ? cases : cases.filter(q => ['Q03', 'Q04', 'Q05', 'Q06', 'Q09'].includes(q.id));
const intervalMs = Number(env.SMOKE_INTERVAL_MS || 30000);
if (!Number.isInteger(intervalMs) || intervalMs < 13000) throw new Error('SMOKE_INTERVAL_MS must be an integer of at least 13000');
const health = await fetch(`${base}/healthz`);
if (!health.ok) throw new Error(`Health: HTTP ${health.status}`);
const denied = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"test"}' });
if (denied.status !== 401) throw new Error(`Unauthenticated request: HTTP ${denied.status}`);
await fs.mkdir('reports', { recursive: true });
const report = `reports/live-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
await fs.writeFile(report, '', { mode: 0o600 });
let failed = 0;
for (let i = 0; i < selected.length; i++) {
  if (i) await sleep(intervalMs); // Stay below request and provider token limits.
  const started = Date.now();
  const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.PILOT_TOKEN}` }, body: JSON.stringify({ message: selected[i].question }), signal: AbortSignal.timeout(65000) });
  const result = await response.json();
  const ok = response.status === 200 && typeof result.answer === 'string' && Array.isArray(result.sources) && result.sources.length <= 8;
  if (!ok) failed++;
  const record = { id: selected[i].id, question: selected[i].question, status: response.status, durationMs: Date.now() - started, ...result };
  await fs.appendFile(report, JSON.stringify(record) + '\n');
  console.log(JSON.stringify({ id: record.id, status: record.status, durationMs: record.durationMs, sources: record.sources?.map(s => s.id) }));
}
console.log(JSON.stringify({ report, total: selected.length, technicalFailures: failed, semanticReview: 'REQUIRED: inspect private answers against the original acceptance cases' }));
if (failed) process.exitCode = 1;
