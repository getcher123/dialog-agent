# План реализации: Voice Agent с RAG

Created: 2026-03-22
Status: in_progress

## Goal

Подготовить и вести исполнение MVP voice agent по ТЗ из [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md): браузерный двусторонний голосовой диалог, RAG по документам, streaming ASR/LLM/TTS, Docker-деплой и проверяемые метрики latency.

## Constraints

- [ ] Реализация должна соответствовать [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md).
- [ ] Целевые метрики: `first audio latency < 600 мс p95`, `end-to-end latency < 800 мс` для коротких ответов.
- [ ] Целевой бюджет: до `$50/мес`; в ТЗ зафиксировано противоречие с оценкой `$60` на `1000` минут, это нужно закрыть отдельным решением.
- [ ] Деплой должен быть Docker-first и конфигурироваться через env vars без хранения секретов в репозитории.
- [ ] Требуется поддержка минимум `10` одновременных сессий в MVP-контуре.
- [ ] План не запускает реализацию автоматически; сначала снимаются decision points и только затем начинается исполнение.

## Out Of Scope

- production-grade multi-region отказоустойчивость;
- полноценная авторизация и управление пользователями;
- биллинг и тарификация конечных пользователей;
- долгосрочное хранение персональных голосовых данных вне явно согласованного объёма MVP.

## Sources Of Truth

- [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md) — текущий продуктовый и технический baseline.
- [README.md](/mnt/c/Dialog-agent/README.md) — текущий run/start baseline.
- [docs/adr/0001-mvp-baseline.md](/mnt/c/Dialog-agent/docs/adr/0001-mvp-baseline.md) — утверждённые MVP-решения.
- [docs/adr/0002-runtime-and-architecture.md](/mnt/c/Dialog-agent/docs/adr/0002-runtime-and-architecture.md) — каркас runtime и архитектуры.
- `AGENTS.md` в корне репозитория не найден.
- Документация по инфраструктуре, деплою, инцидентам и доступам в репозитории не найдена.

## Required Context Docs (Read Before Execution)

- [ ] `AGENTS.md` reviewed (if present). Текущий статус: файл отсутствует.
- [x] [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md) reviewed and accepted as source of truth.
- [x] `README.md` reviewed.
- [ ] Runbook по локальному запуску reviewed. Текущий статус: отсутствует, должен быть создан в фазе `8`.
- [ ] Runbook по деплою reviewed. Текущий статус: отсутствует, должен быть создан в фазе `8`.
- [ ] API docs для Deepgram, Groq, ElevenLabs, Qdrant и провайдера эмбеддингов reviewed.
- [ ] Ограничения платформы деплоя reviewed: WebSocket support, idle timeout, concurrent connections, HTTPS/microphone constraints.
- [ ] Браузерные ограничения reviewed: формат аудио, доступ к микрофону, autoplay policy, latency tradeoffs транспорта.

## Skills By Phase

- `process-checklist-handoff`: фазы `0-8`; ведение progress state, handoff и execution log.
- `openai-docs`: фазы `1`, `2`, `4`; использовать только если в реализации сохраняется `text-embedding-3-small` или иной OpenAI-based embeddings path.
- `browsermcp-browser-control`: фазы `5`, `6`; использовать для browser smoke и проверки UI/console/network при наличии активного Browser MCP.

Примечание: для Render/Heroku-like деплоя, Deepgram/Groq/ElevenLabs/Qdrant и общей Node/Python-реализации в текущем сеансе нет отдельного более узкого skill; эти шаги выполняются как обычная инженерная работа.

## Decision Points (go/no-go)

- [x] D1 Owner: user. Backend stack fixed to `Node.js + TypeScript`.
- [x] D2 Owner: user. Audio transport fixed to `raw PCM / small chunks over WebSocket`.
- [x] D3 Owner: user. Embeddings provider fixed to `OpenAI text-embedding-3-small`.
- [x] D4 Owner: user. Deploy target fixed to one Docker service on `Render`.
- [x] D5 Owner: user. MVP ingestion fixed to `markdown inserted in UI`.
- [x] D6 Owner: user. Observability fixed to `structured logs + latency timestamps + export in markdown/JSON`.
- [x] D7 Owner: user. Rollback fixed to `redeploy previous image`.
- [x] D8 Owner: user. Budget handling fixed to `limit actual test volume to fit monthly budget`.

