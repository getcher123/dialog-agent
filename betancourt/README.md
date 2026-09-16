# Betankur RAG

Изолированный текстовый консультант по одному документу. Прод-схема:

`GitHub Pages /dialog-agent/betancourt/ -> betankur-rag -> private Qdrant + OpenAI`.

Один Node.js backend проверяет общий код приглашения, применяет ограничения, создаёт embedding вопроса, получает до восьми карточек из Qdrant и передаёт их в OpenAI для ответа. Если первичный поиск находит раздел, разбитый на несколько карточек, backend дочитывает все карточки этого раздела. В модель передаётся либо полный раздел, либо при превышении 32 источников возвращается просьба сузить вопрос: частичный список не выдаётся за полный. Flowise, серверная память диалога, кэш и автоматические повторы отсутствуют. Существующий голосовой агент остаётся отдельным приложением.

Приватный исходник, карточки, готовые векторы, предметные тесты и отчёты не входят в Git, Docker-образ или GitHub Pages.

## Контракт

- `GET|HEAD /betancourt/healthz` проверяет процесс без вызовов OpenAI/Qdrant.
- `POST /betancourt/api/chat` принимает только `{"message":"..."}` с непустым вопросом до 2000 символов.
- Код передаётся как `Authorization: Bearer <PILOT_TOKEN>` и хранится только в памяти открытой страницы.
- Ответ содержит только `answer` и `sources`; источник содержит `id`, `section`, `excerpt`.
- Разрешены только origin из `ALLOWED_ORIGINS`. Неверные коды, запросы по IP, общий поток и параллельность имеют отдельные ограничения.

Параметры RAG зафиксированы: `text-embedding-3-small`, 1536 измерений, Cosine, top-k 8; `gpt-4.1-mini-2025-04-14`, temperature 0, максимум 1000 выходных токенов. `RAG_MAX_COMPLETION_TOKENS` может быть повышен только до 4096 после подтверждённого обрыва ответа и повторной проверки затронутых вопросов. Промпт хранится в `backend/prompt.txt`; тест фиксирует SHA принятой версии. При пустом поиске генерация не вызывается.

## Локальный Запуск

Нужны Node 24, Docker Compose и Python 3.10+ с venv/pip. Рабочая директория команд: `betancourt/`.

1. Приватные `kb/`, `tests/questions.jsonl`, `tests/test_kb.py` и `DELIVERY.md` должны оставаться вне Git.
2. Заполнить `.env` по `.env.example`. `PILOT_TOKEN` генерируется из 32 случайных байтов и не равен ключам провайдеров.
3. Установить Python SDK: `python3 -m venv .venv`, затем `.venv/bin/pip install -r requirements.txt`.
4. Проверить и запустить:

```bash
make check
docker compose up -d --build --remove-orphans
make index
node tools/smoke.mjs --all
```

Локальные адреса: UI `http://127.0.0.1:3310/betancourt/`, health `http://127.0.0.1:3310/betancourt/healthz`, Qdrant `http://127.0.0.1:6333`. Остановка без удаления данных: `docker compose down`.

`make index` создаёт версионную коллекцию из `kb/cards.jsonl`: UUIDv5, проверка metadata и размерности, отсутствие удаления чужих коллекций. Полностью совпадающая версия пропускается без повторной оплаты embeddings. Для кандидата необходимо явно передать оба приватных пути, чтобы локальный `.env` не подменил выбранный набор:

```bash
make index CARDS=/private/candidate/cards.jsonl STATE=/private/candidate/index-state.json
make export-index CARDS=/private/candidate/cards.jsonl STATE=/private/candidate/index-state.json \
  INDEX_EXPORT=/private/betancourt-index.jsonl
```

`tools/smoke.mjs --questions /private/questions.jsonl --all --report-dir /private/reports` запускает вопросы последовательно с интервалом не менее 13 секунд. Отчёт содержит SHA вопросов, конфигурацию, ответ, источники и длительность; `RAG_TRACE=true` дополнительно пишет в локальный server log ID и score первичного поиска, не меняя публичный контракт.

## Перенос Индекса

Для Amvera используются уже проверенные локальные векторы, без повторного обращения к embeddings API:

```bash
make export-index
```

Команда создаёт приватный `reports/betancourt-index.jsonl` с manifest и динамическим числом точек выбранного набора. Экспорт проверяет SHA карточек, payload, коллекцию и наличие векторов. Файл имеет mode 600 и игнорируется Git.

