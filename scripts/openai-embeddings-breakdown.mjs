import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is empty");
}

const url = "https://api.openai.com/v1/embeddings";
const payload = {
  model: "text-embedding-3-small",
  input: "Latency breakdown test for OpenAI embeddings in the voice agent pipeline."
};

const reportPath = path.resolve(
  process.cwd(),
  "docs/validation/openai-embeddings-breakdown.md"
);

const startedAt = Date.now();
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(30000)
});

const headersAt = Date.now();
const text = await response.text();
const completedAt = Date.now();

let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = null;
}

if (!response.ok) {
  throw new Error(`${response.status}: ${text.slice(0, 1000)}`);
}

const firstByteMs = headersAt - startedAt;
const totalMs = completedAt - startedAt;
const bodyReadMs = completedAt - headersAt;
const embeddingLength = parsed?.data?.[0]?.embedding?.length ?? "unknown";
const requestId =
  response.headers.get("x-request-id") ||
  response.headers.get("request-id") ||
  "n/a";

const lines = [
  "# OpenAI Embeddings Breakdown",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Metric | Value |",
  "|---|---:|",
  `| First byte ms | ${firstByteMs} |`,
  `| Total ms | ${totalMs} |`,
  `| Body read ms | ${bodyReadMs} |`,
  `| Embedding length | ${embeddingLength} |`,
  `| Response size bytes | ${Buffer.byteLength(text, "utf8")} |`,
  `| Request id | ${requestId} |`,
  "",
  "Notes:",
  "- `First byte ms` roughly includes DNS/TLS/connect/server processing until response headers.",
  "- `Body read ms` is the tail after headers until the full JSON body is consumed.",
  "- This is a single-run measurement from the current local environment."
];

await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      firstByteMs,
      totalMs,
      bodyReadMs,
      embeddingLength,
      requestId
    },
    null,
    2
  )
);
