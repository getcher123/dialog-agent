# ADR 0002: Runtime And Architecture Skeleton

Date: 2026-03-24
Status: accepted

## Goal

Зафиксировать минимальную рабочую архитектуру, на которой можно безопасно наращивать voice pipeline без повторного выбора каркаса.

## Runtime

- Node.js `24+`
- npm workspaces
- один backend-сервис на `Express + ws`
- frontend на `Vite + vanilla TypeScript`
- общий Dockerfile для single-service deploy на Render
- локальный `Qdrant` как единственный vector store для RAG

## Baseline Structure

- `backend/` — HTTP + WebSocket backend, session lifecycle, provider orchestration
- `frontend/` — browser UI, microphone capture, waveform, transcript/events
- `shared/` — общий протокол и shared types
- `docs/adr/` — зафиксированные инженерные решения
- `docs/validation/` — результаты smoke и preflight
- `scripts/` — вспомогательные smoke и validation scripts

## Planned Transport Shape

```text
Browser mic -> raw PCM chunks -> WebSocket -> backend session
backend session -> ASR -> embeddings -> Qdrant retrieval -> LLM -> TTS
backend -> streamed audio/events -> browser UI
```

На текущем этапе реализован только session scaffold:

- backend health endpoint;
- WebSocket connect/start/ping/knowledge events;
- frontend microphone permission + live waveform;
- markdown knowledge textarea with in-memory storage ack.

## Known Gaps

- raw PCM capture and streaming not wired yet;
- provider integrations not started yet;
- Qdrant integration and embeddings indexing not started yet;
- production metrics pipeline not started yet.
