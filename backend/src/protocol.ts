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
      type: "knowledge.indexed";
      sessionId: string;
      characters: number;
      lines: number;
      chunks: number;
    }
  | {
      type: "server.status";
      sessionId: string;
      phase: "idle" | "connected" | "knowledge_ready";
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
  | {
      type: "server.warning";
      sessionId: string;
      message: string;
    }
  | {
      type: "server.error";
      message: string;
    };
