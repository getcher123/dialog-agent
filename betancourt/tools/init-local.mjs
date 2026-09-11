import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const source = process.argv[2];
if (!source) throw new Error('Usage: node tools/init-local.mjs /absolute/path/to/authorized/.env');
const keys = parseEnv(await readFile(source, 'utf8'));
if (!keys.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is missing');
const fields = {
  OPENAI_API_KEY: keys.OPENAI_API_KEY,
  QDRANT_URL: 'http://127.0.0.1:6333',
  QDRANT_API_KEY: '', QDRANT_COLLECTION: '',
  PILOT_TOKEN: randomBytes(32).toString('base64url'),
  CHAT_ENABLED: 'false', ALLOWED_ORIGINS: 'http://127.0.0.1:3310', PORT: '3310',
};
const text = Object.entries(fields).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
await writeFile(new URL('../.env', import.meta.url), text, { flag: 'wx', mode: 0o600 });
console.log('Created private betancourt/.env; no secrets printed.');