Одноразовый импорт выполняется только при выключенном чате:

```bash
INDEX_FILE=/data/betancourt-index.jsonl \
INDEX_DATA_DIR=/data \
INDEX_CARDS_SHA256=<cards-sha256> \
INDEX_COLLECTION=<versioned-collection-name> \
INDEX_POINTS=<card-count> \
INDEX_ARCHIVE_SHA256=<archive-sha256> \
QDRANT_BACKUP_FILE=/data/<fresh-qdrant-backup>.json \
QDRANT_URL=http://<internal-qdrant-host>:6333 \
DELETE_INDEX_AFTER_IMPORT=true \
node backend/import-index.mjs
```

Импорт сначала проверяет свежий backup Qdrant из приватного `/data`, затем принимает только ожидаемый manifest v2, точные SHA карточек и архива, имя коллекции, динамическое число уникальных UUID/`chunk_id`, векторы 1536 и metadata. Совпадающая коллекция даёт `skipped:true`; частичная, конфликтующая или несовместимая коллекция не перезаписывается. После успешного импорта временный файл удаляется. Штатный запуск `backend/server.mjs` импорт не выполняет.

## Amvera Waw0

Используется существующий проект `betankur-rag`, одна реплика, без повышения тарифа. Пакет деплоя создаётся allowlist-командой:

```bash
node tools/package-amvera.mjs backend /tmp/betankur-rag-source
```

Обязательные runtime variables:

- `OPENAI_API_KEY` — secret;
- `QDRANT_URL` — проверенный внутренний URL зоны `waw0`: `http://run-qdrant:6333`;
- `QDRANT_COLLECTION` — имя из `kb/index-state.json`;
- `RAG_MAX_COMPLETION_TOKENS=1000` — только 1–4096, поднимать после доказанного обрыва;
- `PILOT_TOKEN` — secret;
- `CHAT_ENABLED=false` до завершения импорта и smoke;
- `ALLOWED_ORIGINS=https://getcher123.github.io,https://<actual-backend-domain>`;
- `TRUSTED_PROXY_CIDRS=10.244.0.0/16` — подтверждённая pod-сеть ingress proxy зоны `waw0`.

Сначала существующий `dialog-agent` переводится на внутренний URL Qdrant и проверяется реальным поиском. Затем внешний ingress Qdrant отключается и проверяется из интернета. Если внешний API нельзя закрыть, приватный индекс не переносится.

В `waw0` фактическое имя сервиса имеет формат `run-<slug>`, хотя общая документация Amvera всё ещё показывает старый формат `amvera-<project>-run-<user>`. Адрес `run-qdrant:6333` и ingress peer `10.244.9.13` проверены из контейнера проекта; для ротации ingress доверяется его pod-сеть `10.244.0.0/16`.

Внутренняя связь Amvera не шифруется платформой, поэтому она применяется только внутри приватного namespace. При невозможности закрыть ingress потребуется отдельное решение, а не публикация карточек в открытый Qdrant.

После загрузки индекса и проверки backend создаётся бесплатный HTTPS-домен, чат включается и выполняется production smoke. Аварийный выключатель: `CHAT_ENABLED=false` с перезапуском; `/healthz` остаётся доступным.

## GitHub Pages

Маршрут: `https://getcher123.github.io/dialog-agent/betancourt/`. Workflow собирает основной frontend из `main` и добавляет только четыре публичных файла консультанта. Repository variable `BETANCOURT_API_BASE` содержит HTTPS-адрес backend с `/betancourt`, без `/api/chat`.

Общий Pages workflow должен находиться в `main`, иначе последующий deploy основного frontend удалит маршрут Betancourt. Код консультанта остаётся в `feature/betancourt`. В артефакте проверяются отсутствие `.env`, KB, векторов, отчётов и служебных файлов.

## Ограничения

Счётчики лимитов находятся в памяти одной реплики и сбрасываются при рестарте; это не денежный hard cap. Прерывание браузерного запроса не гарантирует отмену уже начатого вызова провайдера. Интерфейс показывает найденные карточки, но они сами по себе не доказывают каждое предложение ответа. Сведения документа не считаются актуальными ценами, наличием, сроками, действующим правом или инвестиционной гарантией.
