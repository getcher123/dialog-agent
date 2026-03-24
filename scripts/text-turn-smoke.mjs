import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

import { streamElevenLabsTts } from "../backend/dist/providers/elevenlabs.js";
import { streamGroqCompletion } from "../backend/dist/providers/groq.js";
import { embedText, embedTexts } from "../backend/dist/providers/openaiEmbeddings.js";
import {
  chunkMarkdown,
  deleteKnowledgeBySource,
  ensureCollection,
  searchKnowledge,
  upsertKnowledge
} from "../backend/dist/providers/qdrant.js";

const sourcePath =
  process.env.RAG_SOURCE_PATH || path.resolve(process.cwd(), "docs/content/rag-source.md");
const question =
  process.env.TEXT_TURN_QUESTION || "Как быстро изготавливаются коронки и мосты?";
const source = "text-turn-smoke";
const reportPath = path.resolve(process.cwd(), "docs/validation/text-turn-smoke.md");

const markdown = await fs.readFile(sourcePath, "utf8");
const chunks = chunkMarkdown(markdown.slice(0, 18000), source);

await ensureCollection();
await deleteKnowledgeBySource(source);

const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));
await upsertKnowledge(
  source,
  chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? embeddings[0]
  }))
);

const queryEmbedding = await embedText(question);
const matches = (await searchKnowledge(queryEmbedding, 3)).filter((item) => item.source === source);
const context = matches.map((match) => `[chunk-${match.ordinal + 1}]\n${match.text}`).join("\n\n");
const answer = await streamGroqCompletion({
  systemPrompt: [
    "Ты отвечаешь как голосовой RAG-ассистент.",
    "Отвечай кратко и на языке пользователя.",
    "Используй контекст ниже, если он релевантен.",
    "Если контекста не хватает, скажи об этом прямо.",
    "Если ссылаешься на источник, используй формат [chunk-N].",
    "",
    "Контекст:",
    context || "Контекст не найден."
  ].join("\n"),
  userPrompt: question,
  onDelta: () => {}
});
const tts = await streamElevenLabsTts(answer.text);

const lines = [
  "# Text Turn Smoke",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `Source: ${sourcePath}`,
  `Question: ${question}`,
  "",
  "| Field | Value |",
  "|---|---|",
  `| Chunk count | ${chunks.length} |`,
  `| Retrieved chunks | ${matches.map((match) => `chunk-${match.ordinal + 1}`).join(", ") || "none"} |`,
  `| Answer | ${escapeCell(answer.text)} |`,
  `| TTS bytes | ${tts.audioBuffer.byteLength} |`,
  `| TTS first byte ms | ${tts.firstByteMs} |`,
  `| TTS total ms | ${tts.totalMs} |`,
  "",
  "Top matches:",
  "",
  "| Chunk | Score | Preview |",
  "|---|---:|---|",
  ...matches.map(
    (match) =>
      `| chunk-${match.ordinal + 1} | ${match.score.toFixed(3)} | ${escapeCell(match.text.slice(0, 140))} |`
  ),
  ""
];

await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      chunks: chunks.length,
      answer: answer.text,
      matches: matches.map((match) => ({
        ordinal: match.ordinal,
        score: Number(match.score.toFixed(3))
      })),
      ttsBytes: tts.audioBuffer.byteLength,
      ttsFirstByteMs: tts.firstByteMs,
      ttsTotalMs: tts.totalMs
    },
    null,
    2
  )
);

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}
