import { createServer } from "node:http";
import path from "node:path";

import cors from "cors";
import express from "express";
import { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type WebSocket from "ws";

import { env } from "./config/env.js";
import { log } from "./logging.js";
import type { ClientEvent, ServerEvent } from "./protocol.js";
import {
  indexMarkdownKnowledge,
  queueAssistantResponse,
  startSpeechRecognition,
  type RuntimeSessionState
} from "./runtime/voicePipeline.js";
import { PipelineTrace } from "./telemetry/pipelineTelemetry.js";
import { SessionManager } from "./ws/sessionManager.js";

const app = express();
const sessionManager = new SessionManager();
const runtimes = new Map<WebSocket, RuntimeSessionState>();
const frontendDistPath = path.resolve(process.cwd(), env.FRONTEND_DIST_PATH);

app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "voice-agent-rag-backend",
    env: env.NODE_ENV,
    activeSessions: sessionManager.stats().activeSessions,
    transport: "ws-raw-pcm-live"
  });
});

app.get("/api/debug/openai-embeddings-breakdown", async (request, response) => {
  if (!env.OPENAI_API_KEY) {
    response.status(400).json({
      ok: false,
      message: "OPENAI_API_KEY is not configured."
    });
    return;
  }

  const input =
    typeof request.query.text === "string" && request.query.text.trim()
      ? request.query.text.trim()
      : "Latency breakdown test for OpenAI embeddings inside backend telemetry.";

  const sessionId =
    typeof request.query.session_id === "string" && request.query.session_id.trim()
      ? request.query.session_id.trim()
      : "debug-route";

  const trace = new PipelineTrace(sessionId, "debug.openai_embeddings_breakdown");

  try {
    const requestStartedAt = Date.now();
    const startedAt = performance.now();
    const apiResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input
      }),
      signal: AbortSignal.timeout(30000)
    });
    const headersAt = performance.now();
    const rawText = await apiResponse.text();
    const completedAt = performance.now();

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }

    if (!apiResponse.ok) {
      throw new Error(`${apiResponse.status}: ${rawText.slice(0, 500)}`);
    }

    const requestCompletedAt = Date.now();
    const responseSizeBytes = Buffer.byteLength(rawText, "utf8");
    const embeddingLength =
      parsed &&
      typeof parsed === "object" &&
      "data" in parsed &&
      Array.isArray(parsed.data) &&
      parsed.data[0] &&
      typeof parsed.data[0] === "object" &&
      "embedding" in parsed.data[0] &&
      Array.isArray(parsed.data[0].embedding)
        ? parsed.data[0].embedding.length
        : "unknown";

    const stage = trace.completeStage("openai_embeddings", requestStartedAt, requestCompletedAt, {
      firstByteMs: Math.round(headersAt - startedAt),
      totalMs: Math.round(completedAt - startedAt),
      bodyReadMs: Math.round(completedAt - headersAt),
      responseSizeBytes,
      embeddingLength,
      requestId:
        apiResponse.headers.get("x-request-id") || apiResponse.headers.get("request-id") || "n/a"
    });

    trace.flush({
      status: "ok"
    });

    response.json({
      ok: true,
      traceId: trace.traceId,
      sessionId,
      stage
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OpenAI breakdown error";

    log("pipeline.trace.failed", {
      traceId: trace.traceId,
      sessionId,
      route: trace.route,
      message
    });

    response.status(500).json({
      ok: false,
      traceId: trace.traceId,
      sessionId,
      message
    });
  }
});

app.use(express.static(frontendDistPath));

app.get("/{*fallback}", (_request, response) => {
  response.sendFile(path.join(frontendDistPath, "index.html"), (error) => {
    if (error) {
      response.status(404).json({
        ok: false,
        message: "Frontend build is not available yet. Run `npm run build --workspace frontend`."
      });
    }
  });
});

const server = createServer(app);
const wsServer = new WebSocketServer({
  server,
  path: "/ws"
});

wsServer.on("connection", (connection) => {
  const session = sessionManager.create(connection);
  runtimes.set(connection, {
    sessionId: session.id,
    connection,
    sampleRate: 16000,
    knowledgeMarkdown: "",
    finalSegments: [],
    processing: Promise.resolve(),
    deepgramReady: false,
    pendingAudioChunks: []
  });

  log("ws.connection.opened", { sessionId: session.id });

  send(connection, {
    type: "connection.ready",
    sessionId: session.id
  });

  send(connection, {
    type: "server.status",
    sessionId: session.id,
    phase: session.phase,
    detail: "WebSocket connected. Waiting for session.start."
  });

  connection.on("message", (payload, isBinary) => {
    try {
      if (isBinary) {
        handleAudioChunk(connection, payload);
        return;
      }

      const event = JSON.parse(payload.toString()) as ClientEvent;
      handleClientEvent(connection, event);
    } catch (error) {
      const runtime = runtimes.get(connection);
      const message = error instanceof Error ? error.message : "Unknown WebSocket error";
      log("ws.connection.error", {
        sessionId: runtime?.sessionId ?? "unknown",
        message
      });

      send(connection, {
        type: "server.error",
        message
      });
    }
  });

  connection.on("close", () => {
    const runtime = runtimes.get(connection);
    runtime?.deepgram?.close();
    runtimes.delete(connection);
    log("ws.connection.closed", { sessionId: session.id });
    sessionManager.remove(connection);
  });
});

