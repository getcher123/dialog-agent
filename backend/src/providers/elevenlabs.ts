import { env } from "../config/env.js";

export interface TtsChunkInfo {
  sequence: number;
  totalBytes: number;
}

export interface TtsStreamResult {
  mimeType: string;
  firstByteMs: number;
  totalMs: number;
  totalBytes: number;
}

interface StreamElevenLabsTtsOptions {
  text: string;
  onChunk?: (chunk: Buffer, info: TtsChunkInfo) => void;
}

export async function streamElevenLabsTts(
  options: StreamElevenLabsTtsOptions
): Promise<TtsStreamResult> {
  if (!env.ELEVENLABS_API) {
    throw new Error("ELEVENLABS_API is not configured");
  }

  if (!env.ELEVENLABS_VOICE_ID) {
    throw new Error("ELEVENLABS_VOICE_ID is not configured");
  }

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
        text: options.text,
        model_id: env.ELEVENLABS_MODEL_ID,
        output_format: "mp3_44100_128"
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorText.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  let firstByteMs = 0;
  let totalBytes = 0;
  let sequence = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!firstByteMs) {
      firstByteMs = Date.now() - startedAt;
    }

    const chunk = Buffer.from(value);
    totalBytes += chunk.byteLength;
    sequence += 1;

    options.onChunk?.(chunk, {
      sequence,
      totalBytes
    });
  }

  return {
    mimeType: "audio/mpeg",
    firstByteMs,
    totalMs: Date.now() - startedAt,
    totalBytes
  };
}
