import { randomUUID } from "node:crypto";
import type WebSocket from "ws";

export type SessionPhase = "idle" | "connected" | "knowledge_ready";

export interface SessionState {
  id: string;
  phase: SessionPhase;
  knowledgeMarkdown: string;
  audioBytes: number;
  sampleRate: number | null;
  lastUserTranscript: string;
  lastAssistantTranscript: string;
  connectedAt: number;
  updatedAt: number;
}

export class SessionManager {
  private readonly sessions = new Map<WebSocket, SessionState>();

  create(connection: WebSocket): SessionState {
    const state: SessionState = {
      id: randomUUID(),
      phase: "idle",
      knowledgeMarkdown: "",
      audioBytes: 0,
      sampleRate: null,
      lastUserTranscript: "",
      lastAssistantTranscript: "",
      connectedAt: Date.now(),
      updatedAt: Date.now()
    };

    this.sessions.set(connection, state);
    return state;
  }

  get(connection: WebSocket): SessionState | undefined {
    return this.sessions.get(connection);
  }

  start(connection: WebSocket, sampleRate: number): SessionState {
    const state = this.mustGet(connection);
    state.phase = "connected";
    state.sampleRate = sampleRate;
    state.updatedAt = Date.now();
    return state;
  }

  updateKnowledge(connection: WebSocket, markdown: string): SessionState {
    const state = this.mustGet(connection);
    state.knowledgeMarkdown = markdown;
    state.phase = "knowledge_ready";
    state.updatedAt = Date.now();
    return state;
  }

  appendAudio(connection: WebSocket, bytes: number): SessionState {
    const state = this.mustGet(connection);
    state.audioBytes += bytes;
    state.updatedAt = Date.now();
    return state;
  }

  setLastUserTranscript(connection: WebSocket, text: string): SessionState {
    const state = this.mustGet(connection);
    state.lastUserTranscript = text;
    state.updatedAt = Date.now();
    return state;
  }

  setLastAssistantTranscript(connection: WebSocket, text: string): SessionState {
    const state = this.mustGet(connection);
    state.lastAssistantTranscript = text;
    state.updatedAt = Date.now();
    return state;
  }

  remove(connection: WebSocket): void {
    this.sessions.delete(connection);
  }

  stats(): { activeSessions: number } {
    return {
      activeSessions: this.sessions.size
    };
  }

  private mustGet(connection: WebSocket): SessionState {
    const state = this.sessions.get(connection);

    if (!state) {
      throw new Error("Session not found");
    }

    return state;
  }
}
