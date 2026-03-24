import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const reportPath = path.resolve(
  process.cwd(),
  "docs/validation/provider-smoke-results.md"
);

const env = {
  DEEPGRAM_API: process.env.DEEPGRAM_API,
  GROQ_API: process.env.GROQ_API,
  ELEVENLABS_API: process.env.ELEVENLABS_API,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || "voice-agent-rag"
};

const results = [];

await runTest("OpenAI embeddings", async () => {
  requireEnv("OPENAI_API_KEY");

  const response = await fetchWithTimeout("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: "provider smoke test"
    })
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(extractError(body, response.status));
  }

  return {
    endpoint: "POST /v1/embeddings",
    detail: `embedding length ${body.data?.[0]?.embedding?.length ?? "unknown"}`
  };
});

await runTest("Groq API", async () => {
  requireEnv("GROQ_API");

  const response = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.GROQ_API}`
    }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(extractError(body, response.status));
  }

  const modelCount = Array.isArray(body.data) ? body.data.length : 0;

  return {
    endpoint: "GET /openai/v1/models",
    detail: `models visible ${modelCount}`
  };
});

await runTest("Deepgram API", async () => {
  requireEnv("DEEPGRAM_API");

  const response = await fetchWithTimeout("https://api.deepgram.com/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API}`
    }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(extractError(body, response.status));
  }

  return {
    endpoint: "GET /v1/models",
    detail: `stt models ${Array.isArray(body.stt) ? body.stt.length : 0}`
  };
});

await runTest("ElevenLabs API", async () => {
  requireEnv("ELEVENLABS_API");

  const response = await fetchWithTimeout("https://api.elevenlabs.io/v1/models", {
    method: "GET",
    headers: {
      "xi-api-key": env.ELEVENLABS_API
    }
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(extractError(body, response.status));
  }

  const models = Array.isArray(body) ? body.length : Array.isArray(body.models) ? body.models.length : 0;

  return {
    endpoint: "GET /v1/models",
    detail: `models visible ${models}`
  };
});

await runTest("ElevenLabs voice id", async () => {
  requireEnv("ELEVENLABS_API");

  if (!env.ELEVENLABS_VOICE_ID) {
    return {
      skipped: true,
      endpoint: "GET /v1/voices/:voice_id",
      detail: "ELEVENLABS_VOICE_ID is empty"
    };
  }

  const response = await fetchWithTimeout(
    `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}`,
    {
      method: "GET",
      headers: {
        "xi-api-key": env.ELEVENLABS_API
      }
    }
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(extractError(body, response.status));
  }

  return {
    endpoint: "GET /v1/voices/:voice_id",
    detail: `voice '${body.name ?? "unknown"}' resolved`
  };
});

await runTest("Qdrant local", async () => {
  const response = await fetchWithTimeout(`${env.QDRANT_URL.replace(/\/$/, "")}/readyz`, {
    method: "GET",
    headers: {
      Accept: "text/plain"
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${body.slice(0, 500)}`);
  }

  return {
    endpoint: "GET /readyz",
    detail: `${body.trim() || "ready"}; collection ${env.QDRANT_COLLECTION}`
  };
});

await writeReport();

const hasFailures = results.some((result) => result.status === "failed");
process.exitCode = hasFailures ? 1 : 0;

async function runTest(name, executor) {
  try {
    const output = await executor();
    results.push({
      name,
      status: output?.skipped ? "skipped" : "passed",
      endpoint: output?.endpoint ?? "-",
      detail: output?.detail ?? "-"
    });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      endpoint: "-",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

function requireEnv(name) {
  if (!env[name]) {
    throw new Error(`${name} is empty`);
  }
}

async function fetchWithTimeout(url, options) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000)
  });
}

function extractError(body, status) {
  if (body?.detail?.message) {
    return `${status}: ${body.detail.message}`;
  }

  if (body?.error?.message) {
    return `${status}: ${body.error.message}`;
  }

  if (body?.message) {
    return `${status}: ${body.message}`;
  }

  return `HTTP ${status}`;
}

async function writeReport() {
  const timestamp = new Date().toISOString();
  const lines = [
    "# Provider Smoke Results",
    "",
    `Generated: ${timestamp}`,
    "",
    "| Provider | Status | Endpoint | Detail |",
    "|---|---|---|---|"
  ];

  for (const result of results) {
    lines.push(
      `| ${escapeCell(result.name)} | ${result.status} | ${escapeCell(result.endpoint)} | ${escapeCell(result.detail)} |`
    );
  }

  lines.push("");
  lines.push("Notes:");
  lines.push("- Secrets are intentionally not printed in this report.");
  lines.push("- This is a control-plane smoke check, not a full end-to-end voice pipeline validation.");

  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}
