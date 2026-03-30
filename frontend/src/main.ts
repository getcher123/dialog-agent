import "./styles.css";

type ServerEvent =
  | { type: "connection.ready"; sessionId: string }
  | { type: "session.started"; sessionId: string }
  | {
      type: "session.language";
      sessionId: string;
      language: string;
      source: "stt" | "text" | "session" | "default";
      changed: boolean;
      detail: string;
    }
  | {
      type: "knowledge.indexing";
      sessionId: string;
      status: "started" | "completed" | "failed";
      scope: "shared";
      message: string;
      stage?: "queued" | "chunking" | "embedding" | "storing" | "completed" | "failed";
      progressPercent?: number;
    }
  | {
      type: "knowledge.indexed";
      sessionId: string;
      characters: number;
      lines: number;
      chunks: number;
    }
  | { type: "server.status"; sessionId: string; phase: string; detail: string }
  | { type: "client.pong"; at: number }
  | { type: "transcript.partial"; sessionId: string; role: "user" | "assistant"; text: string }
  | { type: "transcript.final"; sessionId: string; role: "user" | "assistant"; text: string }
  | {
      type: "audio.response";
      sessionId: string;
      mimeType: string;
      base64: string;
      bytes: number;
    }
  | {
      type: "audio.response.start";
      sessionId: string;
      mimeType: string;
    }
  | {
      type: "audio.response.chunk";
      sessionId: string;
      base64: string;
      bytes: number;
      sequence: number;
    }
  | {
      type: "audio.response.end";
      sessionId: string;
      totalBytes: number;
    }
  | {
      type: "pipeline.metrics";
      sessionId: string;
      traceId: string;
      totalMs: number;
      firstByteMs?: number;
      elevenlabsTtsFirstByteMs?: number;
      sttFinalizeMs?: number;
      voiceToAudioFirstByteMs?: number;
      voiceToAudioDeliveredMs?: number;
      stages: Array<{
        name: string;
        durationMs: number;
      }>;
    }
  | { type: "server.warning"; sessionId: string; message: string }
  | { type: "server.error"; message: string };

const startButton = getRequiredElement<HTMLButtonElement>("#start-button");
const stopButton = getRequiredElement<HTMLButtonElement>("#stop-button");
const applyKnowledgeButton = getRequiredElement<HTMLButtonElement>("#apply-knowledge");
const sendTextButton = getRequiredElement<HTMLButtonElement>("#send-text");
const resetRagPromptButton = getRequiredElement<HTMLButtonElement>("#reset-rag-prompt");
const knowledgeInput = getRequiredElement<HTMLTextAreaElement>("#knowledge-input");
const textMessageInput = getRequiredElement<HTMLTextAreaElement>("#text-message-input");
const ragPromptInput = getRequiredElement<HTMLTextAreaElement>("#rag-prompt-input");
const eventsLog = getRequiredElement<HTMLDivElement>("#events-log");
const chatLog = getRequiredElement<HTMLDivElement>("#chat-log");
const sessionIdLabel = getRequiredElement<HTMLSpanElement>("#session-id");
const connectionPill = getRequiredElement<HTMLSpanElement>("#connection-pill");
const micStatus = getRequiredElement<HTMLElement>("#mic-status");
const wsStatus = getRequiredElement<HTMLElement>("#ws-status");
const latencyStatus = getRequiredElement<HTMLElement>("#latency-status");
const sttLatencyStatus = getRequiredElement<HTMLElement>("#stt-latency-status");
const openaiEmbeddingsStatus = getRequiredElement<HTMLElement>("#openai-embeddings-status");
const qdrantQueryStatus = getRequiredElement<HTMLElement>("#qdrant-query-status");
const groqCompletionStatus = getRequiredElement<HTMLElement>("#groq-completion-status");
const elevenlabsFirstByteStatus = getRequiredElement<HTMLElement>("#elevenlabs-first-byte-status");
const voiceFirstAudioStatus = getRequiredElement<HTMLElement>("#voice-first-audio-status");
const knowledgeStatus = getRequiredElement<HTMLElement>("#knowledge-status");
const ragPromptStatus = getRequiredElement<HTMLElement>("#rag-prompt-status");
const triggerStatus = getRequiredElement<HTMLElement>("#trigger-status");
const processingStatus = getRequiredElement<HTMLElement>("#processing-status");
const pipelineHint = getRequiredElement<HTMLElement>("#pipeline-hint");
const waveform = getRequiredElement<HTMLCanvasElement>("#waveform");
const knowledgeProgressLabel = getRequiredElement<HTMLElement>("#knowledge-progress-label");
const knowledgeProgressValue = getRequiredElement<HTMLElement>("#knowledge-progress-value");
const knowledgeProgressFill = getRequiredElement<HTMLElement>("#knowledge-progress-fill");

