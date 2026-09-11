import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
const local = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
const child = spawn(process.env.PYTHON ?? '.venv/bin/python', ['tools/index_kb.py'], { cwd: new URL('../', import.meta.url), env: { ...process.env, ...local }, stdio: 'inherit' });
child.on('error', () => { console.error('Cannot start Python; create .venv and install requirements.txt, or set PYTHON.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
