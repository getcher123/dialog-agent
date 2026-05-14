import "./styles.css";
import { isUiLanguage, translations, type UiLanguage, type UiTranslationKey } from "./i18n";

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
const knowledgeSafetyConfirmation = getRequiredElement<HTMLInputElement>("#knowledge-safety-confirmation");
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
const languageButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-language-option]")
);
const onboardingHelpButton = getRequiredElement<HTMLButtonElement>("#onboarding-help");
const onboardingBackdrop = getRequiredElement<HTMLDivElement>("#onboarding-backdrop");
const onboardingTooltip = getRequiredElement<HTMLElement>("#onboarding-tooltip");
const onboardingProgress = getRequiredElement<HTMLElement>("#onboarding-progress");
const onboardingTitle = getRequiredElement<HTMLElement>("#onboarding-title");
const onboardingBody = getRequiredElement<HTMLElement>("#onboarding-body");
const onboardingNextButton = getRequiredElement<HTMLButtonElement>("#onboarding-next");
const onboardingSkipButton = getRequiredElement<HTMLButtonElement>("#onboarding-skip");

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

const TARGET_SAMPLE_RATE = 16000;
const FALLBACK_CAPTURE_BUFFER_SIZE = 1024;
const PCM_CAPTURE_WORKLET = "pcm16-capture-worklet";
const PCM_CAPTURE_WORKLET_URL = new URL("./pcm16-capture-worklet.js", import.meta.url);
const MAX_EVENT_ROWS = 120;
const MAX_CHAT_BUBBLES = 80;
const LANGUAGE_STORAGE_KEY = "voice-agent-ui-language";
const ONBOARDING_STORAGE_KEY = "voice-agent-onboarding-completed";

type TranslatedTextRenderer = () => string;
type ConnectionState = "idle" | "connecting" | "live";
type TourPlacement = "top" | "right" | "bottom" | "left";
type TourStep = {
  targetSelector: string;
  titleKey: UiTranslationKey;
  bodyKey: UiTranslationKey;
  placement: TourPlacement;
};

const latencySlots = {
  total: latencyStatus,
  stt: sttLatencyStatus,
  openaiEmbeddings: openaiEmbeddingsStatus,
  qdrantQuery: qdrantQueryStatus,
  groqCompletion: groqCompletionStatus,
  elevenlabsFirstByte: elevenlabsFirstByteStatus,
  voiceFirstAudio: voiceFirstAudioStatus
} as const;

type LatencySlot = keyof typeof latencySlots;

const ONBOARDING_STEPS: TourStep[] = [
  {
    targetSelector: "#language-switch",
    titleKey: "onboardingLanguageTitle",
    bodyKey: "onboardingLanguageBody",
    placement: "bottom"
  },
  {
    targetSelector: "#knowledge-input",
    titleKey: "onboardingKnowledgeTitle",
    bodyKey: "onboardingKnowledgeBody",
    placement: "right"
  },
  {
    targetSelector: ".waveform-chat-shell",
    titleKey: "onboardingChatTitle",
    bodyKey: "onboardingChatBody",
    placement: "top"
  },
  {
    targetSelector: "#start-button",
    titleKey: "onboardingVoiceTitle",
    bodyKey: "onboardingVoiceBody",
    placement: "bottom"
  },
  {
    targetSelector: ".session-card",
    titleKey: "onboardingStatusTitle",
    bodyKey: "onboardingStatusBody",
    placement: "top"
  }
];

let socket: WebSocket | null = null;
let sessionId = "n/a";
let mediaStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let captureNode: AudioWorkletNode | ScriptProcessorNode | null = null;
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
let lastInterruptRequestAt = 0;
let socketGeneration = 0;
let isStoppingSession = false;
let currentLanguage: UiLanguage = getInitialLanguage();
let connectionState: ConnectionState = "idle";
let micStatusKey: UiTranslationKey = "statusOff";
let wsStatusKey: UiTranslationKey = "statusDisconnected";
let triggerStatusKey: UiTranslationKey = "statusNotArmed";
let processingStatusKey: UiTranslationKey = "statusIdle";
let ragPromptStatusKey: UiTranslationKey = "ragPromptStatusLocalDefault";
let pipelineHintRenderer: TranslatedTextRenderer = () => t("pipelineHintInitial");
let knowledgeStatusRenderer: TranslatedTextRenderer = () => t("statusEmpty");
let knowledgeProgressLabelRenderer: TranslatedTextRenderer = () => t("knowledgeProgressIdle");
let knowledgeProgressDetailRenderer: TranslatedTextRenderer = () => t("knowledgeProgressIdle");
let latencyState: Record<LatencySlot, { value?: number; fallbackKey: UiTranslationKey }> = {
  total: { fallbackKey: "statusPending" },
  stt: { fallbackKey: "statusPending" },
  openaiEmbeddings: { fallbackKey: "statusPending" },
  qdrantQuery: { fallbackKey: "statusPending" },
  groqCompletion: { fallbackKey: "statusPending" },
  elevenlabsFirstByte: { fallbackKey: "statusPending" },
  voiceFirstAudio: { fallbackKey: "statusPending" }
};
let activeOnboardingStepIndex = -1;
let activeOnboardingTarget: HTMLElement | null = null;
let activeOnboardingScope: HTMLElement | null = null;

languageButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const language = button.dataset.languageOption;
    if (isUiLanguage(language)) {
      setLanguage(language);
    }
  });
});

onboardingNextButton.addEventListener("click", () => {
  advanceOnboardingTour();
});

onboardingSkipButton.addEventListener("click", () => {
  completeOnboardingTour();
});

onboardingHelpButton.addEventListener("click", () => {
  startOnboardingTour();
});

window.addEventListener(
  "resize",
  () => {
    if (isOnboardingActive()) {
      positionOnboardingTooltip();
    }
  },
  { passive: true }
);

window.addEventListener(
  "scroll",
  () => {
    if (isOnboardingActive()) {
      positionOnboardingTooltip();
    }
  },
  { passive: true }
);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isOnboardingActive()) {
    completeOnboardingTour();
  }
});

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
  setRagPromptStatus(
    socket?.readyState === WebSocket.OPEN ? "ragPromptStatusSyncing" : "ragPromptStatusLocalDefault"
  );
  scheduleRagPromptSync(true);
});

knowledgeInput.addEventListener("input", () => {
  knowledgeSafetyConfirmation.checked = false;
  updateKnowledgeUiState(isIndexingKnowledge);
});

knowledgeSafetyConfirmation.addEventListener("change", () => {
  updateKnowledgeUiState(isIndexingKnowledge);
});