interface AudioStreamPlayback {
  audio: HTMLAudioElement;
  mimeType: string;
  url: string | null;
  mediaSource: MediaSource | null;
  sourceBuffer: SourceBuffer | null;
  chunkQueue: ArrayBuffer[];
  fallbackChunks: ArrayBuffer[];
  streamEnded: boolean;
  playbackStarted: boolean;
  totalBytes: number;
}

let socket: WebSocket | null = null;
let sessionId = "n/a";
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let microphoneSource: MediaStreamAudioSourceNode | null = null;
let silentGain: GainNode | null = null;
let waveformFrame = 0;
let idleWavePhase = 0;
let lastPingAt = 0;
let activeAudio: HTMLAudioElement | null = null;
let activeAudioUrl: string | null = null;
let activeAudioStream: AudioStreamPlayback | null = null;
let isIndexingKnowledge = false;
let assistantPartialBubble: HTMLElement | null = null;
let socketConnectPromise: Promise<void> | null = null;
let ragPromptSyncTimer: number | null = null;
let lastSyncedRagPrompt = normalizePrompt(ragPromptInput.value);
const defaultRagPrompt = lastSyncedRagPrompt;

startButton.addEventListener("click", () => {
  void startSession();
});

stopButton.addEventListener("click", () => {
  stopSession();
});

applyKnowledgeButton.addEventListener("click", () => {
  void sendKnowledgeForIndexing();
});

sendTextButton.addEventListener("click", () => {
  void sendTextTurn();
});

resetRagPromptButton.addEventListener("click", () => {
  ragPromptInput.value = defaultRagPrompt;
  setRagPromptStatus(socket?.readyState === WebSocket.OPEN ? "Syncing..." : "Local default");
  scheduleRagPromptSync(true);
});

knowledgeInput.addEventListener("input", () => {
  updateKnowledgeUiState(isIndexingKnowledge, knowledgeStatus.textContent ?? "empty");
});

ragPromptInput.addEventListener("input", () => {
  setRagPromptStatus(socket?.readyState === WebSocket.OPEN ? "Syncing..." : "Saved locally");
  scheduleRagPromptSync(false);
});

textMessageInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    sendTextTurn();
  }
});

async function startSession(): Promise<void> {
  if (mediaStream) {
    return;
  }

  const hadOpenSocket = socket?.readyState === WebSocket.OPEN;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });
    micStatus.textContent = "live";
    triggerStatus.textContent = "waiting for speech";
    processingStatus.textContent = "idle";
    pipelineHint.textContent = "Microphone open. Start speaking. Inference begins after a short pause in speech.";
    startButton.disabled = true;
    stopButton.disabled = false;

    setupWaveform(mediaStream);
    await ensureSocketConnected();
    syncRagPromptToServer();
    if (hadOpenSocket) {
      socket?.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: Math.round(audioContext?.sampleRate ?? 16000)
        })
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone permission failed";
    addEventRow("Client", `Microphone error: ${message}`);
    micStatus.textContent = "error";
    triggerStatus.textContent = "blocked";
    pipelineHint.textContent = "Microphone access is required for voice mode.";
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}

function stopSession(): void {
  if (socket) {
    socket.close();
    socket = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    void audioContext.close();
    audioContext = null;
  }

  if (activeAudio) {
    disposeActiveAudio();
  }

  analyser = null;
  scriptProcessor = null;
  microphoneSource = null;
  silentGain = null;
  cancelAnimationFrame(waveformFrame);
  startIdleWaveform();
  sessionId = "n/a";
  assistantPartialBubble = null;
  updateSessionId();
  setConnectionState("idle");
  micStatus.textContent = "off";
  wsStatus.textContent = "disconnected";
  latencyStatus.textContent = "pending";
  resetLatencyBreakdown();
  triggerStatus.textContent = "not armed";
  processingStatus.textContent = "idle";
  pipelineHint.textContent = "Press Start. Trigger happens automatically after speech pause is detected.";
  startButton.disabled = false;
  stopButton.disabled = true;
  sendTextButton.disabled = false;
  updateKnowledgeUiState(false, knowledgeInput.value.trim() ? knowledgeStatus.textContent ?? "shared" : "empty");
}

