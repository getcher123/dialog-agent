export type ClientEvent =
  | {
      type: "session.start";
      sampleRate: number;
    }
  | {
      type: "knowledge.set";
      markdown: string;
    }
  | {
      type: "text.turn";
      text: string;
    }
  | {
      type: "client.ping";
      at: number;
    }
  | {
      type: "audio.append";
      bytes: number;
    };

export type ServerEvent =
  | {
      type: "connection.ready";
      sessionId: string;
    }
  | {
      type: "session.started";
      sessionId: string;
    }
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
  | {
      type: "server.status";
      sessionId: string;
      phase: string;
      detail: string;
    }
  | {
      type: "client.pong";
      at: number;
    }
  | {
      type: "transcript.partial";
      sessionId: string;
      role: "user" | "assistant";
      text: string;
    }
  | {
      type: "transcript.final";
      sessionId: string;
      role: "user" | "assistant";
      text: string;
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
      sttFinalizeMs?: number;
      voiceToAudioFirstByteMs?: number;
      voiceToAudioDeliveredMs?: number;
      stages: Array<{
        name: string;
        durationMs: number;
      }>;
    }
  | {
      type: "server.warning";
      sessionId: string;
      message: string;
    }
  | {
      type: "server.error";
      message: string;
    };
