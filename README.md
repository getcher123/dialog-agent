# Voice Agent RAG

MVP-репозиторий для голосового агента с RAG по ТЗ в [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md).

## Current Scope

- `backend/`: `Node.js + TypeScript + Express + ws`
- `frontend/`: `Vite + vanilla TypeScript`
- `shared/`: место под общий протокол и типы
- `docs/adr/`: зафиксированные инженерные решения

На текущем этапе собран baseline и уже работает минимальный live pipeline:

- backend healthcheck, live WebSocket runtime и telemetry breakdown endpoint;
- frontend с voice mode, text mode, markdown-ingestion, progress bar индексации и streaming playback ответа;
- `raw PCM -> Deepgram -> OpenAI embeddings -> Qdrant -> Groq -> ElevenLabs -> browser`;
- backend и frontend уже умеют chunked TTS delivery: `audio.response.start -> audio.response.chunk* -> audio.response.end`;
- provider smoke, latency smoke и `text-turn` / WS smoke проверки;
- `.env.example` и Docker-first структура.

## Provider Baseline

- Primary STT: `Deepgram Nova-3 Streaming`
- Fallback / A-B STT: `ElevenLabs Scribe Realtime v2`
- Embeddings: `OpenAI text-embedding-3-small`
- Vector DB: `Qdrant local`
- LLM: `Groq`
- Primary TTS model by current measurement: `eleven_turbo_v2_5`

Текущие замеры и сравнения лежат в `docs/validation/`.

## Current UX

- `Start` нужен только для live microphone mode.
- `Send Text` работает без включения микрофона.
- `Index Markdown` тоже работает без `Start`: frontend сам открывает backend session без mic capture.
- В knowledge card есть видимый progress bar с backend milestones:
  - `queued`
  - `chunking`
  - `embedding`
  - `storing`
  - `completed`
- Voice metrics расширены:
  - `sttFinalizeMs`
  - `voiceToAudioFirstByteMs`
  - `voiceToAudioDeliveredMs`

Важно:

- новые voice latency метрики появляются только на voice-path;
- для `text.turn` они не заполняются, потому что STT там не участвует.

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

На текущем состоянии Pages frontend уже совместим и со старым форматом ответа `audio.response`, и с новым chunked форматом:

- `audio.response.start`
- `audio.response.chunk`
- `audio.response.end`

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
- runtime transport: `ws-raw-pcm-live`

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

Замечания по deploy:

- Amvera git branch отслеживается как `master`, поэтому из локального `main` push делается как `HEAD -> master`;
- после push может потребоваться `restart` или `rebuild`, если платформа держит старый runtime;
- backend требует доступный `QDRANT_URL`;
- frontend для Pages читает backend origin через `VITE_BACKEND_ORIGIN`.

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

## Runtime Protocol Highlights

Основные server events:

- `transcript.partial`
- `transcript.final`
- `knowledge.indexing`
- `knowledge.indexed`
- `audio.response.start`
- `audio.response.chunk`
- `audio.response.end`
- `pipeline.metrics`

Это позволяет:

- отдельно мерить retrieval / generation / TTS;
- видеть прогресс knowledge indexing;
- начинать playback до полной сборки всего MP3.

## Next Milestones

- снять полноценный voice end-to-end latency smoke с реальным аудиовходом на проде;
- добавить interruption / barge-in behavior поверх текущего streaming playback;
- подготовить более явный post-deploy smoke для Amvera rollout;
- при необходимости вынести shared WS protocol types в `shared/`.
