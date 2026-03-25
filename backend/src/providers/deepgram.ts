import WebSocket from "ws";

import { env } from "../config/env.js";
import { normalizeLanguageTag } from "../language.js";

export interface DeepgramFinalSegment {
  text: string;
  speechFinal: boolean;
  dominantLanguage?: string;
  languages: string[];
}

export interface DeepgramCallbacks {
  onPartial: (text: string) => void;
  onFinalSegment: (segment: DeepgramFinalSegment) => void;
  onError: (message: string) => void;
  onOpen?: () => void;
}

export function connectDeepgramStream(
  sampleRate: number,
  callbacks: DeepgramCallbacks
): WebSocket {
  if (!env.DEEPGRAM_API) {
    throw new Error("DEEPGRAM_API is not configured");
  }

  const params = new URLSearchParams({
    model: "nova-3-general",
    encoding: "linear16",
    sample_rate: String(sampleRate),
    channels: "1",
    language: "multi",
    smart_format: "true",
    interim_results: "true",
    endpointing: "100",
    utterance_end_ms: "1000",
    vad_events: "true"
  });

  const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
    headers: {
      Authorization: `Token ${env.DEEPGRAM_API}`
    }
  });

  socket.on("open", () => {
    callbacks.onOpen?.();
  });

  socket.on("message", (raw) => {
    const text = typeof raw === "string" ? raw : raw.toString();

    try {
      const event = JSON.parse(text);

      if (event.type === "UtteranceEnd") {
        callbacks.onFinalSegment({
          text: "",
          speechFinal: true,
          languages: []
        });
        return;
      }

      if (event.type !== "Results") {
        return;
      }

      const alternative = event.channel?.alternatives?.[0];
      const transcript = typeof alternative?.transcript === "string" ? alternative.transcript : "";
      const isFinal = Boolean(event.is_final);
      const speechFinal = Boolean(event.speech_final);
      const { dominantLanguage, languages } = extractLanguages(alternative);

      if (isFinal || speechFinal) {
        callbacks.onFinalSegment({
          text: transcript,
          speechFinal,
          dominantLanguage,
          languages
        });
        return;
      }

      if (transcript) {
        callbacks.onPartial(transcript);
      }
    } catch (error) {
      callbacks.onError(error instanceof Error ? error.message : "Deepgram parse error");
    }
  });

  socket.on("error", (error) => {
    callbacks.onError(error instanceof Error ? error.message : "Deepgram socket error");
  });

  return socket;
}

function extractLanguages(alternative: unknown): {
  dominantLanguage?: string;
  languages: string[];
} {
  if (!alternative || typeof alternative !== "object") {
    return {
      dominantLanguage: undefined,
      languages: []
    };
  }

  const candidate = alternative as {
    languages?: unknown;
    words?: unknown;
  };

  const wordLanguageCounts = new Map<string, number>();
  if (Array.isArray(candidate.words)) {
    for (const item of candidate.words) {
      if (!item || typeof item !== "object") {
        continue;
      }

      const language = normalizeLanguageTag(
        "language" in item && typeof item.language === "string" ? item.language : undefined
      );
      if (!language) {
        continue;
      }

      wordLanguageCounts.set(language, (wordLanguageCounts.get(language) ?? 0) + 1);
    }
  }

  const rankedWordLanguages = [...wordLanguageCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([language]) => language);

  if (rankedWordLanguages.length > 0) {
    return {
      dominantLanguage: rankedWordLanguages[0],
      languages: rankedWordLanguages
    };
  }

  if (Array.isArray(candidate.languages)) {
    const languages = candidate.languages
      .map((value) => (typeof value === "string" ? normalizeLanguageTag(value) : undefined))
      .filter((value): value is string => Boolean(value));

    return {
      dominantLanguage: languages[0],
      languages
    };
  }

  return {
    dominantLanguage: undefined,
    languages: []
  };
}
