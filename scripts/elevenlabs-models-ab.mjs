import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const voiceId = process.env.ELEVENLABS_VOICE_ID;
const apiKey = process.env.ELEVENLABS_API;

if (!voiceId) {
  throw new Error("ELEVENLABS_VOICE_ID is empty");
}

if (!apiKey) {
  throw new Error("ELEVENLABS_API is empty");
}

const text =
  "This is a direct latency comparison between ElevenLabs Flash and Turbo models for the voice agent.";

const models = [
  "eleven_flash_v2_5",
  "eleven_turbo_v2_5"
];

const artifactsDir = path.resolve(process.cwd(), "docs/validation/artifacts");
const reportPath = path.resolve(process.cwd(), "docs/validation/elevenlabs-models-ab.md");

await fs.mkdir(artifactsDir, { recursive: true });

const results = [];

for (const model of models) {
  const startedAt = Date.now();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: model,
        output_format: "mp3_44100_128"
      }),
      signal: AbortSignal.timeout(25000)
    }
  );
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    const errorText = await response.text();
    results.push({
      model,
      status: "failed",
      latencyMs: "-",
      bytes: "-",
      detail: `${response.status}: ${errorText.slice(0, 300)}`
    });
    continue;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const artifactPath = path.join(artifactsDir, `${model}.mp3`);
  await fs.writeFile(artifactPath, buffer);

  results.push({
    model,
    status: "passed",
    latencyMs,
    bytes: buffer.byteLength,
    detail: `[${model}](/mnt/c/Dialog-agent/docs/validation/artifacts/${model}.mp3)`
  });
}

const lines = [
  "# ElevenLabs Flash vs Turbo",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `Voice ID: ${voiceId}`,
  "",
  "| Model | Status | Latency ms | Bytes | Artifact / Detail |",
  "|---|---|---:|---:|---|"
];

for (const result of results) {
  lines.push(
    `| ${result.model} | ${result.status} | ${result.latencyMs} | ${result.bytes} | ${escapeCell(result.detail)} |`
  );
}

const flash = results.find((result) => result.model === "eleven_flash_v2_5");
const turbo = results.find((result) => result.model === "eleven_turbo_v2_5");

if (
  flash?.status === "passed" &&
  turbo?.status === "passed" &&
  typeof flash.latencyMs === "number" &&
  typeof turbo.latencyMs === "number"
) {
  lines.push("");
  lines.push(`Winner by latency: ${flash.latencyMs <= turbo.latencyMs ? "Flash" : "Turbo"}`);
  lines.push(
    `Latency delta: ${Math.abs(flash.latencyMs - turbo.latencyMs)} ms`
  );
}

await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");

console.log(JSON.stringify(results, null, 2));

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}
