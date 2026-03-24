# Voice Agent RAG

MVP-репозиторий для голосового агента с RAG по ТЗ в [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md).

## Current Scope

- `backend/`: `Node.js + TypeScript + Express + ws`
- `frontend/`: `Vite + vanilla TypeScript`
- `shared/`: место под общий протокол и типы
- `docs/adr/`: зафиксированные инженерные решения

На текущем этапе собран baseline и уже работает минимальный live pipeline:

- backend healthcheck, live WebSocket runtime и telemetry breakdown endpoint;
- frontend с кнопками `Start` / `Stop`, живым waveform микрофона, markdown-ingestion и mp3 playback ответа;
- `raw PCM -> Deepgram -> OpenAI embeddings -> Qdrant local -> Groq -> ElevenLabs -> browser`;
- provider smoke, latency smoke, streaming-comparison и `text-turn smoke` scripts;
- `.env.example` и Docker-first структура.

## Provider Baseline

- Primary STT: `Deepgram Nova-3 Streaming`
- Fallback / A-B STT: `ElevenLabs Scribe Realtime v2`
- Embeddings: `OpenAI text-embedding-3-small`
- Vector DB: `Qdrant local`
- LLM: `Groq`
- Primary TTS model by current measurement: `eleven_turbo_v2_5`

Текущие замеры и сравнения лежат в `docs/validation/`.

## Prerequisites

- Node.js `24+`
- npm `11+`
- Docker `29+` для контейнерного прогона

## Local Run

```bash
npm install
docker run -d --name dialog-agent-qdrant -p 6333:6333 -v "$(pwd)/.qdrant:/qdrant/storage" qdrant/qdrant
npm run dev
```

После старта:

- frontend: `http://localhost:5173`
- backend: `http://localhost:3300`
- health: `http://localhost:3300/health`
- qdrant: `http://localhost:6333/dashboard`

## GitHub Pages Frontend

Статический frontend готов к deploy на GitHub Pages через [gh-pages workflow](/mnt/c/Dialog-agent/.github/workflows/gh-pages.yml).

Что настроено:

- Vite `base` берётся из `VITE_BASE`
- Pages workflow публикует `frontend/dist`
- автоматически создаются `.nojekyll` и `404.html` для SPA fallback

Ожидаемый URL:

- `https://getcher123.github.io/dialog-agent/`

Что нужно включить в GitHub:

1. `Settings -> Pages -> Source = GitHub Actions`
2. `Settings -> Secrets and variables -> Actions -> Variables`

Добавь variable:

- `VITE_BACKEND_ORIGIN=https://<your-amvera-backend-domain>`

Важно:

- frontend и backend будут на разных origin
- frontend читает backend origin на build-time через `VITE_BACKEND_ORIGIN`
- локально без этого env всё продолжает работать через `localhost:3300`

## Amvera Backend

Backend подготовлен под Amvera Docker deploy:

- [Dockerfile](/mnt/c/Dialog-agent/Dockerfile)
- [amvera.yaml](/mnt/c/Dialog-agent/amvera.yaml)

Базовая модель:

- Amvera собирает root Docker image
- backend слушает `PORT=3000`
- health endpoint: `/health`

Нужно задать env vars в Amvera:

- `PORT=3000`
- `NODE_ENV=production`
- `FRONTEND_DIST_PATH=/app/frontend/dist`
- `DEEPGRAM_API`
- `GROQ_API`
- `ELEVENLABS_API`
- `OPENAI_API_KEY`
- `ELEVENLABS_VOICE_ID`
- `ELEVENLABS_MODEL_ID`
- `QDRANT_URL`
- `QDRANT_COLLECTION`
- `CORS_ORIGIN`

Ограничение на сейчас:

- `amvera` CLI в этой среде не залогинен, поэтому я могу подготовить deploy-конфиг, но не могу завершить реальный publish без `amvera login`
- backend требует доступный Qdrant endpoint; для Amvera нужно отдельно решить, где будет жить hosted Qdrant

## Build

```bash
npm run build
```

## Production Start

```bash
npm start
```

## Environment

Смотри [.env.example](/mnt/c/Dialog-agent/.env.example). Секреты в репозиторий не добавляются.
Для local dev backend по умолчанию работает на `3300`, чтобы не конфликтовать с уже занятым `3000`; для deploy порт задаётся через env, в Docker baseline оставлен `3000`.

## Next Milestones

- локально прогнать browser E2E по acceptance-сценариям RU/EN/not-found;
- сохранить `ElevenLabs Scribe` как fallback/A-B STT path;
- добавить interruption/barge-in behavior поверх текущего playback;
- подготовить Docker/deploy smoke и post-deploy checks.