ragPromptInput.addEventListener("input", () => {
  setRagPromptStatus(
    socket?.readyState === WebSocket.OPEN ? "ragPromptStatusSyncing" : "ragPromptStatusSavedLocally"
  );
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
    isStoppingSession = false;
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    setMicStatus("statusLiveMic");
    setTriggerStatus("statusWaitingForSpeech");
    setProcessingStatus("statusIdle");
    setPipelineHint("pipelineHintMicOpen");
    startButton.disabled = true;
    stopButton.disabled = false;

    await setupWaveform(mediaStream);
    await ensureSocketConnected();
    syncRagPromptToServer();
    if (hadOpenSocket) {
      socket?.send(
        JSON.stringify({
          type: "session.start",
          sampleRate: TARGET_SAMPLE_RATE
        })
      );
    }
    socket?.send(
      JSON.stringify({
        type: "session.greet"
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Microphone permission failed";
    addEventRow("Client", `Microphone error: ${message}`);
    setMicStatus("statusError");
    setTriggerStatus("statusBlocked");
    setPipelineHint("pipelineHintMicRequired");
    startButton.disabled = false;
    stopButton.disabled = true;
  }
}

function stopSession(): void {
  isStoppingSession = true;
  assistantPartialBubble = null;
  lastInterruptRequestAt = 0;

  const closingSocket = socket;
  if (closingSocket?.readyState === WebSocket.OPEN) {
    try {
      closingSocket.send(
        JSON.stringify({
          type: "turn.interrupt",
          reason: "Session stopped by user."
        })
      );
    } catch {
      // Ignore close-race failures from the browser WebSocket stack.
    }
  }

  socket = null;
  socketConnectPromise = null;

  if (captureNode instanceof AudioWorkletNode) {
    captureNode.port.onmessage = null;
    captureNode.disconnect();
  } else if (captureNode instanceof ScriptProcessorNode) {
    captureNode.onaudioprocess = null;
    captureNode.disconnect();
  }

  microphoneSource?.disconnect();
  analyser?.disconnect();
  silentGain?.disconnect();

  if (closingSocket) {
    closingSocket.close();
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
  captureNode = null;
  microphoneSource = null;
  silentGain = null;
  cancelAnimationFrame(waveformFrame);
  startIdleWaveform();
  sessionId = "n/a";
  assistantPartialBubble = null;
  updateSessionId();
  setConnectionState("idle");
  setMicStatus("statusOff");
  setWsStatus("statusDisconnected");
  setLatencySlot("total", undefined, "statusPending");
  resetLatencyBreakdown();
  setTriggerStatus("statusNotArmed");
  setProcessingStatus("statusIdle");
  setPipelineHint("pipelineHintInitial");
  lastInterruptRequestAt = 0;
  startButton.disabled = false;
  stopButton.disabled = true;
  sendTextButton.disabled = false;
  updateKnowledgeUiState(false, knowledgeInput.value.trim() ? undefined : createTextRenderer("statusEmpty"));
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

  if (!knowledgeSafetyConfirmation.checked) {
    addEventRow("Client", "Подтвердите, что KB не содержит чувствительных данных, перед индексацией.");
    updateKnowledgeUiState(false);
    return;
  }

  await ensureSocketConnected();
  updateKnowledgeUiState(true, createTextRenderer("statusIndexing"));
  updateKnowledgeProgress(
    4,
    createTextRenderer("knowledgeProgressPreparingDetail"),
    createTextRenderer("knowledgeProgressPreparingLabel")
  );
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

  const currentGeneration = ++socketGeneration;
  const currentSocket = new WebSocket(url);
  socket = currentSocket;
  currentSocket.binaryType = "arraybuffer";
  setWsStatus("statusConnecting");
  setTriggerStatus("statusArming");
  setConnectionState("connecting");
  isStoppingSession = false;

  currentSocket.addEventListener("open", () => {
    if (socket !== currentSocket || currentGeneration !== socketGeneration) {
      return;
    }

    setWsStatus("statusConnected");
    sendTextButton.disabled = false;
    updateKnowledgeUiState(
      false,
      knowledgeInput.value.trim() ? createTextRenderer("statusSharedStale") : createTextRenderer("statusEmpty")
    );
    addEventRow("Client", `WS connected: ${url}`);
    syncRagPromptToServer(true);

    currentSocket.send(
      JSON.stringify({
        type: "session.start",
        sampleRate: TARGET_SAMPLE_RATE
      })
    );

    resolve?.();

    window.setTimeout(() => {
      if (socket?.readyState === WebSocket.OPEN) {
        lastPingAt = Date.now();
        currentSocket.send(
          JSON.stringify({
            type: "client.ping",
            at: lastPingAt
          })
        );
      }
    }, 400);
  });

  currentSocket.addEventListener("message", (event) => {
    if (socket !== currentSocket || currentGeneration !== socketGeneration || isStoppingSession) {
      return;
    }

    void handleSocketMessage(event);
  });

  currentSocket.addEventListener("close", () => {
    if (socket === currentSocket) {
      socket = null;
    }

    socketConnectPromise = null;

    if (currentGeneration !== socketGeneration) {
      return;
    }

    setWsStatus("statusClosed");
    sendTextButton.disabled = false;
    updateKnowledgeUiState(isIndexingKnowledge);
    setConnectionState("idle");
    addEventRow("Client", "WS connection closed.");
  });

  currentSocket.addEventListener("error", (event) => {
    if (socket === currentSocket) {
      socket = null;
    }

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

async function handleSocketMessage(event: MessageEvent<string | ArrayBuffer | Blob>): Promise<void> {
  if (typeof event.data === "string") {
    const payload = JSON.parse(event.data) as ServerEvent;
    handleServerEvent(payload);
    return;
  }

  if (event.data instanceof ArrayBuffer) {
    appendStreamingAudioChunkBuffer(event.data);
    return;
  }

  if (event.data instanceof Blob) {
    appendStreamingAudioChunkBuffer(await event.data.arrayBuffer());
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
      setTriggerStatus(mediaStream ? "statusListening" : "statusTextReady");
      setProcessingStatus("statusReady");
      setPipelineHint(mediaStream ? "pipelineHintVoiceReady" : "pipelineHintTextReady");
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
        updateKnowledgeUiState(true, createTextRenderer("statusIndexing"));
        updateKnowledgeProgress(
          event.progressPercent ?? 8,
          event.message,
          event.stage
            ? () => `${t("knowledgeProgressStagePrefix")} ${event.stage}`
            : createTextRenderer("buttonIndexing")
        );
      }

      if (event.status === "completed") {
        updateKnowledgeUiState(false, createTextRenderer("statusSharedReady"));
        updateKnowledgeProgress(100, event.message, createTextRenderer("knowledgeProgressCompleted"));
      }

      if (event.status === "failed") {
        updateKnowledgeUiState(false, createTextRenderer("statusIndexFailed"));
        updateKnowledgeProgress(100, event.message, createTextRenderer("knowledgeProgressFailed"));
      }

      addEventRow("Knowledge", `${event.scope}: ${event.message}`);
      return;

    case "knowledge.indexed":
      updateKnowledgeUiState(false, createTextRenderer("statusSharedChunks", { chunks: event.chunks }));
      updateKnowledgeProgress(
        100,
        createTextRenderer("knowledgeIndexedDetail", { chunks: event.chunks }),
        createTextRenderer("knowledgeProgressCompleted")
      );
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
        maybeInterruptAssistantResponse();
        setTriggerStatus("statusSpeechDetected");
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
      setLatencySlot("total", event.totalMs);
      updateLatencyBreakdown(event);
      setProcessingStatus("statusDone");
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
      setProcessingStatus("statusError");
      addEventRow("Error", event.message);
      return;
  }
}

function maybeInterruptAssistantResponse(): void {
  const playbackActive = Boolean(activeAudio || activeAudioStream);
  const pipelineRunning = processingStatusKey === "statusRunning";

  if (!playbackActive && !pipelineRunning) {
    return;
  }

  if (playbackActive) {
    disposeActiveAudio();
    addEventRow("Audio", "Playback interrupted by user speech.");
  }

  const now = Date.now();
  if (now - lastInterruptRequestAt < 800) {
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  lastInterruptRequestAt = now;
  setProcessingStatus("statusInterrupting");
  socket.send(
    JSON.stringify({
      type: "turn.interrupt",
      reason: "Interrupted by user speech."
    })
  );
  addEventRow("Client", "Barge-in detected. Interrupt requested.");
}

function reflectPipelineStatus(phase: string, detail: string): void {
  setPipelineHintRaw(detail);

  if (phase === "idle") {
    setTriggerStatus("statusIdle");
    setProcessingStatus("statusIdle");
    return;
  }

  if (phase === "connected" || phase === "listening") {
    setTriggerStatus("statusListening");
    setProcessingStatus("statusArmed");
    return;
  }

  if (phase === "processing") {
    setTriggerStatus("statusTriggered");
    setProcessingStatus("statusRunning");
    return;
  }

  if (phase === "knowledge_ready") {
    setProcessingStatus("statusKnowledgeReady");
    return;
  }

  if (phase === "error") {
    setProcessingStatus("statusError");
  }
}

function updateLatencyBreakdown(
  event: Extract<ServerEvent, { type: "pipeline.metrics" }>
): void {
  const stages = new Map(event.stages.map((stage) => [stage.name, stage.durationMs]));

  setLatencySlot("stt", event.sttFinalizeMs, "statusNotAvailable");
  setLatencySlot("openaiEmbeddings", stages.get("openai_embeddings"));
  setLatencySlot("qdrantQuery", stages.get("qdrant_query"));
  setLatencySlot("groqCompletion", stages.get("groq_completion"));
  setLatencySlot("elevenlabsFirstByte", event.elevenlabsTtsFirstByteMs);
  setLatencySlot("voiceFirstAudio", event.voiceToAudioFirstByteMs, "statusNotAvailable");
}

function resetLatencyBreakdown(): void {
  setLatencySlot("stt", undefined, "statusPending");
  setLatencySlot("openaiEmbeddings", undefined, "statusPending");
  setLatencySlot("qdrantQuery", undefined, "statusPending");
  setLatencySlot("groqCompletion", undefined, "statusPending");
  setLatencySlot("elevenlabsFirstByte", undefined, "statusPending");
  setLatencySlot("voiceFirstAudio", undefined, "statusPending");
}

function addEventRow(title: string, body: string): void {
  const row = document.createElement("article");
  row.className = "event-row";
  row.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
  eventsLog.prepend(row);

  while (eventsLog.childElementCount > MAX_EVENT_ROWS) {
    eventsLog.lastElementChild?.remove();
  }
}

function appendChatBubble(role: "user" | "assistant", text: string): HTMLElement {
  const bubble = document.createElement("article");
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.dataset.chatRole = role;
  bubble.innerHTML = `<strong data-chat-role-label>${escapeHtml(getChatRoleLabel(role))}</strong><p>${escapeHtml(text)}</p>`;
  chatLog.appendChild(bubble);

  while (chatLog.childElementCount > MAX_CHAT_BUBBLES) {
    chatLog.firstElementChild?.remove();
  }

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

function updateKnowledgeUiState(isIndexing: boolean, labelRenderer?: TranslatedTextRenderer): void {
  isIndexingKnowledge = isIndexing;
  if (labelRenderer) {
    knowledgeStatusRenderer = labelRenderer;
  }
  knowledgeStatus.textContent = knowledgeStatusRenderer();
  const hasKnowledge = Boolean(knowledgeInput.value.trim());
  const canIndexKnowledge = hasKnowledge && knowledgeSafetyConfirmation.checked;
  applyKnowledgeButton.disabled = isIndexing || !canIndexKnowledge;
  applyKnowledgeButton.textContent = t(isIndexing ? "buttonIndexing" : "buttonIndexMarkdown");
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
    setRagPromptStatus(
      prompt === defaultRagPrompt ? "ragPromptStatusLocalDefault" : "ragPromptStatusSynced"
    );
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setRagPromptStatus(
      prompt === defaultRagPrompt ? "ragPromptStatusLocalDefault" : "ragPromptStatusSavedLocally"
    );
    return;
  }

  socket.send(
    JSON.stringify({
      type: "prompt.set",
      prompt
    })
  );
  lastSyncedRagPrompt = prompt;
  setRagPromptStatus(
    prompt === defaultRagPrompt ? "ragPromptStatusDefaultSynced" : "ragPromptStatusSynced"
  );
}

function setRagPromptStatus(labelKey: UiTranslationKey): void {
  ragPromptStatusKey = labelKey;
  ragPromptStatus.textContent = t(labelKey);
}

function normalizePrompt(value: string): string {
  return value.trim().replace(/\r\n/g, "\n");
}

function updateKnowledgeProgress(
  percent: number,
  detail: string | TranslatedTextRenderer,
  label?: string | TranslatedTextRenderer
): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  knowledgeProgressDetailRenderer = toTextRenderer(detail);
  knowledgeProgressLabelRenderer = label ? toTextRenderer(label) : knowledgeProgressDetailRenderer;
  knowledgeProgressFill.style.width = `${clamped}%`;
  knowledgeProgressValue.textContent = `${clamped}%`;
  knowledgeProgressLabel.textContent = knowledgeProgressLabelRenderer();
  const detailText = knowledgeProgressDetailRenderer();
  if (detailText) {
    knowledgeProgressFill.title = detailText;
    knowledgeProgressLabel.setAttribute("title", detailText);
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

function appendStreamingAudioChunkBuffer(chunk: ArrayBuffer): void {
  if (!activeAudioStream) {
    return;
  }

  const normalized = chunk.slice(0);
  activeAudioStream.totalBytes += normalized.byteLength;

  if (activeAudioStream.mediaSource) {
    activeAudioStream.chunkQueue.push(normalized);
    flushStreamingAudioQueue(activeAudioStream);
    return;
  }

  activeAudioStream.fallbackChunks.push(normalized);
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
  const displaySessionId = sessionId === "n/a" ? t("statusNotAvailable") : sessionId;
  sessionIdLabel.textContent = `${t("sessionLabelPrefix")}: ${displaySessionId}`;
}

function setConnectionState(state: ConnectionState): void {
  connectionState = state;
  const labelKey: UiTranslationKey =
    state === "live" ? "statusLive" : state === "connecting" ? "statusConnecting" : "statusIdle";
  connectionPill.textContent = t(labelKey);
  connectionPill.className = `pill ${state === "live" ? "pill-live" : "pill-idle"}`;
}

async function setupWaveform(stream: MediaStream): Promise<void> {
  audioContext = new AudioContext({
    latencyHint: "interactive"
  });
  microphoneSource = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  silentGain = audioContext.createGain();

  analyser.fftSize = 1024;
  silentGain.gain.value = 0;

  microphoneSource.connect(analyser);
  silentGain.connect(audioContext.destination);

  const workletReady = await setupAudioWorkletCapture();
  if (!workletReady) {
    setupScriptProcessorCapture();
  }

  cancelAnimationFrame(waveformFrame);
  drawWaveform();
}

async function setupAudioWorkletCapture(): Promise<boolean> {
  if (!audioContext || !microphoneSource || !silentGain) {
    return false;
  }

  if (typeof AudioWorkletNode === "undefined" || !audioContext.audioWorklet) {
    addEventRow("Audio", "AudioWorklet is unavailable. Falling back to ScriptProcessor capture.");
    return false;
  }

  try {
    await audioContext.audioWorklet.addModule(PCM_CAPTURE_WORKLET_URL.href);
    const workletNode = new AudioWorkletNode(audioContext, PCM_CAPTURE_WORKLET, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit"
    });

    workletNode.port.onmessage = (messageEvent: MessageEvent<ArrayBuffer>) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }

      socket.send(messageEvent.data);
    };

    microphoneSource.connect(workletNode);
    workletNode.connect(silentGain);
    captureNode = workletNode;
    addEventRow("Audio", "AudioWorklet capture enabled. Sending 16kHz PCM frames.");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "AudioWorklet init failed";
    addEventRow("Audio", `AudioWorklet failed: ${message}. Falling back to ScriptProcessor.`);
    return false;
  }
}

function setupScriptProcessorCapture(): void {
  if (!audioContext || !microphoneSource || !silentGain) {
    return;
  }

  const processor = audioContext.createScriptProcessor(FALLBACK_CAPTURE_BUFFER_SIZE, 1, 1);
  processor.onaudioprocess = (event) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    const buffer = encodePcm16(input, audioContext?.sampleRate ?? TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
    if (buffer.byteLength > 0) {
      socket.send(buffer);
    }
  };

  microphoneSource.connect(processor);
  processor.connect(silentGain);
  captureNode = processor;
}

function encodePcm16(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
): ArrayBuffer {
  if (input.length === 0) {
    return new ArrayBuffer(0);
  }

  if (inputSampleRate === outputSampleRate) {
    const pcm = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index]));
      pcm[index] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    }
    return pcm.buffer;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const pcm = new Int16Array(outputLength);
  let position = 0;

  for (let index = 0; index < outputLength; index += 1) {
    const baseIndex = Math.floor(position);
    const nextIndex = Math.min(baseIndex + 1, input.length - 1);
    const mix = position - baseIndex;
    const left = input[baseIndex] ?? 0;
    const right = input[nextIndex] ?? left;
    const sample = Math.max(-1, Math.min(1, left + (right - left) * mix));
    pcm[index] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    position += ratio;
  }

  return pcm.buffer;
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

function getInitialLanguage(): UiLanguage {
  try {
    const storedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (isUiLanguage(storedLanguage)) {
      return storedLanguage;
    }
  } catch {
    // localStorage can be unavailable in private or restricted browser contexts.
  }

  return getBrowserLanguage();
}

function getBrowserLanguage(): UiLanguage {
  const primaryLanguage = navigator.languages?.[0] ?? navigator.language ?? "";
  return primaryLanguage.toLowerCase().startsWith("ru") ? "ru" : "en";
}

function setLanguage(language: UiLanguage): void {
  currentLanguage = language;

  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Persisting the UI preference is best-effort.
  }

  applyLanguage();
}

function applyLanguage(): void {
  document.documentElement.lang = currentLanguage;
  document.title = t("pageTitle");

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = getTranslationKey(element.dataset.i18n);
    if (key) {
      element.textContent = t(key);
    }
  });

  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((element) => {
    const key = getTranslationKey(element.dataset.i18nPlaceholder);
    if (key) {
      element.placeholder = t(key);
    }
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = getTranslationKey(element.dataset.i18nAriaLabel);
    if (key) {
      element.setAttribute("aria-label", t(key));
    }
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = getTranslationKey(element.dataset.i18nTitle);
    if (key) {
      element.setAttribute("title", t(key));
    }
  });

  renderLanguageButtons();
  renderDynamicUi();
}

