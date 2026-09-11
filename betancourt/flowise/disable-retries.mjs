import { readFileSync, writeFileSync } from 'node:fs';

// These pinned nodes do not expose the LangChain maxRetries option in their UI.
const root = '/usr/local/lib/node_modules/flowise/node_modules/flowise-components/dist/nodes/';
for (const path of ['chatmodels/ChatOpenAI/ChatOpenAI.js', 'embeddings/OpenAIEmbedding/OpenAIEmbedding.js']) {
  const file = root + path;
  const source = readFileSync(file, 'utf8');
  const marker = 'const obj = {';
  if (source.split(marker).length !== 2) throw new Error(`Unrecognized pinned node: ${path}`);
  writeFileSync(file, source.replace(marker, `${marker}\n            maxRetries: 0,`));
}