## Current Status
- Stage: in_progress
- Owner: agent
- Updated (UTC): 2026-03-24 14:12 UTC
- Last completed step: 4.9
- Current step: 5.1
- Next step: 5.2

## Handoff
- Done: user decisions D1-D8 resolved; baseline ADRs added; repo scaffolded; `.env.example`, `README.md`, Dockerfile, backend Express/ws skeleton, frontend Vite UI scaffold, healthcheck/build verification completed; browser mic waveform + PCM uplink + WS session/knowledge flow verified locally; OpenAI embeddings, Groq and Deepgram control-plane smoke checks passed; ElevenLabs configured voice validated on free plan; latency baselines collected; streaming STT comparison between Deepgram and ElevenLabs Scribe completed; vector-store baseline switched to `Qdrant local` only; live app code now wires raw PCM into Deepgram, final transcripts into OpenAI embeddings + Qdrant retrieval, Groq streaming completion and ElevenLabs audio playback back to browser; text-turn smoke passed against `docs/content/rag-source.md`.
- Not done: acceptance dataset freeze, browser E2E acceptance scenarios, interruption behavior, deploy smoke, runbooks.
- Blockers: acceptance dataset for RAG validation is not fixed yet; ElevenLabs `models_read` permission is still absent, so model catalog smoke stays partial; Browser MCP in текущей Codex-сессии отдаёт `Transport closed`, поэтому автоматизированный browser E2E сейчас внешне заблокирован.
- Next command (one): `npm run dev`
- Expected result: local frontend starts on `5173`, backend on `3300`, UI can open mic, index markdown into Qdrant local and receive audio reply from the live provider pipeline.

## Checklist

### 0) Baseline

- [x] 0.0 Verify required context docs are listed and reviewed, or explicitly marked missing with blockers.
- [x] 0.1 Confirm [docs/specs/tech-spec-voice-agent-rag.md](/mnt/c/Dialog-agent/docs/specs/tech-spec-voice-agent-rag.md) is the active source of truth for MVP scope.
- [x] 0.2 Inventory repo state and confirm greenfield baseline: no existing app code, no hidden runtime/deploy assumptions.
- [x] 0.3 Resolve D1-D8 or explicitly defer each with written owner-approved choice.
- [x] 0.4 Freeze runtime versions: Node/Python version, package manager, Docker base image, browser support baseline.
- [ ] 0.5 Freeze acceptance dataset strategy: which sample docs and which test questions prove RAG quality.
Acceptance criteria:
- Все обязательные документы перечислены.
- Неведомые параметры не скрыты и вынесены в decision points.
- Утверждён минимальный технический baseline для старта работ.
Output artifact:
- `docs/adr/0001-mvp-baseline.md` или эквивалентная baseline note.

### 1) Preparation

- [x] 1.1 Decide repo layout: `frontend/`, `backend/`, `shared/`, `scripts/`, `docs/`.
- [x] 1.2 Decide language/tooling stack and initialize project scaffolding.
- [x] 1.3 Create `.env.example` with all required and optional vars from the spec, without secrets.
- [x] 1.4 Create initial `README.md` with local run prerequisites and service overview.
- [x] 1.5 Create architecture note for session lifecycle, provider boundaries, and latency budget split by stage.
- [x] 1.6 Create a minimal config layer for environment validation and fail-fast startup checks.
Acceptance criteria:
- Репозиторий имеет согласованную структуру.
- Все обязательные env vars описаны.
- Стартовые документы позволяют следующему агенту не угадывать каркас проекта.
Output artifact:
- `README.md`
- `.env.example`
- `docs/adr/0002-runtime-and-architecture.md`

### 2) Local Validation Spikes

- [x] 2.1 Build isolated connectivity smoke for Deepgram streaming.
- [x] 2.2 Build isolated connectivity smoke for Groq streaming completions.
- [x] 2.3 Build isolated connectivity smoke for ElevenLabs streaming TTS.
- [x] 2.4 Build isolated connectivity smoke for chosen embeddings provider and vector DB baseline decision.
- [x] 2.5 Measure rough latency per provider call path under local network conditions.
- [x] 2.6 Record provider-specific constraints: formats, rate limits, timeouts, retry behavior.
Acceptance criteria:
- Каждый внешний провайдер подтверждён отдельным smoke-тестом.
- Есть первичная оценка latency budget по этапам.
- Все неподтверждённые API assumptions либо сняты, либо оформлены как blockers.
Output artifact:
- `docs/validation/provider-smoke-results.md`
- `docs/validation/provider-latency-results.md`
- `docs/validation/provider-streaming-latency-results.md`
- `docs/validation/stt-streaming-comparison.md`
- `scripts/` smoke helpers for each provider.

