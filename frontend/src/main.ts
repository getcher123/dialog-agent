import "./styles.css";

type ServerEvent =
  | { type: "connection.ready"; sessionId: string }
  | { type: "session.started"; sessionId: string }
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
const knowledgeInput = getRequiredElement<HTMLTextAreaElement>("#knowledge-input");
const eventsLog = getRequiredElement<HTMLDivElement>("#events-log");
const sessionIdLabel = getRequiredElement<HTMLSpanElement>("#session-id");
const connectionPill = getRequiredElement<HTMLSpanElement>("#connection-pill");
const micStatus = getRequiredElement<HTMLElement>("#mic-status");
const wsStatus = getRequiredElement<HTMLElement>("#ws-status");
const latencyStatus = getRequiredElement<HTMLElement>("#latency-status");
const knowledgeStatus = getRequiredElement<HTMLElement>("#knowledge-status");
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
let assistantPartial = "";

startButton.addEventListener("click", () => {
  void startSession();
});

stopButton.addEventListener("click", () => {
  stopSession();
});

applyKnowledgeButton.addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    addEventRow("Client", "Open session first to send markdown knowledge.");
    return;
  }

  const markdown = knowledgeInput.value.trim();

  if (!markdown) {
    addEventRow("Client", "Knowledge textarea is empty.");
    return;
  }

  socket.send(
    JSON.stringify({
      type: "knowledge.set",
      markdown
    })
  );
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
    startButton.disabled = true;
    stopButton.disabled = false;

    setupWaveform(mediaStream);
    connectWebSocket();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone permission failed";
    addEventRow("Client", `Microphone error: ${message}`);
    micStatus.textContent = "error";
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
  assistantPartial = "";
  sessionId = "n/a";
  updateSessionId();
  setConnectionState("idle");
  micStatus.textContent = "off";
  wsStatus.textContent = "disconnected";
  latencyStatus.textContent = "pending";
  knowledgeStatus.textContent = "empty";
  startButton.disabled = false;
  stopButton.disabled = true;
  applyKnowledgeButton.disabled = true;
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
  setConnectionState("connecting");

  socket.addEventListener("open", () => {
    wsStatus.textContent = "connected";
    applyKnowledgeButton.disabled = false;
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
      addEventRow("Server", `Session started: ${event.sessionId}`);
      return;

    case "knowledge.indexed":
      knowledgeStatus.textContent = `${event.chunks} chunks`;
      addEventRow(
        "Server",
        `Markdown indexed for session ${event.sessionId}. ${event.characters} chars, ${event.lines} lines, ${event.chunks} chunks.`
      );
      return;

    case "server.status":
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
        assistantPartial += event.text;
        addEventRow("Assistant Δ", assistantPartial.slice(-180));
      } else {
        addEventRow("User Δ", event.text);
      }
      return;

    case "transcript.final":
      if (event.role === "assistant") {
        assistantPartial = "";
        addEventRow("Assistant", event.text);
      } else {
        addEventRow("User", event.text);
      }
      return;

    case "audio.response":
      addEventRow("Audio", `${event.bytes} bytes ready for playback.`);
      void playAudioResponse(event.base64, event.mimeType);
      return;

    case "pipeline.metrics":
      latencyStatus.textContent = `${event.totalMs} ms`;
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
      addEventRow("Error", event.message);
      return;
  }
}

function addEventRow(title: string, body: string): void {
  const row = document.createElement("article");
  row.className = "event-row";
  row.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
  eventsLog.prepend(row);
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
