import type WebSocket from "ws";

import {
  getLanguageDisplayName,
  inferLanguageFromText,
  normalizeLanguageTag
} from "../language.js";
import { log } from "../logging.js";
import type { ServerEvent } from "../protocol.js";
import { connectDeepgramStream } from "../providers/deepgram.js";
import { streamElevenLabsTts } from "../providers/elevenlabs.js";
import { streamGroqCompletion } from "../providers/groq.js";
import { embedText, embedTexts } from "../providers/openaiEmbeddings.js";
import {
  chunkMarkdown,
  deleteKnowledgeBySource,
  ensureCollection,
  searchKnowledge,
  upsertKnowledge
} from "../providers/qdrant.js";
import { PipelineTrace } from "../telemetry/pipelineTelemetry.js";

export interface RuntimeSessionState {
  sessionId: string;
  connection: WebSocket;
  sampleRate: number;
  knowledgeMarkdown: string;
  ragPrompt: string;
  finalSegments: string[];
  processing: Promise<void>;
  deepgram?: WebSocket;
  deepgramReady: boolean;
  pendingAudioChunks: Buffer[];
  lastAudioChunkAt?: number;
  detectedLanguage?: string;
}

type SendFn = (connection: WebSocket, event: ServerEvent) => void;
const SHARED_KNOWLEDGE_SOURCE = "shared-ui-knowledge";
export const DEFAULT_RAG_PROMPT = [
  "Ты отвечаешь как телефонный консультант.",
  "Используй контекст ниже, если он релевантен.",
  "Если контекста не хватает, скажи об этом прямо.",
  "Отвечай кратко, короткими односложными предложениями."
].join("\n");

export interface VoiceLatencyContext {
  voiceInputEndedAt: number;
  transcriptFinalizedAt: number;
}

export interface AssistantTurnContext {
  latencyContext?: VoiceLatencyContext;
  requestedLanguage?: string;
  languageSource?: "stt" | "text" | "session" | "default";
}

export interface FinalTranscriptContext extends VoiceLatencyContext {
  detectedLanguage?: string;
  detectedLanguages: string[];
}

interface KnowledgeIndexingProgress {
  stage: "chunking" | "embedding" | "storing";
  progressPercent: number;
  message: string;
}

export async function startSpeechRecognition(
  runtime: RuntimeSessionState,
  send: SendFn,
  onFinalTranscript: (transcript: string, context: FinalTranscriptContext) => void
): Promise<void> {
  runtime.deepgram?.close();
  runtime.deepgramReady = false;
  runtime.pendingAudioChunks = [];
  runtime.deepgram = connectDeepgramStream(runtime.sampleRate, {
    onOpen: () => {
      runtime.deepgramReady = true;

      for (const chunk of runtime.pendingAudioChunks) {
        runtime.deepgram?.send(chunk);
      }
      runtime.pendingAudioChunks = [];

      send(runtime.connection, {
        type: "server.status",
        sessionId: runtime.sessionId,
        phase: "connected",
        detail: `Deepgram stream connected for ${runtime.sampleRate} Hz PCM.`
      });
    },
    onPartial: (text) => {
      send(runtime.connection, {
        type: "server.status",
        sessionId: runtime.sessionId,
        phase: "listening",
        detail: "Speech detected. Inference starts automatically after a short pause in speech."
      });

      send(runtime.connection, {
        type: "transcript.partial",
        sessionId: runtime.sessionId,
        role: "user",
        text
      });
    },
    onFinalSegment: (segment) => {
      const text = segment.text;
      if (text) {
        runtime.finalSegments.push(text);
      }

      if (!segment.speechFinal) {
        return;
      }

      const transcript = runtime.finalSegments.join(" ").replace(/\s+/g, " ").trim();
      const transcriptFinalizedAt = Date.now();
      const voiceInputEndedAt = runtime.lastAudioChunkAt ?? transcriptFinalizedAt;
      runtime.finalSegments = [];

      if (!transcript) {
        return;
      }

      send(runtime.connection, {
        type: "transcript.final",
        sessionId: runtime.sessionId,
        role: "user",
        text: transcript
      });

      send(runtime.connection, {
        type: "server.status",
        sessionId: runtime.sessionId,
        phase: "processing",
        detail: "Utterance finalized. Running retrieval, generation and speech synthesis."
      });

      onFinalTranscript(transcript, {
        voiceInputEndedAt,
        transcriptFinalizedAt,
        detectedLanguage: normalizeLanguageTag(segment.dominantLanguage),
        detectedLanguages: segment.languages
      });
    },
    onError: (message) => {
      send(runtime.connection, {
        type: "server.error",
        message: `Deepgram: ${message}`
      });
    }
  });
}