function renderLanguageButtons(): void {
  languageButtons.forEach((button) => {
    const isActive = button.dataset.languageOption === currentLanguage;
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function renderDynamicUi(): void {
  setConnectionState(connectionState);
  setMicStatus(micStatusKey);
  setWsStatus(wsStatusKey);
  setTriggerStatus(triggerStatusKey);
  setProcessingStatus(processingStatusKey);
  setRagPromptStatus(ragPromptStatusKey);
  renderLatencySlots();
  updateSessionId();
  pipelineHint.textContent = pipelineHintRenderer();
  knowledgeStatus.textContent = knowledgeStatusRenderer();
  applyKnowledgeButton.textContent = t(isIndexingKnowledge ? "buttonIndexing" : "buttonIndexMarkdown");
  knowledgeProgressLabel.textContent = knowledgeProgressLabelRenderer();
  const detailText = knowledgeProgressDetailRenderer();
  knowledgeProgressFill.title = detailText;
  knowledgeProgressLabel.setAttribute("title", detailText);
  renderChatRoleLabels();
  if (isOnboardingActive()) {
    renderOnboardingStep(false);
  }
}

function getTranslationKey(value: string | undefined): UiTranslationKey | null {
  if (value && value in translations.ru) {
    return value as UiTranslationKey;
  }

  return null;
}

function t(key: UiTranslationKey): string {
  return translations[currentLanguage][key];
}

function formatTranslation(
  key: UiTranslationKey,
  params?: Record<string, string | number>
): string {
  const template = t(key);
  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  );
}

function createTextRenderer(
  key: UiTranslationKey,
  params?: Record<string, string | number>
): TranslatedTextRenderer {
  return () => formatTranslation(key, params);
}

function toTextRenderer(value: string | TranslatedTextRenderer): TranslatedTextRenderer {
  return typeof value === "function" ? value : () => value;
}

function setPipelineHint(labelKey: UiTranslationKey): void {
  pipelineHintRenderer = createTextRenderer(labelKey);
  pipelineHint.textContent = pipelineHintRenderer();
}

function setPipelineHintRaw(value: string): void {
  pipelineHintRenderer = () => value;
  pipelineHint.textContent = value;
}

function setMicStatus(labelKey: UiTranslationKey): void {
  micStatusKey = labelKey;
  micStatus.textContent = t(labelKey);
}

function setWsStatus(labelKey: UiTranslationKey): void {
  wsStatusKey = labelKey;
  wsStatus.textContent = t(labelKey);
}

function setTriggerStatus(labelKey: UiTranslationKey): void {
  triggerStatusKey = labelKey;
  triggerStatus.textContent = t(labelKey);
}

function setProcessingStatus(labelKey: UiTranslationKey): void {
  processingStatusKey = labelKey;
  processingStatus.textContent = t(labelKey);
}

function setLatencySlot(
  slot: LatencySlot,
  value?: number,
  fallbackKey: UiTranslationKey = "statusPending"
): void {
  latencyState = {
    ...latencyState,
    [slot]: {
      value,
      fallbackKey
    }
  };
  renderLatencySlot(slot);
}

function renderLatencySlots(): void {
  (Object.keys(latencySlots) as LatencySlot[]).forEach((slot) => {
    renderLatencySlot(slot);
  });
}

function renderLatencySlot(slot: LatencySlot): void {
  const state = latencyState[slot];
  latencySlots[slot].textContent = state.value !== undefined ? `${state.value} ms` : t(state.fallbackKey);
}

function getChatRoleLabel(role: "user" | "assistant"): string {
  return t(role === "user" ? "chatRoleUser" : "chatRoleAssistant");
}

function renderChatRoleLabels(): void {
  document.querySelectorAll<HTMLElement>("[data-chat-role]").forEach((bubble) => {
    const role = bubble.dataset.chatRole;
    if (role !== "user" && role !== "assistant") {
      return;
    }

    const label = bubble.querySelector<HTMLElement>("[data-chat-role-label]");
    if (label) {
      label.textContent = getChatRoleLabel(role);
    }
  });
}

function shouldStartOnboardingTour(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_STORAGE_KEY) !== "true";
  } catch {
    return true;
  }
}

