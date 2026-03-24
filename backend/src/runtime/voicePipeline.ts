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
}

type SendFn = (connection: WebSocket, event: ServerEvent) => void;

export async function startSpeechRecognition(
  runtime: RuntimeSessionState,
  send: SendFn,
  onFinalTranscript: (transcript: string) => void
): Promise<void> {
  runtime.deepgram?.close();
  runtime.deepgram = connectDeepgramStream(runtime.sampleRate, {
    onOpen: () => {
      send(runtime.connection, {
        type: "server.status",
        sessionId: runtime.sessionId,
        phase: "connected",
        detail: `Deepgram stream connected for ${runtime.sampleRate} Hz PCM.`
      });
    },
    onPartial: (text) => {
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

      onFinalTranscript(transcript);
    },
    onError: (message) => {
      send(runtime.connection, {
        type: "server.error",
        message: `Deepgram: ${message}`
      });
    }
  });
}

export async function indexMarkdownKnowledge(runtime: RuntimeSessionState): Promise<{
  characters: number;
  lines: number;
  chunks: number;
}> {
  const chunks = chunkMarkdown(runtime.knowledgeMarkdown, runtime.sessionId);
  await ensureCollection();
  await deleteKnowledgeBySource(runtime.sessionId);

  if (chunks.length === 0) {
    return {
      characters: 0,
      lines: 0,
      chunks: 0
    };
  }

  const embeddings = await embedTexts(chunks.map((chunk) => chunk.text));

  await upsertKnowledge(
    runtime.sessionId,
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
  send: SendFn
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
        const matches = (await searchKnowledge(queryEmbedding, 3)).filter(
          (match) => match.source === runtime.sessionId
        );
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
        const tts = await streamElevenLabsTts(completion.text);
        trace.completeStage("elevenlabs_tts", ttsStartedAt, Date.now(), {
          firstByteMs: tts.firstByteMs,
          bytes: tts.audioBuffer.byteLength
        });

        send(runtime.connection, {
          type: "audio.response",
          sessionId: runtime.sessionId,
          mimeType: tts.mimeType,
          base64: tts.audioBuffer.toString("base64"),
          bytes: tts.audioBuffer.byteLength
        });

        send(runtime.connection, {
          type: "pipeline.metrics",
          sessionId: runtime.sessionId,
          traceId: trace.traceId,
          totalMs: Date.now() - trace.startedAt,
          firstByteMs: completion.firstByteMs,
          stages: trace.getStageSummaries()
        });

        trace.flush({
          status: "ok"
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
