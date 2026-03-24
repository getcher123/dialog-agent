import type WebSocket from "ws";

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
  finalSegments: string[];
  processing: Promise<void>;
  deepgram?: WebSocket;
  deepgramReady: boolean;
  pendingAudioChunks: Buffer[];
  lastAudioChunkAt?: number;
}

type SendFn = (connection: WebSocket, event: ServerEvent) => void;
const SHARED_KNOWLEDGE_SOURCE = "shared-ui-knowledge";

export interface VoiceLatencyContext {
  voiceInputEndedAt: number;
  transcriptFinalizedAt: number;
}

interface KnowledgeIndexingProgress {
  stage: "chunking" | "embedding" | "storing";
  progressPercent: number;
  message: string;
}

export async function startSpeechRecognition(
  runtime: RuntimeSessionState,
  send: SendFn,
  onFinalTranscript: (transcript: string, latencyContext: VoiceLatencyContext) => void
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
    onFinalSegment: (text, speechFinal) => {
      if (text) {
        runtime.finalSegments.push(text);
      }

      if (!speechFinal) {
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
        transcriptFinalizedAt
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
  latencyContext?: VoiceLatencyContext
): void {
  runtime.processing = runtime.processing
    .then(async () => {
      const trace = new PipelineTrace(runtime.sessionId, "voice.utterance");

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
          systemPrompt: buildSystemPrompt(matches),
          userPrompt: transcript,
          onDelta: (delta) => {
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
          characters: completion.text.length
        });

        send(runtime.connection, {
          type: "transcript.final",
          sessionId: runtime.sessionId,
          role: "assistant",
          text: completion.text
        });

        const ttsStartedAt = Date.now();
        let audioFirstChunkSentAt: number | undefined;
        let audioStreamCompletedAt: number | undefined;

        send(runtime.connection, {
          type: "audio.response.start",
          sessionId: runtime.sessionId,
          mimeType: "audio/mpeg"
        });

        const streamedTts = await streamElevenLabsTts({
          text: completion.text,
          onChunk: (chunk, info) => {
            const chunkSentAt = Date.now();

            if (audioFirstChunkSentAt === undefined) {
              audioFirstChunkSentAt = chunkSentAt;
            }

            send(runtime.connection, {
              type: "audio.response.chunk",
              sessionId: runtime.sessionId,
              base64: chunk.toString("base64"),
              bytes: chunk.byteLength,
              sequence: info.sequence
            });
          }
        });
        trace.completeStage("elevenlabs_tts", ttsStartedAt, Date.now(), {
          firstByteMs: streamedTts.firstByteMs,
          bytes: streamedTts.totalBytes
        });

        audioStreamCompletedAt = Date.now();
        send(runtime.connection, {
          type: "audio.response.end",
          sessionId: runtime.sessionId,
          totalBytes: streamedTts.totalBytes
        });

        const sttFinalizeMs = latencyContext
          ? Math.max(0, latencyContext.transcriptFinalizedAt - latencyContext.voiceInputEndedAt)
          : undefined;
        const voiceToAudioFirstByteMs = latencyContext
          ? Math.max(
              0,
              (audioFirstChunkSentAt ?? audioStreamCompletedAt ?? Date.now()) -
                latencyContext.voiceInputEndedAt
            )
          : undefined;
        const voiceToAudioDeliveredMs = latencyContext
          ? Math.max(
              0,
              (audioStreamCompletedAt ?? audioFirstChunkSentAt ?? Date.now()) -
                latencyContext.voiceInputEndedAt
            )
          : undefined;

        send(runtime.connection, {
          type: "pipeline.metrics",
          sessionId: runtime.sessionId,
          traceId: trace.traceId,
          totalMs: Date.now() - trace.startedAt,
          firstByteMs: completion.firstByteMs,
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
  }>
): string {
  const context = matches.length
    ? matches.map((match) => `[chunk-${match.ordinal + 1}]\n${match.text}`).join("\n\n")
    : "Контекст не найден.";

  return [
    "Ты отвечаешь как голосовой RAG-ассистент.",
    "Отвечай кратко и на языке пользователя.",
    "Используй контекст ниже, если он релевантен.",
    "Если контекста не хватает, скажи об этом прямо.",
    "Если ссылаешься на источник, используй формат [chunk-N].",
    "",
    "Контекст:",
    context
  ].join("\n");
}