### 3) Pre-Change Verification

- [ ] 3.1 Confirm chosen audio transport matches target latency and browser compatibility.
- [ ] 3.2 Confirm selected hosting platform supports long-lived WebSocket connections and HTTPS microphone access.
- [ ] 3.3 Confirm budget model with selected providers fits target monthly spend or document accepted variance.
- [ ] 3.4 Confirm ingestion scope and security model for uploaded documents.
- [ ] 3.5 Confirm observability scope for MVP and how metrics will be computed.
- [ ] 3.6 Define test matrix: RU/EN, short/long utterances, found/not-found RAG scenarios, interruption behavior.
Acceptance criteria:
- Перед реализацией нет скрытых критичных рисков по транспорту, хостингу и бюджету.
- У команды есть тестовая матрица и критерии stop/go.
Output artifact:
- `docs/validation/preflight-checklist.md`

### 4) Change Execution

- [x] 4.1 Scaffold backend service with startup health checks, config validation and session id generation.
- [x] 4.2 Implement client connection lifecycle: connect, heartbeat, disconnect, cleanup.
- [x] 4.3 Implement browser audio capture path and wire it to backend transport.
- [x] 4.4 Implement streaming ASR integration with transcript event model for interim/final text.
- [x] 4.5 Implement VAD or end-of-utterance gating logic and utterance state machine.
- [x] 4.6 Implement ingestion pipeline: file load, text extraction, chunking, embeddings, Qdrant upsert.
- [x] 4.7 Implement retrieval pipeline: query embedding, top-3 lookup, metadata handling, no-context fallback.
- [x] 4.8 Implement LLM orchestration: prompt builder, citations/context injection, streaming token handling.
- [x] 4.9 Implement streaming TTS path and browser playback handling.
- [x] 4.10 Implement transcript UI, waveform/levels, connection status, provider status and error surfaces.
- [ ] 4.11 Implement structured logs and latency timestamps for ASR, retrieval, LLM and TTS stages.
- [ ] 4.12 Implement failure handling: reconnect, timeout, rate-limit retry, safe user-visible fallback messages.
- [ ] 4.13 Add automated checks feasible for MVP: lint, unit tests for prompt/config/session utilities, smoke entrypoint.
Acceptance criteria:
- Есть сквозной локальный диалоговый путь microphone -> ASR -> RAG -> LLM -> TTS -> browser.
- Ошибки и пустой контекст обрабатываются явно.
- Код запускается без ручной правки после установки env vars.
Output artifact:
- Рабочий код в `frontend/`, `backend/`, `shared/`, `scripts/`.
- Базовые test/lint scripts.

### 5) Local End-to-End Validation

- [ ] 5.1 Run local app over HTTPS-capable setup or tunnel suitable for microphone access.
- [ ] 5.2 Validate RU scenario with found RAG answer and citation.
- [ ] 5.3 Validate EN scenario with found RAG answer.
- [ ] 5.4 Validate not-found scenario with explicit uncertainty response.
- [ ] 5.5 Validate interruption behavior if user starts speaking during TTS.
- [ ] 5.6 Capture latency measurements for at least `10` minutes of test dialogs.
- [ ] 5.7 Compute or estimate WER and MOS/proxy for baseline quality.
- [ ] 5.8 Fix p0/p1 defects discovered in local E2E before deploy.
Acceptance criteria:
- Локально подтверждены основные acceptance-сценарии из ТЗ.
- Собран baseline по latency и качеству.
- Нет нерешённых p0-блокеров перед деплоем.
Output artifact:
- `docs/validation/local-e2e-results.md`
- Sample logs / metric dumps for baseline.

### 6) Deploy And Post-Deploy Smoke