export async function indexMarkdownKnowledge(
  runtime: RuntimeSessionState,
  onProgress?: (progress: KnowledgeIndexingProgress) => void
): Promise<{
  characters: number;
  lines: number;
  chunks: number;
}> {
  onProgress?.({
    stage: "chunking",
    progressPercent: 14,
    message: "Markdown normalized and split into retrieval chunks."
  });
  const chunks = chunkMarkdown(runtime.knowledgeMarkdown, SHARED_KNOWLEDGE_SOURCE);
  await ensureCollection();
  await deleteKnowledgeBySource(SHARED_KNOWLEDGE_SOURCE);

  if (chunks.length === 0) {
    return {
      characters: 0,
      lines: 0,
      chunks: 0
    };
  }

  onProgress?.({
    stage: "embedding",
    progressPercent: 52,
    message: `Generating embeddings for ${chunks.length} chunks.`
  });
  const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));

  onProgress?.({
    stage: "storing",
    progressPercent: 82,
    message: `Writing ${chunks.length} chunks into the shared Qdrant collection.`
  });
  await upsertKnowledge(
    SHARED_KNOWLEDGE_SOURCE,
    chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index] ?? embeddings[0]
    }))
  );

  return {
    characters: runtime.knowledgeMarkdown.length,
    lines: runtime.knowledgeMarkdown.split(/\r?\n/).length,
    chunks: chunks.length
  };
}

