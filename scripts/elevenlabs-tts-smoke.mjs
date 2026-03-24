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

const outputDir = path.resolve(process.cwd(), "docs/validation/artifacts");
const audioPath = path.join(outputDir, "elevenlabs-tts-smoke.mp3");
const reportPath = path.resolve(process.cwd(), "docs/validation/elevenlabs-tts-smoke.md");

await fs.mkdir(outputDir, { recursive: true });

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
      text: "Privet. Eto korotkiy smoke test sinteza rechi dlya voice agent.",
      model_id: "eleven_flash_v2_5",
      output_format: "mp3_44100_128"
    }),
    signal: AbortSignal.timeout(20000)
  }
);

const latencyMs = Date.now() - startedAt;

if (!response.ok) {
  const text = await response.text();
  throw new Error(`${response.status}: ${text.slice(0, 800)}`);
}

const arrayBuffer = await response.arrayBuffer();
const audioBuffer = Buffer.from(arrayBuffer);
await fs.writeFile(audioPath, audioBuffer);

const report = [
  "# ElevenLabs TTS Smoke",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "| Field | Value |",
  "|---|---|",
  `| Status | passed |`,
  `| Voice ID | ${voiceId} |`,
  `| Model | eleven_flash_v2_5 |`,
  `| Format | mp3_44100_128 |`,
  `| Latency ms | ${latencyMs} |`,
  `| Bytes | ${audioBuffer.byteLength} |`,
  `| Artifact | [docs/validation/artifacts/elevenlabs-tts-smoke.mp3](/mnt/c/Dialog-agent/docs/validation/artifacts/elevenlabs-tts-smoke.mp3) |`,
  "",
  "Notes:",
  "- Secrets are not included in this report.",
  "- This validates real speech synthesis for the configured voice id."
];

await fs.writeFile(reportPath, `${report.join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      status: "passed",
      latencyMs,
      bytes: audioBuffer.byteLength,
      audioPath
    },
    null,
    2
  )
);