async function sendKnowledgeForIndexing(): Promise<void> {
  if (isIndexingKnowledge) {
    return;
  }

  const markdown = knowledgeInput.value.trim();

  if (!markdown) {
    addEventRow("Client", "Knowledge textarea is empty.");
    return;
  }

  await ensureSocketConnected();
  updateKnowledgeUiState(true, "indexing...");
  updateKnowledgeProgress(4, "Preparing shared indexing session.");
  addEventRow("Client", "Knowledge indexing requested.");
  socket?.send(
    JSON.stringify({
      type: "knowledge.set",
      markdown
    })
  );
}

async function sendTextTurn(): Promise<void> {
  const text = textMessageInput.value.trim();

  if (!text) {
    return;
  }

  await ensureSocketConnected();
  syncRagPromptToServer();
  textMessageInput.value = "";
  socket?.send(
    JSON.stringify({
      type: "text.turn",
      text
    })
  );
}

function connectWebSocket(resolve?: () => void, reject?: (reason?: unknown) => void): void {
  const configuredOrigin = import.meta.env.VITE_BACKEND_ORIGIN?.trim();
  const backendPort = import.meta.env.VITE_BACKEND_PORT ?? "3300";
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const host =
    window.location.port === "5173"
      ? `${window.location.hostname}:${backendPort}`
      : window.location.host;
  const url = configuredOrigin
    ? `${configuredOrigin.replace(/\/$/, "").replace(/^http/, "ws")}/ws`
    : `${protocol}://${host}/ws`;

  socket = new WebSocket(url);
  wsStatus.textContent = "connecting";
  triggerStatus.textContent = "arming";
  setConnectionState("connecting");

  socket.addEventListener("open", () => {
    wsStatus.textContent = "connected";
    sendTextButton.disabled = false;
    updateKnowledgeUiState(false, knowledgeInput.value.trim() ? "shared / stale" : "empty");
    addEventRow("Client", `WS connected: ${url}`);
    syncRagPromptToServer(true);

    socket?.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: Math.round(audioContext?.sampleRate ?? 16000)
      })
    );

    resolve?.();

    window.setTimeout(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        lastPingAt = Date.now();
        socket.send(
          JSON.stringify({
            type: "client.ping",
            at: lastPingAt
          })
        );
      }
    }, 400);
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data) as ServerEvent;
    handleServerEvent(payload);
  });

  socket.addEventListener("close", () => {
    socketConnectPromise = null;
    wsStatus.textContent = "closed";
    sendTextButton.disabled = false;
    applyKnowledgeButton.disabled = isIndexingKnowledge || !knowledgeInput.value.trim();
    setConnectionState("idle");
    addEventRow("Client", "WS connection closed.");
  });

  socket.addEventListener("error", (event) => {
    socketConnectPromise = null;
    reject?.(event);
  });
}

async function ensureSocketConnected(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }

  if (socketConnectPromise) {
    return socketConnectPromise;
  }

  socketConnectPromise = new Promise<void>((resolve, reject) => {
    connectWebSocket(resolve, reject);
  });

  try {
    await socketConnectPromise;
  } finally {
    if (socket?.readyState !== WebSocket.CONNECTING) {
      socketConnectPromise = null;
    }
  }
}