export function queueAssistantResponse(
  runtime: RuntimeSessionState,
  transcript: string,
  send: SendFn,
  context?: AssistantTurnContext
): void {
  runtime.processing = runtime.processing
    .then(async () => {
      const trace = new PipelineTrace(runtime.sessionId, "voice.utterance");
      const requestedLanguage = resolveResponseLanguage(runtime, transcript, context?.requestedLanguage);
      const languageSource = context?.languageSource ?? (requestedLanguage ? "session" : "default");
      const languageLabel = requestedLanguage ? getLanguageDisplayName(requestedLanguage) : "user language";
      let completionFirstByteMs: number | undefined;
      let elevenlabsTtsFirstByteMs: number | undefined;
      let sttFinalizeMs: number | undefined;
      let voiceToAudioFirstByteMs: number | undefined;
      let voiceToAudioDeliveredMs: number | undefined;
      let audioResponseStarted = false;
      let audioFirstChunkSentAt: number | undefined;
      let audioStreamCompletedAt: number | undefined;
      let ttsStageStartedAt: number | undefined;
      let ttsStageCompletedAt: number | undefined;
      let ttsTotalBytes = 0;
      let ttsChunkSequence = 0;
      let pendingTtsBuffer = "";
      let ttsProfileMetadata:
        | {
            endpointHost: string;
            servedRegion?: string;
            voiceId: string;
            modelId: string;
            fallbackUsed: boolean;
          }
        | undefined;
      let ttsQueue: Promise<void> = Promise.resolve();

      const ensureAudioResponseStarted = (): void => {
        if (audioResponseStarted) {
          return;
        }

        audioResponseStarted = true;
        send(runtime.connection, {
          type: "audio.response.start",
          sessionId: runtime.sessionId,
          mimeType: "audio/mpeg"
        });
      };

      const queueTtsSegment = (segmentText: string): void => {
        const normalizedSegment = normalizeTtsSegment(segmentText);
        if (!normalizedSegment) {
          return;
        }

        ttsQueue = ttsQueue.then(async () => {
          if (ttsStageStartedAt === undefined) {
            ttsStageStartedAt = Date.now();
            ensureAudioResponseStarted();
          }

          const streamedTts = await streamElevenLabsTts({
            text: normalizedSegment,
            language: requestedLanguage,
            onChunk: (chunk) => {
              const chunkSentAt = Date.now();

              if (audioFirstChunkSentAt === undefined) {
                audioFirstChunkSentAt = chunkSentAt;
              }

              ttsChunkSequence += 1;
              ttsTotalBytes += chunk.byteLength;

              send(runtime.connection, {
                type: "audio.response.chunk",
                sessionId: runtime.sessionId,
                base64: chunk.toString("base64"),
                bytes: chunk.byteLength,
                sequence: ttsChunkSequence
              });
            }
          });

          if (!ttsProfileMetadata) {
            ttsProfileMetadata = {
              endpointHost: streamedTts.endpointHost,
              servedRegion: streamedTts.servedRegion,
              voiceId: streamedTts.voiceId,
              modelId: streamedTts.modelId,
              fallbackUsed: streamedTts.fallbackUsed
            };
          } else if (streamedTts.fallbackUsed) {
            ttsProfileMetadata.fallbackUsed = true;
          }

          ttsStageCompletedAt = Date.now();
        });
      };

      try {
        const embeddingStartedAt = Date.now();
        const queryEmbedding = await embedText(transcript);
        trace.completeStage("openai_embeddings", embeddingStartedAt, Date.now(), {
          inputLength: transcript.length
        });

        const retrievalStartedAt = Date.now();
        const matches = await searchKnowledge(queryEmbedding, 3, SHARED_KNOWLEDGE_SOURCE);
        trace.completeStage("qdrant_query", retrievalStartedAt, Date.now(), {
          hits: matches.length
        });

        const generationStartedAt = Date.now();
        const completion = await streamGroqCompletion({
          systemPrompt: buildSystemPrompt(matches, requestedLanguage, runtime.ragPrompt),
          userPrompt: transcript,
          onDelta: (delta) => {
            pendingTtsBuffer += delta;

            const extracted = extractReadyTtsSegments(pendingTtsBuffer);
            pendingTtsBuffer = extracted.remaining;

            for (const segment of extracted.segments) {
              queueTtsSegment(segment);
            }

            send(runtime.connection, {
              type: "transcript.partial",
              sessionId: runtime.sessionId,
              role: "assistant",
              text: delta
            });
          }
        });
        trace.completeStage("groq_completion", generationStartedAt, Date.now(), {
          firstByteMs: completion.firstByteMs,
          characters: completion.text.length,
          endpointHost: completion.endpointHost
        });
        completionFirstByteMs = completion.firstByteMs;

        send(runtime.connection, {
          type: "transcript.final",
          sessionId: runtime.sessionId,
          role: "assistant",
          text: completion.text
        });

        send(runtime.connection, {
          type: "server.status",
          sessionId: runtime.sessionId,
          phase: "processing",
          detail: `Generating ${languageLabel} speech output. Language source: ${languageSource}.`
        });

        const finalSegments = extractReadyTtsSegments(pendingTtsBuffer, true);
        pendingTtsBuffer = finalSegments.remaining;

        for (const segment of finalSegments.segments) {
          queueTtsSegment(segment);
        }

        await ttsQueue;

        if (ttsStageStartedAt !== undefined) {
          elevenlabsTtsFirstByteMs =
            audioFirstChunkSentAt !== undefined
              ? Math.max(0, audioFirstChunkSentAt - ttsStageStartedAt)
              : undefined;

          trace.completeStage("elevenlabs_tts", ttsStageStartedAt, ttsStageCompletedAt ?? Date.now(), {
            firstByteMs: elevenlabsTtsFirstByteMs,
            bytes: ttsTotalBytes,
            endpointHost: ttsProfileMetadata?.endpointHost,
            servedRegion: ttsProfileMetadata?.servedRegion,
            voiceId: ttsProfileMetadata?.voiceId,
            modelId: ttsProfileMetadata?.modelId,
            fallbackUsed: ttsProfileMetadata?.fallbackUsed ?? false
          });
        }

        audioStreamCompletedAt = Date.now();
        if (audioResponseStarted) {
          send(runtime.connection, {
            type: "audio.response.end",
            sessionId: runtime.sessionId,
            totalBytes: ttsTotalBytes
          });
        }

        sttFinalizeMs = context?.latencyContext
          ? Math.max(
              0,
              context.latencyContext.transcriptFinalizedAt - context.latencyContext.voiceInputEndedAt
            )
          : undefined;
        voiceToAudioFirstByteMs = context?.latencyContext
          ? Math.max(
              0,
              (audioFirstChunkSentAt ?? audioStreamCompletedAt ?? Date.now()) -
                context.latencyContext.voiceInputEndedAt
            )
          : undefined;
        voiceToAudioDeliveredMs = context?.latencyContext
          ? Math.max(
              0,
              (audioStreamCompletedAt ?? audioFirstChunkSentAt ?? Date.now()) -
                context.latencyContext.voiceInputEndedAt
            )
          : undefined;

        send(runtime.connection, {
          type: "pipeline.metrics",
          sessionId: runtime.sessionId,
          traceId: trace.traceId,
          totalMs: Date.now() - trace.startedAt,
          firstByteMs: completionFirstByteMs,
          elevenlabsTtsFirstByteMs,
          sttFinalizeMs,
          voiceToAudioFirstByteMs,
          voiceToAudioDeliveredMs,
          stages: trace.getStageSummaries()
        });

        trace.flush({
          status: "ok",
          sttFinalizeMs,
          voiceToAudioFirstByteMs,
          voiceToAudioDeliveredMs
        });

        send(runtime.connection, {
          type: "server.status",
          sessionId: runtime.sessionId,
          phase: "listening",
          detail: "Response delivered. Listening for the next utterance."
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown voice pipeline error";
        log("pipeline.trace.failed", {
          traceId: trace.traceId,
          sessionId: runtime.sessionId,
          route: trace.route,
          message
        });

        if (audioResponseStarted) {
          send(runtime.connection, {
            type: "audio.response.end",
            sessionId: runtime.sessionId,
            totalBytes: ttsTotalBytes
          });
        }

        send(runtime.connection, {
          type: "pipeline.metrics",
          sessionId: runtime.sessionId,
          traceId: trace.traceId,
          totalMs: Date.now() - trace.startedAt,
          firstByteMs: completionFirstByteMs,
          elevenlabsTtsFirstByteMs,
          sttFinalizeMs,
          voiceToAudioFirstByteMs,
          voiceToAudioDeliveredMs,
          stages: trace.getStageSummaries()
        });

        trace.flush({
          status: "error",
          message,
          sttFinalizeMs,
          voiceToAudioFirstByteMs,
          voiceToAudioDeliveredMs
        });

        send(runtime.connection, {
          type: "server.error",
          message
        });

        send(runtime.connection, {
          type: "server.status",
          sessionId: runtime.sessionId,
          phase: "error",
          detail: "Pipeline failed. Check the event log and try again."
        });
      }
    })
    .catch((error) => {
      send(runtime.connection, {
        type: "server.error",
        message: error instanceof Error ? error.message : "Unknown queued voice pipeline error"
      });
    });
}

function buildSystemPrompt(
  matches: Array<{
    ordinal: number;
    text: string;
  }>,
  responseLanguage?: string,
  ragPrompt?: string
): string {
  const context = matches.length
    ? matches.map((match) => `[chunk-${match.ordinal + 1}]\n${match.text}`).join("\n\n")
    : "Контекст не найден.";
  const normalizedLanguage = normalizeLanguageTag(responseLanguage);
  const promptBlock = ragPrompt?.trim() || DEFAULT_RAG_PROMPT;
  const languageInstruction = normalizedLanguage
    ? `Критично: итоговый ответ дай на ${getLanguageDisplayName(normalizedLanguage)} языке (код: ${normalizedLanguage}). Если пользователь смешивает языки, используй этот язык как основной для всего ответа.`
    : "Отвечай кратко и на языке пользователя.";

  return [
    languageInstruction,
    "Критично: строго следуй дополнительным инструкциям ниже. Они определяют стиль и формат ответа для текущей RAG-сессии.",
    promptBlock,
    "",
    "Контекст:",
    context
  ].join("\n");
}

function resolveResponseLanguage(
  runtime: RuntimeSessionState,
  transcript: string,
  preferredLanguage?: string
): string | undefined {
  return (
    normalizeLanguageTag(preferredLanguage) ??
    runtime.detectedLanguage ??
    inferLanguageFromText(transcript) ??
    "ru"
  );
}

function extractReadyTtsSegments(
  buffer: string,
  flushAll = false
): {
  segments: string[];
  remaining: string;
} {
  const segments: string[] = [];
  let working = buffer;

  while (true) {
    const boundary = findTtsSegmentBoundary(working, flushAll);

    if (boundary === -1) {
      return {
        segments,
        remaining: working
      };
    }

    const segment = normalizeTtsSegment(working.slice(0, boundary));
    working = working.slice(boundary).trimStart();

    if (segment) {
      segments.push(segment);
    }

    if (flushAll && !working.trim()) {
      return {
        segments,
        remaining: ""
      };
    }
  }
}

function findTtsSegmentBoundary(text: string, flushAll: boolean): number {
  const trimmedEnd = text.trimEnd().length;

  if (trimmedEnd === 0) {
    return -1;
  }

  if (flushAll) {
    return trimmedEnd;
  }

  let lastHardBoundary = -1;
  let lastSoftPunctuationBoundary = -1;
  let lastWhitespaceBoundary = -1;

  for (let index = 0; index < trimmedEnd; index += 1) {
    const char = text[index];

    if (char === "\n") {
      lastHardBoundary = index + 1;
      continue;
    }

    if (/[.!?…。！？]/.test(char)) {
      let cursor = index + 1;
      while (cursor < trimmedEnd && /[\s"'»)\]]/.test(text[cursor] ?? "")) {
        cursor += 1;
      }
      lastHardBoundary = cursor;
      continue;
    }

    if (/[,:;，、—-]/.test(char)) {
      lastSoftPunctuationBoundary = index + 1;
      continue;
    }

    if (/\s/.test(char)) {
      lastWhitespaceBoundary = index;
    }
  }

  if (lastHardBoundary !== -1) {
    return lastHardBoundary;
  }

  if (trimmedEnd >= 110 && lastSoftPunctuationBoundary >= 80) {
    return lastSoftPunctuationBoundary;
  }

  if (trimmedEnd >= 130 && lastWhitespaceBoundary >= 95) {
    return lastWhitespaceBoundary;
  }

  if (trimmedEnd < 140) {
    return -1;
  }

  const softBoundary = findLastSoftBoundary(text, Math.min(trimmedEnd, 170));
  if (softBoundary !== -1) {
    return softBoundary;
  }

  return Math.min(trimmedEnd, 140);
}

function findLastSoftBoundary(text: string, upTo: number): number {
  const minimum = Math.min(95, upTo);

  for (let index = upTo - 1; index >= minimum; index -= 1) {
    const char = text[index];

    if (!/[,:;\s]/.test(char)) {
      continue;
    }

    return char.trim() ? index + 1 : index;
  }

  return -1;
}

function normalizeTtsSegment(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