function handleAudioChunk(connection: WebSocket, payload: RawData): void {
  const runtime = runtimes.get(connection);
  const bytes = measurePayloadBytes(payload);

  if (!runtime) {
    return;
  }

  const session = sessionManager.appendAudio(connection, bytes);
  const buffer = toBuffer(payload);

  if (runtime.deepgramReady && runtime.deepgram?.readyState === 1) {
    runtime.deepgram.send(buffer);
  } else if (runtime.deepgram && runtime.deepgram.readyState === 0) {
    runtime.pendingAudioChunks.push(buffer);
  }

  if (session.audioBytes === bytes || session.audioBytes % 32000 < bytes) {
    log("audio.append", {
      sessionId: session.id,
      bytes,
      totalBytes: session.audioBytes
    });

    send(connection, {
      type: "server.status",
      sessionId: session.id,
      phase: session.phase,
      detail: `PCM uplink active: ${session.audioBytes} bytes received.`
    });
  }
}

function handleClientEvent(connection: WebSocket, event: ClientEvent): void {
  const session = sessionManager.get(connection);
  const runtime = runtimes.get(connection);

  if (!session || !runtime) {
    throw new Error("Session state is missing");
  }

  switch (event.type) {
    case "session.start": {
      const started = sessionManager.start(connection, event.sampleRate);
      runtime.sampleRate = event.sampleRate;
      log("session.started", { sessionId: started.id, sampleRate: event.sampleRate });

      send(connection, {
        type: "session.started",
        sessionId: started.id
      });

      void startSpeechRecognition(runtime, send, (transcript) => {
        sessionManager.setLastUserTranscript(connection, transcript);
        queueAssistantResponse(runtime, transcript, send);
      });

      send(connection, {
        type: "server.status",
        sessionId: started.id,
        phase: started.phase,
        detail: `Session started. Opening provider pipeline for ${event.sampleRate} Hz audio.`
      });
      return;
    }

    case "knowledge.set": {
      const updated = sessionManager.updateKnowledge(connection, event.markdown);
      runtime.knowledgeMarkdown = event.markdown;

      send(connection, {
        type: "knowledge.indexing",
        sessionId: updated.id,
        status: "started",
        scope: "shared",
        message: "Indexing started. Existing shared knowledge will be replaced after embeddings are generated."
      });

      send(connection, {
        type: "server.status",
        sessionId: updated.id,
        phase: updated.phase,
        detail: "Markdown received. Creating embeddings and indexing into shared Qdrant knowledge."
      });

      void indexMarkdownKnowledge(runtime)
        .then((result) => {
          send(connection, {
            type: "knowledge.indexing",
            sessionId: updated.id,
            status: "completed",
            scope: "shared",
            message: `Shared knowledge updated. ${result.chunks} chunks are now available to all new sessions.`
          });

          send(connection, {
            type: "knowledge.indexed",
            sessionId: updated.id,
            characters: result.characters,
            lines: result.lines,
            chunks: result.chunks
          });

          send(connection, {
            type: "server.status",
            sessionId: updated.id,
            phase: updated.phase,
            detail: `Shared knowledge indexed with ${result.chunks} chunks and will persist for future sessions.`
          });
        })
        .catch((error) => {
          send(connection, {
            type: "knowledge.indexing",
            sessionId: updated.id,
            status: "failed",
            scope: "shared",
            message:
              error instanceof Error ? error.message : "Knowledge indexing failed unexpectedly"
          });

          send(connection, {
            type: "server.error",
            message: error instanceof Error ? error.message : "Knowledge indexing failed"
          });
        });
      return;
    }

    case "text.turn": {
      const text = event.text.trim();

      if (!text) {
        send(connection, {
          type: "server.warning",
          sessionId: session.id,
          message: "Text turn is empty."
        });
        return;
      }

      sessionManager.setLastUserTranscript(connection, text);

      send(connection, {
        type: "transcript.final",
        sessionId: session.id,
        role: "user",
        text
      });

      send(connection, {
        type: "server.status",
        sessionId: session.id,
        phase: "processing",
        detail: "Text message received. Running retrieval, generation and speech synthesis."
      });

      queueAssistantResponse(runtime, text, send);
      return;
    }

    case "client.ping":
      send(connection, {
        type: "client.pong",
        at: event.at
      });
      return;

    case "audio.append":
      send(connection, {
        type: "server.warning",
        sessionId: session.id,
        message: `Unexpected JSON audio.append for ${event.bytes} bytes. Browser should send binary PCM frames.`
      });
      return;
  }
}

function send(connection: WebSocket, event: ServerEvent): void {
  connection.send(JSON.stringify(event));
}

function measurePayloadBytes(payload: RawData): number {
  if (Buffer.isBuffer(payload)) {
    return payload.byteLength;
  }

  if (payload instanceof ArrayBuffer) {
    return payload.byteLength;
  }

  if (ArrayBuffer.isView(payload)) {
    return payload.byteLength;
  }

  return 0;
}

function toBuffer(payload: RawData): Buffer {
  if (Buffer.isBuffer(payload)) {
    return payload;
  }

  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload);
  }

  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }

  return Buffer.alloc(0);
}

server.listen(env.PORT, () => {
  log("server.started", {
    port: env.PORT,
    frontendDistPath,
    env: env.NODE_ENV
  });
});
