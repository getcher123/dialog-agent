# ADR 0001: MVP Baseline

Date: 2026-03-24
Status: accepted

## Context

Пользователь аппрувнул старт реализации по плану voice agent с RAG. До этого в репозитории были только ТЗ и план, а код, README и runbook'и отсутствовали.

## Decisions

- Backend stack: `Node.js + TypeScript`
- Audio transport baseline: `raw PCM / small chunks over WebSocket`
- Embeddings provider: `OpenAI text-embedding-3-small`
- Vector DB baseline: `Qdrant local`
- Primary STT provider: `Deepgram Nova-3 Streaming`
- Fallback / A-B STT provider: `ElevenLabs Scribe Realtime v2`
- Deploy target baseline: один Docker-сервис на `Render`
- MVP knowledge input: markdown-контекст вставляется в UI и отправляется на backend как первый ingestion-вариант
- Observability baseline: structured logs + latency timestamps + export summary в markdown/JSON
- Rollback baseline: `redeploy previous image`
- Budget handling: ограничить фактический объём тестов в рамках `$50/мес`

## Consequences

- На старте нужен единый TypeScript-каркас для backend и frontend.
- Полный ASR/RAG/LLM/TTS pipeline можно наращивать поэтапно поверх WebSocket session scaffold.
- `Qdrant local` выбран как единственный vector store для снижения dev/demo latency и исключения внешней managed vector DB из критического пути.
- По фактическому streaming-сравнению на русском `.ogg` primary STT остаётся `Deepgram`: он показал лучший `time-to-first-event` и более точный transcript на тестовой фразе.
- `ElevenLabs Scribe Realtime v2` остаётся резервным вариантом для A/B и fallback, так как завершал транскрипцию чуть быстрее, но хуже распознал тестовую фразу.
- MVP ingestion отклоняется от исходного PDF-first сценария ТЗ и временно заменён на markdown input в UI; это должно быть явно отмечено как scope cut, а не как скрытая замена требований.
- Для `text-embedding-3-small` потребуется отдельный `OPENAI_API_KEY`, а для vector DB больше не нужен отдельный cloud API key.
