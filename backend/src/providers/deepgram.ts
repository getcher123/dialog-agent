import WebSocket from "ws";

import { env } from "../config/env.js";

export interface DeepgramCallbacks {
  onPartial: (text: string) => void;
  onFinalSegment: (text: string, speechFinal: boolean) => void;
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
    smart_format: "true",
    interim_results: "true"
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

      if (event.type !== "Results") {
        return;
      }

      const transcript = event.channel?.alternatives?.[0]?.transcript ?? "";

      if (event.is_final) {
        callbacks.onFinalSegment(transcript, Boolean(event.speech_final));
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