function startOnboardingTour(): void {
  clearOnboardingHighlight();
  activeOnboardingStepIndex = 0;
  onboardingBackdrop.hidden = false;
  onboardingTooltip.hidden = false;
  document.body.classList.add("onboarding-active");
  renderOnboardingStep(true);
}

function advanceOnboardingTour(): void {
  if (!isOnboardingActive()) {
    return;
  }

  if (activeOnboardingStepIndex >= ONBOARDING_STEPS.length - 1) {
    completeOnboardingTour();
    return;
  }

  activeOnboardingStepIndex += 1;
  renderOnboardingStep(true);
}

function completeOnboardingTour(): void {
  try {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
  } catch {
    // Completion persistence is best-effort, matching language persistence.
  }

  clearOnboardingHighlight();
  activeOnboardingStepIndex = -1;
  onboardingBackdrop.hidden = true;
  onboardingTooltip.hidden = true;
  document.body.classList.remove("onboarding-active");
}

function isOnboardingActive(): boolean {
  return activeOnboardingStepIndex >= 0;
}

function renderOnboardingStep(shouldScroll: boolean): void {
  const step = ONBOARDING_STEPS[activeOnboardingStepIndex];
  if (!step) {
    completeOnboardingTour();
    return;
  }

  const target = document.querySelector<HTMLElement>(step.targetSelector);
  if (!target) {
    advanceOnboardingTour();
    return;
  }

  clearOnboardingHighlight();
  activeOnboardingTarget = target;
  activeOnboardingTarget.classList.add("tour-highlight");
  const targetCard = target.closest<HTMLElement>(".card");
  if (targetCard && targetCard !== target) {
    activeOnboardingScope = targetCard;
    activeOnboardingScope.classList.add("tour-highlight-scope");
  }

  onboardingProgress.textContent = formatTranslation("onboardingProgress", {
    current: activeOnboardingStepIndex + 1,
    total: ONBOARDING_STEPS.length
  });
  onboardingTitle.textContent = t(step.titleKey);
  onboardingBody.textContent = t(step.bodyKey);
  onboardingSkipButton.textContent = t("onboardingSkip");
  onboardingNextButton.textContent =
    activeOnboardingStepIndex === ONBOARDING_STEPS.length - 1
      ? t("onboardingDone")
      : t("onboardingNext");

  if (shouldScroll) {
    target.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    window.setTimeout(positionOnboardingTooltip, 260);
  }

  positionOnboardingTooltip();
}

