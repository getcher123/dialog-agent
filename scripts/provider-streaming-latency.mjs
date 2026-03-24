import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const mediaPath =
  process.env.DEEPGRAM_MEDIA_PATH ||
  process.argv[2] ||
  "/mnt/c/Users/Ivan/Downloads/WhatsApp Video 2025-12-29 at 19.20.37.mp4";

const reportPath = path.resolve(
  process.cwd(),
  "docs/validation/provider-streaming-latency-results.md"
);

const env = {
  DEEPGRAM_API: process.env.DEEPGRAM_API,
  GROQ_API: process.env.GROQ_API,
  ELEVENLABS_API: process.env.ELEVENLABS_API,
  ELEVENLABS_VOICE_ID: process.env.ELEVENLABS_VOICE_ID
};

const results = [];

results.push({
  service: "OpenAI embeddings",
  status: "n/a",
  firstByteMs: "-",
  completedMs: "-",
  detail: "No streaming mode for embeddings endpoint"
});

results.push({
  service: "Pinecone vector DB",
  status: "n/a",
  firstByteMs: "-",
  completedMs: "-",
  detail: "No streaming mode for upsert/query endpoints"
});

await measure("Groq streamed completion", measureGroqStream);
await measure("ElevenLabs streamed TTS", measureElevenLabsStream);
await measure("Deepgram streamed STT", measureDeepgramStream);

await fs.writeFile(reportPath, renderReport(), "utf8");

const hasFailures = results.some((result) => result.status === "failed");
process.exitCode = hasFailures ? 1 : 0;

async function measure(name, executor) {
  try {
    const result = await executor();
    results.push({
      service: name,
      status: "passed",
      firstByteMs: result.firstByteMs,
      completedMs: result.completedMs,
      detail: result.detail
    });
  } catch (error) {
    results.push({
      service: name,
      status: "failed",
      firstByteMs: "-",
      completedMs: "-",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
}

async function measureGroqStream() {
  requireEnv("GROQ_API");

  const startedAt = Date.now();
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      stream: true,
      temperature: 0,
      max_tokens: 64,
      messages: [
        {
          role: "system",
          content: "Reply in one short sentence."
        },
        {
          role: "user",
          content: "Confirm the Groq streaming latency smoke test is working."
        }
      ]
    }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstByteMs = null;
  let completion = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!firstByteMs) {
      firstByteMs = Date.now() - startedAt;
    }

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (!line.startsWith("data: ")) {
        continue;
      }

      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") {
        continue;
      }

      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content ?? "";
        completion += delta;
      } catch {
        // Ignore partial SSE fragments.
      }
    }
  }

  return {
    firstByteMs: firstByteMs ?? "-",
    completedMs: Date.now() - startedAt,
    detail: completion.slice(0, 120) || "stream completed"
  };
}

async function measureElevenLabsStream() {
  requireEnv("ELEVENLABS_API");
  requireEnv("ELEVENLABS_VOICE_ID");

  const startedAt = Date.now();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(env.ELEVENLABS_VOICE_ID)}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": env.ELEVENLABS_API,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text: "This is a streaming latency smoke test for the ElevenLabs text to speech path.",
        model_id: "eleven_turbo_v2_5",
        output_format: "mp3_44100_128"
      }),
      signal: AbortSignal.timeout(25000)
    }
  );

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`${response.status}: ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  let firstByteMs = null;
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!firstByteMs) {
      firstByteMs = Date.now() - startedAt;
    }

    totalBytes += value.byteLength;
  }

  return {
    firstByteMs: firstByteMs ?? "-",
    completedMs: Date.now() - startedAt,
    detail: `${totalBytes} audio bytes streamed`
  };
}

async function measureDeepgramStream() {
  requireEnv("DEEPGRAM_API");

  const mediaBuffer = await fs.readFile(mediaPath);
  const startedAt = Date.now();

  return await new Promise((resolve, reject) => {
    const url =
      "wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true";
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API}`
      }
    });

    let firstResultMs = null;
    let finalResolved = false;
    let lastTranscript = "";

    socket.once("error", (error) => {
      if (!finalResolved) {
        finalResolved = true;
        reject(error);
      }
    });

    socket.once("open", async () => {
      try {
        const chunkSize = 16 * 1024;

        for (let offset = 0; offset < mediaBuffer.length; offset += chunkSize) {
          const chunk = mediaBuffer.subarray(offset, offset + chunkSize);
          socket.send(chunk);
        }

        socket.send(JSON.stringify({ type: "Finalize" }));
      } catch (error) {
        if (!finalResolved) {
          finalResolved = true;
          reject(error);
        }
      }
    });

    socket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();

      try {
        const event = JSON.parse(text);

        if (event.type === "Results") {
          if (!firstResultMs) {
            firstResultMs = Date.now() - startedAt;
          }

          const transcript =
            event.channel?.alternatives?.[0]?.transcript ||
            event.channel?.alternatives?.[0]?.words?.map((word) => word.word).join(" ") ||
            "";

          if (transcript) {
            lastTranscript = transcript;
          }

          if (event.is_final || event.speech_final) {
            if (!finalResolved) {
              finalResolved = true;
              socket.close();
              resolve({
                firstByteMs: firstResultMs ?? "-",
                completedMs: Date.now() - startedAt,
                detail: (lastTranscript || "empty transcript").slice(0, 120)
              });
            }
          }
        }

        if (event.type === "Metadata" && !firstResultMs) {
          firstResultMs = Date.now() - startedAt;
        }
      } catch {
        // Ignore non-JSON frames.
      }
    });

    setTimeout(() => {
      if (!finalResolved) {
        finalResolved = true;
        socket.close();
        resolve({
          firstByteMs: firstResultMs ?? "-",
          completedMs: Date.now() - startedAt,
          detail: (lastTranscript || "stream timeout with empty transcript").slice(0, 120)
        });
      }
    }, 30000);
  });
}

function renderReport() {
  const lines = [
    "# Provider Streaming Latency Results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Deepgram media source: ${mediaPath}`,
    "",
    "| Service | Status | First byte / first event ms | Completed ms | Detail |",
    "|---|---|---:|---:|---|"
  ];

  for (const result of results) {
    lines.push(
      `| ${escapeCell(result.service)} | ${result.status} | ${result.firstByteMs} | ${result.completedMs} | ${escapeCell(result.detail)} |`
    );
  }

  lines.push("");
  lines.push("Notes:");
  lines.push("- OpenAI embeddings and Pinecone are non-stream APIs, so they are marked as n/a.");
  lines.push("- Groq is measured as streamed SSE/chat completion.");
  lines.push("- ElevenLabs is measured via HTTP chunked audio stream.");
  lines.push("- Deepgram is measured via WebSocket streaming STT using the provided media file.");
  lines.push("- These are single-run indicative timings from the current environment.");

  return `${lines.join("\n")}\n`;
}

function requireEnv(name) {
  if (!env[name]) {
    throw new Error(`${name} is empty`);
  }
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}
