import { env } from "../config/env.js";

export interface TtsResult {
  audioBuffer: Buffer;
  mimeType: string;
  firstByteMs: number;
  totalMs: number;
}

export async function streamElevenLabsTts(text: string): Promise<TtsResult> {
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
        text,
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
  const chunks: Uint8Array[] = [];
  let firstByteMs = 0;
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!firstByteMs) {
      firstByteMs = Date.now() - startedAt;
    }

    chunks.push(value);
    totalLength += value.byteLength;
  }

  const audioBuffer = Buffer.allocUnsafe(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    audioBuffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    audioBuffer,
    mimeType: "audio/mpeg",
    firstByteMs,
    totalMs: Date.now() - startedAt
  };
}