function clearOnboardingHighlight(): void {
  activeOnboardingTarget?.classList.remove("tour-highlight");
  activeOnboardingScope?.classList.remove("tour-highlight-scope");
  activeOnboardingTarget = null;
  activeOnboardingScope = null;
}

function positionOnboardingTooltip(): void {
  const step = ONBOARDING_STEPS[activeOnboardingStepIndex];
  if (!step || !activeOnboardingTarget || onboardingTooltip.hidden) {
    return;
  }

  if (window.matchMedia("(max-width: 640px)").matches) {
    onboardingTooltip.removeAttribute("style");
    return;
  }

  const gap = 16;
  const margin = 16;
  const targetRect = activeOnboardingTarget.getBoundingClientRect();
  const tooltipRect = onboardingTooltip.getBoundingClientRect();
  const placements = getPreferredPlacements(step.placement);
  const coordinates = placements
    .map((placement) => getTooltipCoordinates(placement, targetRect, tooltipRect, gap))
    .find((candidate) =>
      candidate.left >= margin &&
      candidate.top >= margin &&
      candidate.left + tooltipRect.width <= window.innerWidth - margin &&
      candidate.top + tooltipRect.height <= window.innerHeight - margin
    );

  const fallback = coordinates ?? {
    left: clamp((window.innerWidth - tooltipRect.width) / 2, margin, window.innerWidth - tooltipRect.width - margin),
    top: clamp(targetRect.bottom + gap, margin, window.innerHeight - tooltipRect.height - margin)
  };

  onboardingTooltip.style.left = `${Math.round(fallback.left)}px`;
  onboardingTooltip.style.top = `${Math.round(fallback.top)}px`;
  onboardingTooltip.style.right = "auto";
  onboardingTooltip.style.bottom = "auto";
}

