import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import ffmpegPath from "ffmpeg-static";

const inputPath =
  process.argv[2] ||
  "/mnt/c/Users/Ivan/Downloads/audio_2026-03-24_15-15-24.ogg";

const pcmPath = path.resolve(
  process.cwd(),
  "docs/validation/artifacts/stt-compare-input.pcm"
);
const reportPath = path.resolve(
  process.cwd(),
  "docs/validation/stt-streaming-comparison.md"
);

const env = {
  DEEPGRAM_API: process.env.DEEPGRAM_API,
  ELEVENLABS_API: process.env.ELEVENLABS_API
};

requireEnv("DEEPGRAM_API");
requireEnv("ELEVENLABS_API");

await fs.mkdir(path.dirname(pcmPath), { recursive: true });
await convertToPcm(inputPath, pcmPath);

const pcm = await fs.readFile(pcmPath);
const bytesPer100ms = 16000 * 2 * 0.1;

const deepgram = await measureDeepgram(pcm, bytesPer100ms);
const elevenlabs = await measureElevenLabsScribe(pcm, bytesPer100ms);

const lines = [
  "# STT Streaming Comparison",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  `Input source: ${inputPath}`,
  "",
  "| Service | Status | First event ms | Completed ms | Transcript |",
  "|---|---|---:|---:|---|",
  `| Deepgram streaming | ${deepgram.status} | ${deepgram.firstEventMs} | ${deepgram.completedMs} | ${escapeCell(deepgram.transcript)} |`,
  `| ElevenLabs Scribe Realtime v2 | ${elevenlabs.status} | ${elevenlabs.firstEventMs} | ${elevenlabs.completedMs} | ${escapeCell(elevenlabs.transcript)} |`,
  "",
  "Notes:",
  "- Both services received the same PCM 16kHz mono stream generated from the provided audio file.",
  "- Audio was paced in 100ms chunks to approximate live streaming instead of batch upload.",
  "- These are single-run indicative timings from the current environment."
];

await fs.writeFile(reportPath, `${lines.join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      deepgram,
      elevenlabs
    },
    null,
    2
  )
);

async function convertToPcm(sourcePath, targetPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y",
      "-i",
      sourcePath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      targetPath
    ]);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function measureDeepgram(pcm, chunkSize) {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new WebSocket(
      "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&language=ru&smart_format=true&interim_results=true",
      {
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API}`
        }
      }
    );

    let firstEventMs = null;
    let transcript = "";
    let finalized = false;

    socket.once("error", (error) => {
      if (!finalized) {
        finalized = true;
        reject(error);
      }
    });

    socket.once("open", async () => {
      try {
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
          socket.send(pcm.subarray(offset, offset + chunkSize));
          await sleep(100);
        }

        socket.send(JSON.stringify({ type: "Finalize" }));
      } catch (error) {
        if (!finalized) {
          finalized = true;
          reject(error);
        }
      }
    });

    socket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();

      try {
        const event = JSON.parse(text);

        if (event.type !== "Results") {
          return;
        }

        if (!firstEventMs) {
          firstEventMs = Date.now() - startedAt;
        }

        const nextTranscript = event.channel?.alternatives?.[0]?.transcript ?? "";
        if (nextTranscript) {
          transcript = nextTranscript;
        }

        if ((event.is_final || event.speech_final) && !finalized) {
          finalized = true;
          socket.close();
          resolve({
            status: "passed",
            firstEventMs: firstEventMs ?? "-",
            completedMs: Date.now() - startedAt,
            transcript: transcript || "empty transcript"
          });
        }
      } catch {
        // ignore malformed frames
      }
    });

    setTimeout(() => {
      if (!finalized) {
        finalized = true;
        socket.close();
        resolve({
          status: "timeout",
          firstEventMs: firstEventMs ?? "-",
          completedMs: Date.now() - startedAt,
          transcript: transcript || "empty transcript"
        });
      }
    }, 45000);
  });
}

async function measureElevenLabsScribe(pcm, chunkSize) {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = new WebSocket(
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&language_code=ru&commit_strategy=manual",
      {
        headers: {
          "xi-api-key": env.ELEVENLABS_API
        }
      }
    );

    let firstEventMs = null;
    let transcript = "";
    let finalized = false;

    socket.once("error", (error) => {
      if (!finalized) {
        finalized = true;
        reject(error);
      }
    });

    socket.once("open", async () => {
      try {
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
          const chunk = pcm.subarray(offset, offset + chunkSize);
          const isLast = offset + chunkSize >= pcm.length;
          socket.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: chunk.toString("base64"),
              sample_rate: 16000,
              commit: isLast
            })
          );
          await sleep(100);
        }
      } catch (error) {
        if (!finalized) {
          finalized = true;
          reject(error);
        }
      }
    });

    socket.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();

      try {
        const event = JSON.parse(text);

        if (
          event.message_type === "partial_transcript" ||
          event.message_type === "committed_transcript" ||
          event.message_type === "committed_transcript_with_timestamps"
        ) {
          if (!firstEventMs) {
            firstEventMs = Date.now() - startedAt;
          }

          if (event.text) {
            transcript = event.text;
          }

          if (
            (event.message_type === "committed_transcript" ||
              event.message_type === "committed_transcript_with_timestamps") &&
            !finalized
          ) {
            finalized = true;
            socket.close();
            resolve({
              status: "passed",
              firstEventMs: firstEventMs ?? "-",
              completedMs: Date.now() - startedAt,
              transcript: transcript || "empty transcript"
            });
          }
        }
      } catch {
        // ignore malformed frames
      }
    });

    setTimeout(() => {
      if (!finalized) {
        finalized = true;
        socket.close();
        resolve({
          status: "timeout",
          firstEventMs: firstEventMs ?? "-",
          completedMs: Date.now() - startedAt,
          transcript: transcript || "empty transcript"
        });
      }
    }, 45000);
  });
}

function requireEnv(name) {
  if (!env[name]) {
    throw new Error(`${name} is empty`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}
