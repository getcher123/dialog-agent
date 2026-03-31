import WebSocket from "ws";

const targetUrl = process.env.WS_URL || "ws://127.0.0.1:3300/ws";
const prompt =
  process.env.TEXT_TURN ||
  "Подробно расскажи, как проводится флеш-отбеливание зубов, сколько это длится, какие преимущества, сколько держится эффект и какая подготовка нужна перед процедурой. Ответ дай несколькими полными предложениями.";

const startedAt = Date.now();
const events = [];

let sessionId;
let sent = false;
let firstAssistantPartialAt;
let firstAudioAt;
let assistantFinalAt;
let closed = false;
let assistantPartialCount = 0;

const ws = new WebSocket(targetUrl);

function stamp(name, extra = {}) {
  events.push({
    at: Date.now() - startedAt,
    name,
    ...extra
  });
}

function finish(summary) {
  if (closed) {
    return;
  }

  closed = true;
  console.log(
    JSON.stringify(
      {
        targetUrl,
        prompt,
        sessionId,
        ...summary,
        events
      },
      null,
      2
    )
  );
  ws.close();
}

ws.on("open", () => {
  stamp("ws.open");
});

ws.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  if (!sessionId && event.sessionId) {
    sessionId = event.sessionId;
  }

  if (event.type === "connection.ready" && !sent) {
    sent = true;
    stamp("connection.ready");
    ws.send(
      JSON.stringify({
        type: "text.turn",
        text: prompt
      })
    );
    stamp("text.turn.sent");
    return;
  }

  if (event.type === "transcript.partial" && event.role === "assistant") {
    assistantPartialCount += 1;
    if (firstAssistantPartialAt === undefined) {
      firstAssistantPartialAt = Date.now() - startedAt;
    }
    if (assistantPartialCount <= 8) {
      stamp("assistant.partial", {
        text: event.text.slice(0, 60)
      });
    }
    return;
  }

  if (event.type === "audio.response.start") {
    stamp("audio.start");
    return;
  }

  if (event.type === "audio.response.chunk" && firstAudioAt === undefined) {
    firstAudioAt = Date.now() - startedAt;
    stamp("audio.first_chunk", {
      bytes: event.bytes,
      sequence: event.sequence
    });
    return;
  }

  if (event.type === "transcript.final" && event.role === "assistant") {
    assistantFinalAt = Date.now() - startedAt;
    stamp("assistant.final", {
      text: event.text.slice(0, 120)
    });
    return;
  }

  if (event.type === "pipeline.metrics") {
    const groqStage = event.stages.find((stage) => stage.name === "groq_completion");
    const ttsStage = event.stages.find((stage) => stage.name === "elevenlabs_tts");

    finish({
      firstAssistantPartialAt,
      firstAudioAt,
      assistantFinalAt,
      audioStartedBeforeAssistantFinal:
        firstAudioAt !== undefined && assistantFinalAt !== undefined
          ? firstAudioAt < assistantFinalAt
          : null,
      metrics: {
        totalMs: event.totalMs,
        groqCompletionMs: groqStage?.durationMs,
        elevenlabsTtsMs: ttsStage?.durationMs,
        elevenlabsTtsFirstByteMs: event.elevenlabsTtsFirstByteMs,
        voiceToAudioFirstByteMs: event.voiceToAudioFirstByteMs
      }
    });
    return;
  }

  if (event.type === "server.error") {
    finish({
      error: event.message
    });
  }
});

ws.on("close", () => {
  if (!closed) {
    finish({
      error: "Socket closed before smoke completed."
    });
  }
});

ws.on("error", (error) => {
  finish({
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
