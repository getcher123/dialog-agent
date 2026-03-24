import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const reportPath = path.resolve(
  process.cwd(),
  "docs/validation/provider-latency-results.md"
);
const artifactsDir = path.resolve(process.cwd(), "docs/validation/artifacts");

await fs.mkdir(artifactsDir, { recursive: true });

const env = {
  DEEPGRAM_API: process.env.DEEPGRAM_API,
  GROQ_API: process.env.GROQ_API,
  ELEVENLABS_API: process.env.ELEVENLABS_API,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID,
  DEEPGRAM_MEDIA_PATH: process.env.DEEPGRAM_MEDIA_PATH || process.argv[2] || "",
  QDRANT_URL: process.env.QDRANT_URL || "http://localhost:6333",
  QDRANT_COLLECTION: process.env.QDRANT_COLLECTION || "voice-agent-rag"
};

const results = [];
const runId = randomUUID();

let embeddingVector = null;
let deepgramAudioBuffer = null;
let deepgramContentType = "audio/mpeg";
let deepgramSource = "elevenlabs generated sample";
let chosenVoiceId = env.ELEVENLABS_VOICE_ID;
let chosenVoiceSource = "configured";

await measure("OpenAI embeddings", async () => {
  requireEnv("OPENAI_API_KEY");

  const response = await timedJsonFetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: "Latency smoke test for the voice agent retrieval pipeline."
    })
  });

  ensureOk(response);
  embeddingVector = response.body.data?.[0]?.embedding ?? null;

  return {
    detail: `embedding length ${embeddingVector?.length ?? "unknown"}`,
    latencyMs: response.latencyMs
  };
});

await measure("Qdrant upsert", async () => {
  if (!Array.isArray(embeddingVector)) {
    throw new Error("Embedding vector is not available");
  }

  await ensureQdrantCollection();

  const response = await timedJsonFetch(
    `${env.QDRANT_URL.replace(/\/$/, "")}/collections/${encodeURIComponent(env.QDRANT_COLLECTION)}/points?wait=true`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        points: [
        {
          id: runId,
          vector: embeddingVector,
          payload: {
            source: "provider-latency-smoke",
            runId
          }
        }
        ]
      })
    }
  );

  ensureOk(response);

  return {
    detail: `collection ${env.QDRANT_COLLECTION}`,
    latencyMs: response.latencyMs
  };
});

await measure("Qdrant query", async () => {
  if (!Array.isArray(embeddingVector)) {
    throw new Error("Embedding vector is not available");
  }

  const response = await timedJsonFetch(
    `${env.QDRANT_URL.replace(/\/$/, "")}/collections/${encodeURIComponent(env.QDRANT_COLLECTION)}/points/query`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: embeddingVector,
      limit: 1,
      with_payload: true
    })
    }
  );

  ensureOk(response);
  const matchId = response.body.result?.points?.[0]?.id ?? "none";

  return {
    detail: `top match ${matchId}`,
    latencyMs: response.latencyMs
  };
});

await measure("Groq completion", async () => {
  requireEnv("GROQ_API");

  const model = await resolveGroqModel();
  const response = await timedJsonFetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 48,
      messages: [
        {
          role: "system",
          content: "Answer in one short sentence."
        },
        {
          role: "user",
          content: "Say that the Groq latency smoke test is operational."
        }
      ]
    })
  });

  ensureOk(response);
  const text = response.body.choices?.[0]?.message?.content?.slice(0, 80) ?? "n/a";

  return {
    detail: `${model}: ${text}`,
    latencyMs: response.latencyMs
  };
});

await measure("ElevenLabs TTS", async () => {
  requireEnv("ELEVENLABS_API");

  const voice = await resolveWorkingElevenLabsVoice();
  const response = await timedBinaryFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: "This is a latency smoke test for the voice agent text to speech pipeline.",
        model_id: "eleven_flash_v2_5",
        output_format: "mp3_44100_128"
      })
    }
  );

  ensureOk(response);

  deepgramAudioBuffer = response.buffer;
  chosenVoiceId = voice.voiceId;
  chosenVoiceSource = voice.source;

  const audioArtifactPath = path.join(artifactsDir, "latency-smoke-elevenlabs.mp3");
  await fs.writeFile(audioArtifactPath, response.buffer);

  return {
    detail: `${voice.source} voice ${voice.voiceId}, ${response.buffer.byteLength} bytes`,
    latencyMs: response.latencyMs
  };
});

await measure("Deepgram STT", async () => {
  requireEnv("DEEPGRAM_API");

  if (env.DEEPGRAM_MEDIA_PATH) {
    if (!existsSync(env.DEEPGRAM_MEDIA_PATH)) {
      throw new Error(`Media file not found: ${env.DEEPGRAM_MEDIA_PATH}`);
    }

    deepgramAudioBuffer = await fs.readFile(env.DEEPGRAM_MEDIA_PATH);
    deepgramContentType = resolveContentType(env.DEEPGRAM_MEDIA_PATH);
    deepgramSource = env.DEEPGRAM_MEDIA_PATH;
  }

  if (!deepgramAudioBuffer) {
    throw new Error("Deepgram audio sample is not available");
  }

  const response = await timedJsonFetch(
    "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API}`,
        "Content-Type": deepgramContentType
      },
      body: deepgramAudioBuffer
    }
  );

  ensureOk(response);

  const transcript =
    response.body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.slice(0, 120) ?? "n/a";

  return {
    detail: `${transcript || "empty transcript"} (source: ${path.basename(deepgramSource)})`,
    latencyMs: response.latencyMs
  };
});

