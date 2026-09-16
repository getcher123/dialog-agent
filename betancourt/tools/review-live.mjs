import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function normalized(value) {
  return String(value).toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const reportPath = path.resolve(option('--report'));
const cardsPath = path.resolve(option('--cards'));
const outputPath = path.resolve(option('--output'));
const cardsBytes = await fs.readFile(cardsPath);
const cardsSha256 = createHash('sha256').update(cardsBytes).digest('hex');
const cards = cardsBytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const byId = new Map(cards.map(card => [card.metadata.chunk_id, card]));
const cardSections = new Map();
for (const card of cards) {
  const list = cardSections.get(card.metadata.section) ?? [];
  list.push(card.metadata.chunk_id);
  cardSections.set(card.metadata.section, list);
}
const records = (await fs.readFile(reportPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const run = records.find(record => record.record === 'run');
if (!run) throw new Error('Missing run record');
const answers = records.filter(record => record.record === 'answer');
const review = answers.map(record => {
  const sourceIds = record.sources?.map(source => source.id) ?? [];
  const sourceProblems = [];
  for (const source of record.sources ?? []) {
    const card = byId.get(source.id);
    if (!card || source.section !== card.metadata.section || source.excerpt !== card.content) sourceProblems.push(source.id);
  }
  const expectedSections = new Set(cards.filter(card => record.sourceRefs?.some(ref => card.metadata.source_refs.includes(ref)))
    .map(card => card.metadata.section));
  const listMissing = record.expectedBehavior && /all|full|complete|перечисли/i.test(`${record.expectedBehavior} ${record.question}`)
    ? [...expectedSections].flatMap(section => cardSections.get(section) ?? []).filter(id => !sourceIds.includes(id)) : [];
  const answer = normalized(record.answer);
  const expectedMissing = (record.expectedFacts ?? []).filter(fact => !String(fact).split(/[;|]/).map(normalized)
    .every(part => !part || answer.includes(part)));
  const forbiddenMentioned = (record.forbiddenClaims ?? []).filter(claim => {
    const value = normalized(claim);
    return value.length > 4 && answer.includes(value);
  });
  return { id: record.id, status: record.status, durationMs: record.durationMs, sourceIds, sourceProblems, listMissing,
    expectedMissing, forbiddenMentioned, genericDisclaimer: /актуальность сведений и правовых оснований не проверена/i.test(record.answer ?? ''),
    semanticReview: expectedMissing.length || forbiddenMentioned.length ? 'REQUIRED' : 'NO_LITERAL_MISMATCH' };
});
const technicalFailures = review.filter(item => item.status !== 200 || item.sourceProblems.length || item.sourceIds.length > 32 || item.genericDisclaimer);
const result = { report: reportPath, cards: cardsPath, cardsSha256, runCardsSha256: run.cards_sha256,
  answers: review.length, technicalFailures: technicalFailures.length, semanticReviewRequired: review.filter(item => item.semanticReview === 'REQUIRED').length, review };
await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await fs.writeFile(outputPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ answers: result.answers, technicalFailures: result.technicalFailures, semanticReviewRequired: result.semanticReviewRequired, output: outputPath }));
if (run.cards_sha256 && run.cards_sha256 !== cardsSha256) process.exitCode = 2;
if (technicalFailures.length) process.exitCode = 1;