function handleServerEvent(event: ServerEvent): void {
  switch (event.type) {
    case "connection.ready":
      sessionId = event.sessionId;
      updateSessionId();
      addEventRow("Server", `Connection ready. Session ${event.sessionId}`);
      return;

    case "session.started":
      sessionId = event.sessionId;
      updateSessionId();
      setConnectionState("live");
      triggerStatus.textContent = mediaStream ? "listening" : "text ready";
      processingStatus.textContent = "ready";
      pipelineHint.textContent = mediaStream
        ? "Voice trigger is automatic: speak, pause briefly, then inference starts."
        : "Connection is ready for text dialogue and knowledge indexing. Press Start only when you want live microphone mode.";
      addEventRow("Server", `Session started: ${event.sessionId}`);
      return;

    case "session.language":
      addEventRow(
        "Language",
        `${event.language} via ${event.source}${event.changed ? " (updated)" : ""}. ${event.detail}`
      );
      return;

    case "knowledge.indexing":
      if (event.status === "started") {
        updateKnowledgeUiState(true, "indexing...");
        updateKnowledgeProgress(
          event.progressPercent ?? 8,
          event.message,
          event.stage ? `Stage: ${event.stage}` : "Indexing"
        );
      }

      if (event.status === "completed") {
        updateKnowledgeUiState(false, "shared / ready");
        updateKnowledgeProgress(100, event.message, "Completed");
      }

      if (event.status === "failed") {
        updateKnowledgeUiState(false, "index failed");
        updateKnowledgeProgress(100, event.message, "Failed");
      }

      addEventRow("Knowledge", `${event.scope}: ${event.message}`);
      return;

    case "knowledge.indexed":
      updateKnowledgeUiState(false, `shared / ${event.chunks} chunks`);
      updateKnowledgeProgress(100, `Indexed ${event.chunks} chunks for shared retrieval.`, "Completed");
      addEventRow(
        "Server",
        `Markdown indexed. ${event.characters} chars, ${event.lines} lines, ${event.chunks} chunks. Available to future sessions.`
      );
      return;

    case "server.status":
      reflectPipelineStatus(event.phase, event.detail);
      addEventRow("Status", `${event.phase}: ${event.detail}`);
      return;

    case "client.pong": {
      const latency = Math.max(0, Date.now() - lastPingAt);
      addEventRow("Metrics", `Initial WS RTT ${latency} ms`);
      return;
    }

    case "transcript.partial":
      if (event.role === "assistant") {
        upsertAssistantPartialBubble(event.text);
      } else {
        triggerStatus.textContent = "speech detected";
      }
      return;

    case "transcript.final":
      if (event.role === "assistant") {
        finalizeAssistantBubble(event.text);
      } else {
        assistantPartialBubble = null;
        appendChatBubble("user", event.text);
      }
      return;

    case "audio.response.start":
      addEventRow("Audio", "Streaming audio response started.");
      startStreamingAudioResponse(event.mimeType);
      return;

    case "audio.response.chunk":
      appendStreamingAudioChunk(event.base64, event.bytes);
      return;

    case "audio.response.end":
      addEventRow("Audio", `${event.totalBytes} bytes streamed for playback.`);
      finishStreamingAudioResponse();
      return;

    case "audio.response":
      addEventRow("Audio", `${event.bytes} bytes ready for playback.`);
      void playAudioResponse(event.base64, event.mimeType);
      return;

    case "pipeline.metrics":
      latencyStatus.textContent = `${event.totalMs} ms`;
      updateLatencyBreakdown(event);
      processingStatus.textContent = "done";
      {
        const extras = [
          event.elevenlabsTtsFirstByteMs !== undefined
            ? `elevenlabsTtsFirstByte=${event.elevenlabsTtsFirstByteMs}ms`
            : null,
          event.sttFinalizeMs !== undefined ? `sttFinalize=${event.sttFinalizeMs}ms` : null,
          event.voiceToAudioFirstByteMs !== undefined
            ? `voiceToAudioFirstByte=${event.voiceToAudioFirstByteMs}ms`
            : null,
          event.voiceToAudioDeliveredMs !== undefined
            ? `voiceToAudioDelivered=${event.voiceToAudioDeliveredMs}ms`
            : null
        ].filter(Boolean);

      addEventRow(
        "Pipeline",
          `${event.totalMs} ms total; ${event.stages
            .map((stage) => `${stage.name}=${stage.durationMs}ms`)
            .join(", ")}${extras.length ? `; ${extras.join(", ")}` : ""}`
      );
      }
      return;

    case "server.warning":
      addEventRow("Warning", event.message);
      return;

    case "server.error":
      processingStatus.textContent = "error";
      addEventRow("Error", event.message);
      return;
  }
}

function reflectPipelineStatus(phase: string, detail: string): void {
  pipelineHint.textContent = detail;

  if (phase === "idle") {
    triggerStatus.textContent = "idle";
    processingStatus.textContent = "idle";
    return;
  }

  if (phase === "connected" || phase === "listening") {
    triggerStatus.textContent = "listening";
    processingStatus.textContent = "armed";
    return;
  }

  if (phase === "processing") {
    triggerStatus.textContent = "triggered";
    processingStatus.textContent = "running";
    return;
  }

  if (phase === "knowledge_ready") {
    processingStatus.textContent = "knowledge ready";
    return;
  }

  if (phase === "error") {
    processingStatus.textContent = "error";
  }
}

