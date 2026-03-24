import "./styles.css";

type ServerEvent =
  | { type: "connection.ready"; sessionId: string }
  | { type: "session.started"; sessionId: string }
  | {
      type: "knowledge.indexing";
      sessionId: string;
      status: "started" | "completed" | "failed";
      scope: "shared";
      message: string;
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
      type: "pipeline.metrics";
      sessionId: string;
      traceId: string;
      totalMs: number;
      firstByteMs?: number;
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
const knowledgeInput = getRequiredElement<HTMLTextAreaElement>("#knowledge-input");
const textMessageInput = getRequiredElement<HTMLTextAreaElement>("#text-message-input");
const eventsLog = getRequiredElement<HTMLDivElement>("#events-log");
const chatLog = getRequiredElement<HTMLDivElement>("#chat-log");
const sessionIdLabel = getRequiredElement<HTMLSpanElement>("#session-id");
const connectionPill = getRequiredElement<HTMLSpanElement>("#connection-pill");
const micStatus = getRequiredElement<HTMLElement>("#mic-status");
const wsStatus = getRequiredElement<HTMLElement>("#ws-status");
const latencyStatus = getRequiredElement<HTMLElement>("#latency-status");
const knowledgeStatus = getRequiredElement<HTMLElement>("#knowledge-status");
const triggerStatus = getRequiredElement<HTMLElement>("#trigger-status");
const processingStatus = getRequiredElement<HTMLElement>("#processing-status");
const pipelineHint = getRequiredElement<HTMLElement>("#pipeline-hint");
const waveform = getRequiredElement<HTMLCanvasElement>("#waveform");

let socket: WebSocket | null = null;
let sessionId = "n/a";
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let scriptProcessor: ScriptProcessorNode | null = null;
let microphoneSource: MediaStreamAudioSourceNode | null = null;
let silentGain: GainNode | null = null;
let waveformFrame = 0;
let lastPingAt = 0;
let activeAudio: HTMLAudioElement | null = null;
let isIndexingKnowledge = false;
let assistantPartialBubble: HTMLElement | null = null;

startButton.addEventListener("click", () => {
  void startSession();
});

stopButton.addEventListener("click", () => {
  stopSession();
});

applyKnowledgeButton.addEventListener("click", () => {
  sendKnowledgeForIndexing();
});

sendTextButton.addEventListener("click", () => {
  sendTextTurn();
});

textMessageInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    sendTextTurn();
  }
});

async function startSession(): Promise<void> {
  if (socket?.readyState === WebSocket.OPEN) {
    return;
  }

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
    connectWebSocket();
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
    activeAudio.pause();
    URL.revokeObjectURL(activeAudio.src);
    activeAudio = null;
  }

  analyser = null;
  scriptProcessor = null;
  microphoneSource = null;
  silentGain = null;
  cancelAnimationFrame(waveformFrame);
  drawIdleWaveform();
  sessionId = "n/a";
  assistantPartialBubble = null;
  updateSessionId();
  setConnectionState("idle");
  micStatus.textContent = "off";
  wsStatus.textContent = "disconnected";
  latencyStatus.textContent = "pending";
  triggerStatus.textContent = "not armed";
  processingStatus.textContent = "idle";
  pipelineHint.textContent = "Press Start. Trigger happens automatically after speech pause is detected.";
  startButton.disabled = false;
  stopButton.disabled = true;
  sendTextButton.disabled = true;
  updateKnowledgeUiState(false, knowledgeInput.value.trim() ? knowledgeStatus.textContent ?? "shared" : "empty");
}

function sendKnowledgeForIndexing(): void {
  if (isIndexingKnowledge) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addEventRow("Client", "Open session first to index markdown knowledge.");
    return;
  }

  const markdown = knowledgeInput.value.trim();

  if (!markdown) {
    addEventRow("Client", "Knowledge textarea is empty.");
    return;
  }

  updateKnowledgeUiState(true, "indexing...");
  addEventRow("Client", "Knowledge indexing requested.");
  socket.send(
    JSON.stringify({
      type: "knowledge.set",
      markdown
    })
  );
}

function sendTextTurn(): void {
  const text = textMessageInput.value.trim();

  if (!text) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addEventRow("Client", "Open session first to send text messages.");
    return;
  }

  textMessageInput.value = "";
  socket.send(
    JSON.stringify({
      type: "text.turn",
      text
    })
  );
}

function connectWebSocket(): void {
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

    socket?.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: Math.round(audioContext?.sampleRate ?? 16000)
      })
    );

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
    wsStatus.textContent = "closed";
    sendTextButton.disabled = true;
    applyKnowledgeButton.disabled = true;
    setConnectionState("idle");
    addEventRow("Client", "WS connection closed.");
  });
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
      triggerStatus.textContent = "listening";
      processingStatus.textContent = "ready";
      pipelineHint.textContent = "Voice trigger is automatic: speak, pause briefly, then inference starts.";
      addEventRow("Server", `Session started: ${event.sessionId}`);
      return;

    case "knowledge.indexing":
      if (event.status === "started") {
        updateKnowledgeUiState(true, "indexing...");
      }

      if (event.status === "completed") {
        updateKnowledgeUiState(false, "shared / ready");
      }

      if (event.status === "failed") {
        updateKnowledgeUiState(false, "index failed");
      }

      addEventRow("Knowledge", `${event.scope}: ${event.message}`);
      return;

    case "knowledge.indexed":
      updateKnowledgeUiState(false, `shared / ${event.chunks} chunks`);
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
      latencyStatus.textContent = `${latency} ms`;
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

    case "audio.response":
      addEventRow("Audio", `${event.bytes} bytes ready for playback.`);
      void playAudioResponse(event.base64, event.mimeType);
      return;

    case "pipeline.metrics":
      latencyStatus.textContent = `${event.totalMs} ms`;
      processingStatus.textContent = "done";
      addEventRow(
        "Pipeline",
        `${event.totalMs} ms total; ${event.stages
          .map((stage) => `${stage.name}=${stage.durationMs}ms`)
          .join(", ")}`
      );
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
  applyKnowledgeButton.disabled = isIndexing || !socket || socket.readyState !== WebSocket.OPEN;
  applyKnowledgeButton.textContent = isIndexing ? "Indexing..." : "Index Markdown";
}

async function playAudioResponse(base64: string, mimeType: string): Promise<void> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);

  if (activeAudio) {
    activeAudio.pause();
    URL.revokeObjectURL(activeAudio.src);
  }

  activeAudio = new Audio(url);
  activeAudio.addEventListener(
    "ended",
    () => {
      URL.revokeObjectURL(url);
    },
    { once: true }
  );

  await activeAudio.play();
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

  drawWaveform();
}

function drawWaveform(): void {
  if (!analyser) {
    drawIdleWaveform();
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
  context.strokeStyle = "rgba(245, 199, 141, 0.45)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(0, waveform.height / 2);

  for (let x = 0; x <= waveform.width; x += 24) {
    const y = waveform.height / 2 + Math.sin(x / 18) * 8;
    context.lineTo(x, y);
  }

  context.stroke();
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

drawIdleWaveform();
