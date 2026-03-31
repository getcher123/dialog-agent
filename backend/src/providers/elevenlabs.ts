import { env } from "../config/env.js";
import { normalizeLanguageTag } from "../language.js";

export interface TtsChunkInfo {
  sequence: number;
  totalBytes: number;
}

export interface TtsStreamResult {
  mimeType: string;
  firstByteMs: number;
  totalMs: number;
  totalBytes: number;
  endpointHost: string;
  servedRegion?: string;
  language?: string;
  voiceId: string;
  modelId: string;
  fallbackUsed: boolean;
}

interface StreamElevenLabsTtsOptions {
  text: string;
  language?: string;
  onChunk?: (chunk: Buffer, info: TtsChunkInfo) => void;
}

export async function streamElevenLabsTts(
  options: StreamElevenLabsTtsOptions
): Promise<TtsStreamResult> {
  const apiKey = env.ELEVENLABS_API;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API is not configured");
  }

  if (!env.ELEVENLABS_VOICE_ID) {
    throw new Error("ELEVENLABS_VOICE_ID is not configured");
  }

  const requestedLanguage = normalizeLanguageTag(options.language);
  const primaryProfile = resolveTtsProfile(requestedLanguage);

  try {
    return await streamWithProfile(primaryProfile, options, apiKey);
  } catch (error) {
    const fallbackProfile = resolveTtsProfile(undefined);

    if (
      !requestedLanguage ||
      profilesMatch(primaryProfile, fallbackProfile) ||
      !isRetriableLanguageRoutingError(error)
    ) {
      throw error;
    }

    const retried = await streamWithProfile(fallbackProfile, options, apiKey);
    return {
      ...retried,
      fallbackUsed: true
    };
  }
}

interface TtsProfile {
  language?: string;
  voiceId: string;
  modelId: string;
  languageCode?: string;
}

async function streamWithProfile(
  profile: TtsProfile,
  options: StreamElevenLabsTtsOptions,
  apiKey: string
): Promise<TtsStreamResult> {
  const baseUrl = env.ELEVENLABS_BASE_URL.replace(/\/$/, "");
  const endpointHost = new URL(baseUrl).host;
  const startedAt = Date.now();
  const requestBody: Record<string, string> = {
    text: options.text,
    model_id: profile.modelId,
    output_format: "mp3_44100_128"
  };

  if (profile.languageCode) {
    requestBody.language_code = profile.languageCode;
  }

  const response = await fetch(
    `${baseUrl}/v1/text-to-speech/${encodeURIComponent(profile.voiceId)}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg"
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000)
    }
  );

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorText.slice(0, 500)}`);
  }

  const servedRegion = response.headers.get("x-region")?.trim() || undefined;
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
    totalBytes,
    endpointHost,
    servedRegion,
    language: profile.language,
    voiceId: profile.voiceId,
    modelId: profile.modelId,
    fallbackUsed: false
  };
}

function resolveTtsProfile(language?: string): TtsProfile {
  const normalized = normalizeLanguageTag(language);
  const languageSuffix = normalized?.toUpperCase();
  const configuredVoiceId =
    pickNonEmptyEnv(languageSuffix ? `ELEVENLABS_VOICE_ID_${languageSuffix}` : undefined) ??
    env.ELEVENLABS_VOICE_ID;
  const configuredModelId =
    pickNonEmptyEnv(languageSuffix ? `ELEVENLABS_MODEL_ID_${languageSuffix}` : undefined) ??
    (normalized && normalized !== "en" ? env.ELEVENLABS_MULTILINGUAL_MODEL_ID : env.ELEVENLABS_MODEL_ID);

  if (!configuredVoiceId) {
    throw new Error("ELEVENLABS_VOICE_ID is not configured");
  }

  return {
    language: normalized,
    voiceId: configuredVoiceId,
    modelId: configuredModelId,
    languageCode: normalized && normalized !== "en" ? normalized : undefined
  };
}

function profilesMatch(left: TtsProfile, right: TtsProfile): boolean {
  return (
    left.voiceId === right.voiceId &&
    left.modelId === right.modelId &&
    left.languageCode === right.languageCode
  );
}

function isRetriableLanguageRoutingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /ElevenLabs TTS failed:/i.test(error.message);
}

function pickNonEmptyEnv(name?: string): string | undefined {
  if (!name) {
    return undefined;
  }

  const value = process.env[name]?.trim();
  return value || undefined;
}