function updateLatencyBreakdown(
  event: Extract<ServerEvent, { type: "pipeline.metrics" }>
): void {
  const stages = new Map(event.stages.map((stage) => [stage.name, stage.durationMs]));

  sttLatencyStatus.textContent = formatLatency(event.sttFinalizeMs, "n/a");
  openaiEmbeddingsStatus.textContent = formatLatency(stages.get("openai_embeddings"));
  qdrantQueryStatus.textContent = formatLatency(stages.get("qdrant_query"));
  groqCompletionStatus.textContent = formatLatency(stages.get("groq_completion"));
  elevenlabsFirstByteStatus.textContent = formatLatency(event.elevenlabsTtsFirstByteMs);
  voiceFirstAudioStatus.textContent = formatLatency(event.voiceToAudioFirstByteMs, "n/a");
}

function resetLatencyBreakdown(): void {
  sttLatencyStatus.textContent = "pending";
  openaiEmbeddingsStatus.textContent = "pending";
  qdrantQueryStatus.textContent = "pending";
  groqCompletionStatus.textContent = "pending";
  elevenlabsFirstByteStatus.textContent = "pending";
  voiceFirstAudioStatus.textContent = "pending";
}

function formatLatency(value: number | undefined, fallback = "pending"): string {
  return value !== undefined ? `${value} ms` : fallback;
}

function addEventRow(title: string, body: string): void {
  const row = document.createElement("article");
  row.className = "event-row";
  row.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
  eventsLog.prepend(row);
}