function getPreferredPlacements(preferred: TourPlacement): TourPlacement[] {
  const fallbacks: TourPlacement[] = ["bottom", "top", "right", "left"];
  return [preferred, ...fallbacks.filter((placement) => placement !== preferred)];
}

function getTooltipCoordinates(
  placement: TourPlacement,
  targetRect: DOMRect,
  tooltipRect: DOMRect,
  gap: number
): { left: number; top: number } {
  if (placement === "top") {
    return {
      left: targetRect.left + (targetRect.width - tooltipRect.width) / 2,
      top: targetRect.top - tooltipRect.height - gap
    };
  }

  if (placement === "right") {
    return {
      left: targetRect.right + gap,
      top: targetRect.top + (targetRect.height - tooltipRect.height) / 2
    };
  }

  if (placement === "left") {
    return {
      left: targetRect.left - tooltipRect.width - gap,
      top: targetRect.top + (targetRect.height - tooltipRect.height) / 2
    };
  }

  return {
    left: targetRect.left + (targetRect.width - tooltipRect.width) / 2,
    top: targetRect.bottom + gap
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
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

applyLanguage();
startIdleWaveform();
sendTextButton.disabled = false;
knowledgeSafetyConfirmation.checked = false;
updateKnowledgeUiState(
  false,
  knowledgeInput.value.trim() ? createTextRenderer("statusSharedStale") : createTextRenderer("statusEmpty")
);
if (shouldStartOnboardingTour()) {
  window.setTimeout(startOnboardingTour, 350);
}