await writeReport();

const hasFailures = results.some((result) => result.status === "failed");
process.exitCode = hasFailures ? 1 : 0;

async function measure(name, executor) {
  try {
    const output = await executor();
    results.push({
      name,
      status: "passed",
      latencyMs: output.latencyMs,
      detail: output.detail
    });
  } catch (error) {
    results.push({
      name,
      status: "failed",
      latencyMs: "-",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

function requireEnv(name) {
  if (!env[name]) {
    throw new Error(`${name} is empty`);
  }
}

function ensureOk(response) {
  if (!response.ok) {
    throw new Error(extractError(response.body, response.status));
  }
}

async function timedJsonFetch(url, options) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(25000)
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const body = await response.json();

  return {
    ok: response.ok,
    status: response.status,
    body,
    latencyMs
  };
}

async function timedBinaryFetch(url, options) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(25000)
  });
  const latencyMs = Math.round(performance.now() - startedAt);

  if (!response.ok) {
    const text = await response.text();
    return {
      ok: false,
      status: response.status,
      body: safeJson(text),
      latencyMs,
      buffer: null
    };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    ok: true,
    status: response.status,
    body: {},
    latencyMs,
    buffer
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text.slice(0, 800)
    };
  }
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

async function ensureQdrantCollection() {
  const collectionUrl = `${env.QDRANT_URL.replace(/\/$/, "")}/collections/${encodeURIComponent(env.QDRANT_COLLECTION)}`;
  const existing = await fetch(collectionUrl, {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (existing.ok) {
    return;
  }

  if (existing.status !== 404) {
    throw new Error(`Qdrant collection check failed: ${existing.status}`);
  }

  const createResponse = await timedJsonFetch(collectionUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      vectors: {
        size: 1536,
        distance: "Cosine"
      }
    })
  });

  ensureOk(createResponse);
}

async function resolveGroqModel() {
  const response = await timedJsonFetch("https://api.groq.com/openai/v1/models", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.GROQ_API}`
    }
  });

  ensureOk(response);

  const names = Array.isArray(response.body.data)
    ? response.body.data.map((model) => model.id)
    : [];

  return (
    names.find((name) => name === "llama-3.3-70b-versatile") ||
    names.find((name) => name === "llama-3.1-8b-instant") ||
    names[0]
  );
}

async function resolveWorkingElevenLabsVoice() {
  requireEnv("ELEVENLABS_API");

  if (env.ELEVENLABS_VOICE_ID) {
    const configuredTest = await testElevenLabsVoice(env.ELEVENLABS_VOICE_ID);
    if (configuredTest.ok) {
      return {
        voiceId: env.ELEVENLABS_VOICE_ID,
        source: "configured"
      };
    }
  }

  const response = await timedJsonFetch("https://api.elevenlabs.io/v1/voices", {
    method: "GET",
    headers: {
      "xi-api-key": env.ELEVENLABS_API,
      Accept: "application/json"
    }
  });

  ensureOk(response);

  const voices = Array.isArray(response.body.voices) ? response.body.voices : [];
  const premadeVoice = voices.find((voice) => voice.category === "premade");

  if (!premadeVoice?.voice_id) {
    throw new Error("No accessible ElevenLabs premade voice found");
  }

  const fallbackTest = await testElevenLabsVoice(premadeVoice.voice_id);

  if (!fallbackTest.ok) {
    throw new Error(extractError(fallbackTest.body, fallbackTest.status));
  }

  return {
    voiceId: premadeVoice.voice_id,
    source: "fallback premade"
  };
}

async function testElevenLabsVoice(voiceId) {
  return timedBinaryFetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: "voice test",
        model_id: "eleven_flash_v2_5",
        output_format: "mp3_44100_128"
      })
    }
  );
}

async function writeReport() {
  const lines = [
    "# Provider Latency Results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Run id: ${runId}`,
    "",
    "| Service | Status | Latency ms | Detail |",
    "|---|---|---:|---|"
  ];

  for (const result of results) {
    lines.push(
      `| ${escapeCell(result.name)} | ${result.status} | ${result.latencyMs} | ${escapeCell(result.detail)} |`
    );
  }

  lines.push("");
  lines.push("Notes:");
  lines.push("- These are single-call indicative latencies from the current environment, not p95/p99 production metrics.");
  lines.push(`- ElevenLabs voice source used for synthesis: ${chosenVoiceSource}${chosenVoiceId ? ` (${chosenVoiceId})` : ""}.`);
  lines.push(`- Deepgram sample source used: ${deepgramSource}.`);
  lines.push("- Secrets are intentionally not included in this report.");

  await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}

function resolveContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  switch (extension) {
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".m4a":
      return "audio/mp4";
    case ".mp4":
      return "video/mp4";
    case ".ogg":
      return "audio/ogg";
    case ".webm":
      return "audio/webm";
    default:
      return "application/octet-stream";
  }
}