- [ ] 6.1 Prepare production-like Docker image and verify container startup locally.
- [ ] 6.2 Deploy to selected platform with env-only configuration.
- [ ] 6.3 Verify HTTPS, WebSocket handshake, session lifecycle and microphone permission flow.
- [ ] 6.4 Run post-deploy smoke on at least one RU and one EN dialog.
- [ ] 6.5 Re-measure latency on hosted environment and compare to local baseline.
- [ ] 6.6 Run limited concurrency check toward `10` active sessions or document deferred load validation.
- [ ] 6.7 Record deployment-specific issues: cold starts, timeouts, provider region mismatch, connection drops.
Acceptance criteria:
- Приложение доступно по HTTPS.
- Основной голосовой сценарий работает на целевой платформе.
- Известны реальные latency и stability показатели после деплоя.
Output artifact:
- `docs/validation/post-deploy-smoke.md`
- Deployment URL and environment checklist.

### 7) Rollback / Fallback

- [ ] 7.1 Define immediate rollback action for failed deploy.
- [ ] 7.2 Define degraded mode if one provider is unavailable: text-only reply, alternate TTS, temporary disable streaming.
- [ ] 7.3 Verify that failed deployment can be backed out without editing secrets or data manually.
- [ ] 7.4 Record rollback trigger conditions and who decides go/no-go.
Acceptance criteria:
- Есть понятный путь возврата из неуспешного релиза.
- Отказ отдельного провайдера не превращается в неконтролируемый сбой.
Output artifact:
- `docs/runbooks/rollback-voice-agent-rag.md`

### 8) Closure / Documentation

- [ ] 8.1 Update `README.md` with final run and deploy steps.
- [ ] 8.2 Write runbook for local development, ingestion flow and smoke tests.
- [ ] 8.3 Write runbook for deployment, monitoring and rollback.
- [ ] 8.4 Record open tech debt and deferred improvements separately from MVP acceptance.
- [ ] 8.5 Update this plan: check completed boxes, refresh `Current Status`, `Handoff`, `Execution Log`.
Acceptance criteria:
- Следующий агент может продолжить сопровождение без устных пояснений.
- Все отклонения от ТЗ зафиксированы письменно.
- План и фактическое состояние синхронизированы.
Output artifact:
- `docs/runbooks/local-development.md`
- `docs/runbooks/deploy-and-smoke.md`
- updated plan file.

## Clarifications Resolved

- [x] D1: `Node.js + TypeScript`
- [x] D2: `raw PCM / small chunks over WebSocket`
- [x] D3: `OpenAI text-embedding-3-small`
- [x] D4: one Docker service on `Render`
- [x] D5: markdown inserted in UI
- [x] D6: structured logs + latency timestamps + export in markdown/JSON
- [x] D7: rollback via `redeploy previous image`
- [x] D8: cap actual test volume to stay within budget

## Execution Log

- 2026-03-22 17:34 UTC plan created from current TZ/task context; only the spec file was present in repo; missing repo docs were recorded as blockers and decision points were extracted.
- 2026-03-24 11:25 UTC user approved D1-D8; plan moved from blocked to in_progress; clarified MVP ingestion as markdown inserted in UI.
- 2026-03-24 11:25 UTC baseline docs, README, env example, Dockerfile, backend Express/ws scaffold and frontend Vite scaffold were added; build and backend healthcheck were verified.
- 2026-03-24 11:32 UTC browser mic waveform and binary PCM uplink were wired to backend; WebSocket session.start and knowledge.set flow was smoke-verified locally.
- 2026-03-24 11:55 UTC provider smoke script added and executed; OpenAI embeddings, Groq and Deepgram control-plane checks passed; ElevenLabs initially failed with missing `models_read` permission and app-specific voice config was incomplete.
- 2026-03-24 12:37 UTC ElevenLabs free-plan premade voice was validated; provider latency, streaming latency and STT streaming comparison were completed; Deepgram fixed as primary STT and ElevenLabs Scribe as fallback/A-B option.
- 2026-03-24 12:37 UTC vector-store baseline switched from Pinecone to `Qdrant local` only to reduce dev/demo retrieval latency and remove managed vector DB dependency.
- 2026-03-24 14:10 UTC backend runtime moved from scaffold to live pipeline: browser PCM now streams into Deepgram; speech-final utterances trigger OpenAI embeddings, Qdrant lookup, Groq streamed response and ElevenLabs audio playback back to the browser.
- 2026-03-24 14:10 UTC local text-turn smoke succeeded end-to-end against `docs/content/rag-source.md`; smoke scripts were started migrating from Pinecone references to `Qdrant local`.
- 2026-03-24 14:12 UTC automated browser E2E attempt was blocked outside the app code: Browser MCP server could be started locally, but the built-in Browser MCP transport in this Codex session still returned `Transport closed`.