function appendChatBubble(role: "user" | "assistant", text: string): HTMLElement {
  const bubble = document.createElement("article");
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.innerHTML = `<strong>${role === "user" ? "You" : "Assistant"}</strong><p>${escapeHtml(text)}</p>`;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

function upsertAssistantPartialBubble(text: string): void {
  if (!assistantPartialBubble) {
    assistantPartialBubble = appendChatBubble("assistant", text);
    assistantPartialBubble.classList.add("chat-bubble-partial");
    return;
  }

  const paragraph = assistantPartialBubble.querySelector("p");
  if (paragraph) {
    paragraph.textContent = text;
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function finalizeAssistantBubble(text: string): void {
  if (!assistantPartialBubble) {
    appendChatBubble("assistant", text);
    return;
  }

  assistantPartialBubble.classList.remove("chat-bubble-partial");
  const paragraph = assistantPartialBubble.querySelector("p");
  if (paragraph) {
    paragraph.textContent = text;
  }
  assistantPartialBubble = null;
  chatLog.scrollTop = chatLog.scrollHeight;
}

function updateKnowledgeUiState(isIndexing: boolean, label: string): void {
  isIndexingKnowledge = isIndexing;
  knowledgeStatus.textContent = label;
  applyKnowledgeButton.disabled = isIndexing || !knowledgeInput.value.trim();
  applyKnowledgeButton.textContent = isIndexing ? "Indexing..." : "Index Markdown";
}

function scheduleRagPromptSync(force: boolean): void {
  if (ragPromptSyncTimer !== null) {
    window.clearTimeout(ragPromptSyncTimer);
  }

  ragPromptSyncTimer = window.setTimeout(() => {
    ragPromptSyncTimer = null;
    syncRagPromptToServer(force);
  }, force ? 0 : 280);
}

function syncRagPromptToServer(force = false): void {
  const prompt = normalizePrompt(ragPromptInput.value);

  if (!force && prompt === lastSyncedRagPrompt) {
    setRagPromptStatus(prompt === defaultRagPrompt ? "Local default" : "Synced");
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setRagPromptStatus(prompt === defaultRagPrompt ? "Local default" : "Saved locally");
    return;
  }

  socket.send(
    JSON.stringify({
      type: "prompt.set",
      prompt
    })
  );
  lastSyncedRagPrompt = prompt;
  setRagPromptStatus(prompt === defaultRagPrompt ? "Default synced" : "Synced");
}

function setRagPromptStatus(label: string): void {
  ragPromptStatus.textContent = label;
}

function normalizePrompt(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function updateKnowledgeProgress(percent: number, detail: string, label?: string): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  knowledgeProgressFill.style.width = `${clamped}%`;
  knowledgeProgressValue.textContent = `${clamped}%`;
  knowledgeProgressLabel.textContent = label ?? detail;
  if (detail) {
    knowledgeProgressFill.title = detail;
    knowledgeProgressLabel.setAttribute("title", detail);
  }
}

async function playAudioResponse(base64: string, mimeType: string): Promise<void> {
  disposeActiveAudio();
  const bytes = decodeBase64(base64);
  await playAudioBlob(new Blob([bytes], { type: mimeType }));
}

function disposeActiveAudio(): void {
  activeAudioStream = null;

  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = "";
    activeAudio.load();
    activeAudio = null;
  }

  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

function startStreamingAudioResponse(mimeType: string): void {
  disposeActiveAudio();

  const audio = createPlaybackElement();
  const stream: AudioStreamPlayback = {
    audio,
    mimeType,
    url: null,
    mediaSource: null,
    sourceBuffer: null,
    chunkQueue: [],
    fallbackChunks: [],
    streamEnded: false,
    playbackStarted: false,
    totalBytes: 0
  };

  activeAudioStream = stream;
  activeAudio = audio;

  if (typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mimeType)) {
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    stream.mediaSource = mediaSource;
    stream.url = url;
    activeAudioUrl = url;
    audio.src = url;

    mediaSource.addEventListener(
      "sourceopen",
      () => {
        if (activeAudioStream !== stream || !stream.mediaSource) {
          return;
        }

        stream.sourceBuffer = stream.mediaSource.addSourceBuffer(mimeType);
        stream.sourceBuffer.mode = "sequence";
        stream.sourceBuffer.addEventListener("updateend", () => {
          flushStreamingAudioQueue(stream);
        });
        flushStreamingAudioQueue(stream);
      },
      { once: true }
    );
    return;
  }

  addEventRow("Audio", `Streaming fallback enabled. Browser does not support ${mimeType} via MediaSource.`);
}

function appendStreamingAudioChunk(base64: string, bytes: number): void {
  if (!activeAudioStream) {
    return;
  }

  const chunk = decodeBase64(base64);
  activeAudioStream.totalBytes += bytes;

  if (activeAudioStream.mediaSource) {
    activeAudioStream.chunkQueue.push(chunk);
    flushStreamingAudioQueue(activeAudioStream);
    return;
  }

  activeAudioStream.fallbackChunks.push(chunk);
}

function finishStreamingAudioResponse(): void {
  if (!activeAudioStream) {
    return;
  }

  activeAudioStream.streamEnded = true;

  if (activeAudioStream.mediaSource) {
    flushStreamingAudioQueue(activeAudioStream);
    return;
  }

  void finalizeBufferedStreamingAudio(activeAudioStream);
}

function flushStreamingAudioQueue(stream: AudioStreamPlayback): void {
  if (activeAudioStream !== stream || !stream.sourceBuffer || !stream.mediaSource) {
    return;
  }

  if (stream.sourceBuffer.updating) {
    return;
  }

  const nextChunk = stream.chunkQueue.shift();
  if (nextChunk) {
    stream.sourceBuffer.appendBuffer(nextChunk);
    void ensureStreamingPlaybackStarted(stream);
    return;
  }

  if (stream.streamEnded && stream.mediaSource.readyState === "open") {
    stream.mediaSource.endOfStream();
  }
}

async function finalizeBufferedStreamingAudio(stream: AudioStreamPlayback): Promise<void> {
  if (activeAudioStream !== stream) {
    return;
  }

  const blob = new Blob(stream.fallbackChunks, { type: stream.mimeType });
  stream.fallbackChunks = [];

  if (stream.url) {
    URL.revokeObjectURL(stream.url);
  }

  const url = URL.createObjectURL(blob);
  stream.url = url;
  activeAudioUrl = url;
  stream.audio.src = url;
  await ensureStreamingPlaybackStarted(stream);
}

async function ensureStreamingPlaybackStarted(stream: AudioStreamPlayback): Promise<void> {
  if (activeAudioStream !== stream || stream.playbackStarted) {
    return;
  }

  try {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }

    await stream.audio.play();
    stream.playbackStarted = true;
    addEventRow("Audio", "Playback started.");
  } catch (error) {
    if (activeAudioStream !== stream) {
      return;
    }

    disposeActiveAudio();
    const message = error instanceof Error ? error.message : "Unknown audio playback error";
    addEventRow("Audio", `Playback failed: ${message}`);
  }
}

function createPlaybackElement(): HTMLAudioElement {
  const audio = new Audio();
  audio.preload = "auto";
  audio.setAttribute("playsinline", "true");

  audio.addEventListener(
    "ended",
    () => {
      disposeActiveAudio();
    },
    { once: true }
  );

  audio.addEventListener(
    "error",
    () => {
      addEventRow("Audio", "Playback failed: browser could not decode or start the audio stream.");
    },
    { once: true }
  );

  return audio;
}

async function playAudioBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = createPlaybackElement();
  audio.src = url;
  activeAudio = audio;
  activeAudioUrl = url;

  try {
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }

    await audio.play();
    addEventRow("Audio", "Playback started.");
  } catch (error) {
    disposeActiveAudio();
    const message = error instanceof Error ? error.message : "Unknown audio playback error";
    addEventRow("Audio", `Playback failed: ${message}`);
  }
}

function decodeBase64(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function updateSessionId(): void {
  sessionIdLabel.textContent = `session: ${sessionId}`;
}

function setConnectionState(state: "idle" | "connecting" | "live"): void {
  connectionPill.textContent = state;
  connectionPill.className = `pill ${state === "live" ? "pill-live" : "pill-idle"}`;
}

function setupWaveform(stream: MediaStream): void {
  audioContext = new AudioContext();
  microphoneSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();

  analyser.fftSize = 2048;
  silentGain.gain.value = 0;

  microphoneSource.connect(analyser);
  microphoneSource.connect(scriptProcessor);
  scriptProcessor.connect(silentGain);
  silentGain.connect(audioContext.destination);

  scriptProcessor.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const buffer = new ArrayBuffer(input.length * 2);
    const view = new DataView(buffer);

    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    socket.send(buffer);
  };

  cancelAnimationFrame(waveformFrame);
  drawWaveform();
}

function drawWaveform(): void {
  if (!analyser) {
    startIdleWaveform();
    return;
  }

  const context = waveform.getContext("2d");
  if (!context) {
    return;
  }

  const width = waveform.width;
  const height = waveform.height;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#12221d";
  context.fillRect(0, 0, width, height);
  context.lineWidth = 3;
  context.strokeStyle = "#f5c78d";
  context.beginPath();

  const sliceWidth = width / data.length;
  let x = 0;

  for (let index = 0; index < data.length; index += 1) {
    const value = data[index] / 128;
    const y = (value * height) / 2;

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }

    x += sliceWidth;
  }

  context.lineTo(width, height / 2);
  context.stroke();
  waveformFrame = requestAnimationFrame(drawWaveform);
}

function drawIdleWaveform(): void {
  const context = waveform.getContext("2d");
  if (!context) {
    return;
  }

  context.clearRect(0, 0, waveform.width, waveform.height);
  context.fillStyle = "#12221d";
  context.fillRect(0, 0, waveform.width, waveform.height);
  context.strokeStyle = "rgba(255, 248, 238, 0.22)";
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(0, waveform.height / 2);

  for (let x = 0; x <= waveform.width; x += 18) {
    context.lineTo(x, waveform.height / 2);
  }

  context.stroke();
  context.strokeStyle = "rgba(255, 248, 238, 0.96)";
  context.lineWidth = 4;
  context.shadowColor = "rgba(245, 199, 141, 0.42)";
  context.shadowBlur = 22;
  context.beginPath();
  context.moveTo(0, waveform.height / 2);

  for (let x = 0; x <= waveform.width; x += 16) {
    const y = waveform.height / 2 + Math.sin(x / 28 + idleWavePhase) * 12;
    context.lineTo(x, y);
  }

  context.stroke();
  context.shadowBlur = 0;
}

function startIdleWaveform(): void {
  cancelAnimationFrame(waveformFrame);

  const renderIdleWaveform = () => {
    if (analyser) {
      return;
    }

    drawIdleWaveform();
    idleWavePhase += 0.06;
    waveformFrame = requestAnimationFrame(renderIdleWaveform);
  };

  renderIdleWaveform();
}

function getRequiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing DOM element: ${selector}`);
  }

  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

startIdleWaveform();
sendTextButton.disabled = false;
updateKnowledgeUiState(false, knowledgeInput.value.trim() ? "shared / stale" : "empty");
