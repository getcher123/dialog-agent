# Техническое задание: адаптация NVIDIA PersonaPlex-7B-v1 под русский язык с подготовкой контура для Uzbek

Created: 2026-03-22
Status: draft

## 1. Назначение документа

Цель документа: зафиксировать исполнимое техническое задание на адаптацию `NVIDIA PersonaPlex-7B-v1` под русский язык для real-time voice assistant, с отдельным decision gate на расширение до `Uzbek`.

Документ основан на первичных источниках по `PersonaPlex`, `Moshi`, `moshi-finetune` и публичной документации/репозиториях NVIDIA и Kyutai по состоянию на `2026-03-22`.

## 2. Вывод по исходной постановке

### 2.1 Что требуется по сути

Нужно не просто "дообучить LLM на русском", а адаптировать полный `speech-to-speech` full-duplex стек:

- вход пользователя подаётся в модель как поток аудиотокенов;
- ответ модели генерируется сразу как аудиотокены и как текстовые токены собственной речи;
- persona задаётся двумя разными механизмами:
  - текстовым role prompt;
  - audio-based voice prompt.

Следовательно, целевой результат должен включать не только `LoRA adapter`, но и:

- подготовку `Moshi/PersonaPlex`-совместимого датасета;
- доработку train/eval пайплайна под `PersonaPlex`-специфичное prompt conditioning;
- валидацию real-time inference и прерываний;
- инструкции по интеграции адаптера в сервер инференса.

### 2.2 Противоречия и пробелы в исходной заявке

В исходной постановке есть несколько несогласованных пунктов, которые должны быть явно отражены в ТЗ:

- Заголовок задачи говорит о `Russian`, но в main tasks фигурируют `Russian and Uzbek`.
- Deliverables содержат только `LoRA adapters for RU`, без `UZ`.
- В составе данных указаны `Russian conversation dataset` и `Persona dialogue dataset`, но не указано наличие `Uzbek speech dataset`.
- Для `speech-to-speech` обучения недостаточно просто "диалоговых текстов"; нужен корректный аудиодиалоговый корпус в формате, совместимом с `Moshi`.

### 2.3 Рекомендованная интерпретация объёма

Рекомендуемый scope:

- Phase 1, обязательный: `Russian adaptation` end-to-end.
- Phase 2, условный: `Uzbek adaptation`, только если после data audit будет подтверждён полноценный `Uzbek` аудиокорпус нужного формата и объёма.

Причина: публично доступные `Moshi` и `PersonaPlex` заявлены как английские модели; `Uzbek` в исходной постановке не обеспечен данными и не фигурирует в deliverables.

## 3. Исследование модели и архитектуры

### 3.1 Что такое PersonaPlex

`NVIDIA PersonaPlex-7B-v1` — это real-time full-duplex `speech-to-speech` conversational model, построенная на архитектуре `Moshi` и её весах, с добавлением:

- текстового role conditioning;
- audio voice conditioning;
- поведенческого контроля для persona-consistent ответов.

Согласно публичным материалам NVIDIA:

- модель ориентирована на низколатентный spoken dialogue;
- инференс использует `voice prompt` и `text prompt` до старта диалога;
- модель выпущена как inference-first артефакт, а не как полный training stack.

### 3.2 Что важно из Moshi для обучения

Из публичной документации и кода `Moshi`:

- модель работает с двумя потоками аудио:
  - речь ассистента;
  - речь пользователя;
- одновременно модель предсказывает текстовые токены собственной речи;
- аудио кодируется codec-моделью `Mimi`;
- temporal backbone рассчитан на real-time full-duplex interaction;
- базовый `Moshi` официально англоязычный.

Критический вывод: перенос на русский язык затрагивает одновременно:

- понимание входной русской речи;
- генерацию русской речи;
- генерацию русских текстовых токенов собственной речи;
- устойчивость поведения при barge-in и pause handling.

### 3.3 Что важно из PersonaPlex-специфики

Согласно paper и публичному репозиторию `NVIDIA/personaplex`:

- persona формируется гибридным prompt-механизмом;
- перед началом диалога в LM подаются:
  - аудио voice prompt для голоса ассистента;
  - текстовый system prompt/role prompt;
- в inference-коде `voice prompt` и `text prompt` прогоняются отдельной фазой `step_system_prompts`;
- репозиторий содержит сервер и offline evaluation, но не содержит готового train pipeline для полного воспроизведения обучения PersonaPlex.

Практический вывод: стандартного `moshi-finetune` недостаточно для полного "один в один" воспроизведения `PersonaPlex training recipe`; потребуется либо:

- ограничиться адаптацией базового `Moshi`/`PersonaPlex` через LoRA с минимальными модификациями;
- либо расширить train loop под hybrid prompt training и masking prompt segment loss.

### 3.4 Ограничение по языкам Helium backbone

В README `PersonaPlex` сказано, что модель "benefits from the generalization capabilities of the underlying Helium LLM". Публичная документация по `Helium 1 preview` описывает multilingual capability, но в явном списке поддерживаемых языков `Russian` и `Uzbek` не заявлены.

Инженерный вывод из источников:

- нельзя предполагать, что `Helium backbone` уже хорошо покрывает `RU` или `UZ`;
- русская и узбекская адаптация должны рассматриваться как полноценный domain/language transfer, а не как лёгкий prompt-only перенос;
- качество токенизации и языкового покрытия должно быть проверено до начала основного обучения.

## 4. Цели проекта

### 4.1 Бизнес-цель

Получить low-latency голосового ассистента на базе `PersonaPlex-7B-v1`, который:

- понимает русскую речь пользователя;
- отвечает на русском;
- сохраняет persona conditioning;
- поддерживает interruptible real-time диалог;
- интегрируется в voice assistant platform через Docker и documented inference flow.

### 4.2 Техническая цель

Подготовить reproducible training/evaluation pipeline, который выдаёт:

- `RU LoRA adapter` для `PersonaPlex-7B-v1`;
- train/eval/inference scripts;
- набор измеримых метрик качества;
- documented integration path;
- архитектурную готовность к `UZ` как отдельной фазе.

### 4.3 Цели качества

Итоговое решение должно:

- существенно превосходить базовый English-only `PersonaPlex` на русском тестовом наборе;
- не ломать full-duplex поведение и обработку прерываний;
- не ухудшать latency более чем на согласованный порог относительно английского baseline на том же железе;
- сохранять voice conditioning и role adherence.

## 5. Область охвата

### 5.1 Включено

- аудит исходных датасетов;
- проверка готовности датасетов к `Moshi`-совместимому обучению;
- подготовка train/val/test split;
- LoRA fine-tuning под `RU`;
- экспериментальный multilingual design для `RU/UZ`;
- доработка train pipeline, если потребуется для `PersonaPlex` hybrid prompt flow;
- офлайн и онлайн evaluation;
- оптимизация inference под real-time usage;
- Docker-first инструкция по интеграции.

### 5.2 Не включено

- полноценный re-pretraining модели "с нуля";
- выпуск новой base model с новым tokenizer без отдельного go/no-go;
- production SRE/HA/multi-region контур;
- юридическая очистка исходных датаисточников вне явно согласованного пайплайна;
- обязательная поставка `UZ adapter` без подтверждённого `UZ` корпуса.

## 6. Исходные зависимости и ограничения

### 6.1 Базовые артефакты

- Базовая модель: `nvidia/personaplex-7b-v1`.
- Inference code baseline: `NVIDIA/personaplex`.
- Fine-tuning baseline: `kyutai-labs/moshi-finetune`.
- Runtime framework: `PyTorch`.
- Целевая упаковка: `Docker`.

### 6.2 Лицензирование и доступ

- Доступ к весам `PersonaPlex` gated через Hugging Face license acceptance.
- Передача только LoRA adapters допускается отдельно от базовых весов, но должна быть проверена на соответствие лицензии NVIDIA Open Model License.
- Все датасеты и voice prompts должны иметь подтверждённые права на обучение и последующее внутреннее использование.

### 6.3 Инфраструктурные ограничения

- Основной расчётный контур обучения: `A100 80GB` или `H100 80GB`.
- Для pilot/ablation допускается 1 GPU, но основной reproducible training должен быть рассчитан минимум на multi-GPU path.
- Результат должен быть воспроизводим в Docker-окружении.
- В качестве ориентиров по ресурсам нужно учитывать:
  - официальный `PersonaPlex` fine-tuning в paper выполнялся `6 часов` на `8xA100` при `24,576` шагах, `batch size 32` и `max sequence length 2048` токенов;
  - `moshi-finetune` для LoRA-конфига уровня `duration_sec=100`, `batch_size=16`, `rank=128` приводит ориентировочно к `39.6GB` peak memory на `1xH100` и `23.7GB` на GPU при `8xH100`.

## 7. Ключевые технические выводы для ТЗ

### 7.1 Недостаточно текстового диалогового корпуса

Для обучения `Moshi`/`PersonaPlex` необходим не просто набор реплик, а `speech-to-speech` корпус. Публичный `moshi-finetune` ожидает:

- stereo audio files;
- разметку длительности и путей в `jsonl`;
- пер-диалоговый `.json` с word-level alignments.

Следовательно:

- если текущие датасеты текстовые или mono-audio, их нельзя напрямую использовать для основного fine-tuning;
- потребуется этап конвертации, синтеза, ресемплинга, диаризации или полный пересмотр scope.

### 7.2 Нужно валидировать channel semantics

`moshi-finetune` рассчитан на двухканальный формат, где один канал соответствует ассистенту, а другой пользователю. Для корректного обучения датасет обязан иметь стабильное назначение каналов на всём корпусе.

### 7.3 Нужно валидировать text tokenizer coverage

`Moshi` использует `SentencePiece` tokenizer. Для `RU/UZ` нужно до обучения измерить:

- фрагментацию токенов на русских и узбекских текстах;
- среднее число символов на токен;
- частоту деградирующего разбиения имён, чисел, доменных терминов и смешанной речи.

Если качество токенизации неудовлетворительно, простой `LoRA` может оказаться недостаточным. Тогда требуется escalation path:

- `LoRA + ft_embed`;
- отдельный adapter per language;
- в крайнем случае отдельный tokenizer migration как Phase 3+.

### 7.4 UZ нельзя обещать без data gate

`Uzbek` должен быть вынесен в отдельный decision gate. До подтверждения:

- наличия аудиоданных;
- объёма;
- качества транскриптов;
- выбранного скрипта нормализации (`Latin` как рекомендуемый основной, если бизнес не требует иного);

`UZ` не может быть обязательным deliverable Phase 1.

## 8. Требования к данным

### 8.1 Минимально допустимый состав входных данных для обучения RU

Для каждого обучающего диалога должны существовать:

- stereo WAV/FLAC файл;
- корректная длительность;
- знание того, какой канал является speech ассистента;
- word-level или как минимум reliable segment-level transcript для канала ассистента;
- метаданные языка;
- метаданные persona/role;
- ссылка на voice prompt или voice id, если в эксперименте используется controlled voice conditioning.

### 8.2 Требования к формату корпуса

Обязательный формат датасета после подготовки:

- `manifest_train.jsonl`
- `manifest_val.jsonl`
- `manifest_test.jsonl`
- `audio/*.wav`
- `audio/*.json` с alignments для соответствующего `.wav`

Минимальный вид строки `jsonl`:

```json
{"path": "audio/dialog_000001.wav", "duration": 24.52}
```

Минимальный вид alignment файла:

```json
{
  "alignments": [
    ["Здравствуйте", [0.12, 0.38], "SPEAKER_MAIN"],
    ["чем", [0.39, 0.47], "SPEAKER_MAIN"],
    ["могу", [0.48, 0.61], "SPEAKER_MAIN"],
    ["помочь", [0.62, 0.88], "SPEAKER_MAIN"]
  ]
}
```

Примечание: пример выше отражает формат, совместимый с `moshi-finetune`. Если для `PersonaPlex` потребуется дополнительная persona metadata, она должна храниться в отдельном manifest и пробрасываться в custom dataloader/train loop.

### 8.3 Требования к качеству данных

До старта обучения нужно обеспечить:

- не менее `95%` успешно декодируемых аудиофайлов;
- не более `2%` файлов с ошибками channel mapping;
- не более `3%` файлов с грубыми alignment дефектами;
- отсутствие длительных обрезаний начала/конца фраз;
- отсутствие систематического leakage английских synthetic prompts в русские ответы, если такие артефакты есть в датасете.

### 8.4 Разбиение выборок

Train/val/test должны быть разделены так, чтобы не было утечки:

- по диалогам;
- по голосам ассистента;
- по персонам;
- по доменам;
- по спикерам пользователя, если они повторяются.

Рекомендуемое split:

- `train`: `90%`
- `val`: `5%`
- `test`: `5%`

При наличии малого числа уникальных personas/voices допускается стратифицированный split с ручной квотой.

### 8.5 Требования к объёму

Исходное указание `300k–500k samples` недостаточно информативно и должно быть преобразовано минимум в:

- число диалогов;
- число часов аудио;
- число уникальных personas;
- число уникальных голосов ассистента;
- число доменов;
- число русских и узбекских примеров отдельно.

Без этой нормализации нельзя корректно оценить feasibility, batch sizing и expected convergence.

## 9. Требования к data preparation pipeline

Должен быть реализован отдельный pipeline подготовки корпуса со следующими шагами:

1. Инвентаризация исходных источников.
2. Нормализация форматов аудио.
3. Проверка sample rate и channel count.
4. Приведение аудио к каноническому формату для обучения.
5. Валидация channel mapping.
6. Очистка шума, длинных тишин и битых файлов.
7. Подготовка/исправление word timestamps.
8. Нормализация текста.
9. Языковая разметка `ru`/`uz`/`mixed`.
10. Нормализация persona metadata.
11. Выделение voice prompt fragments.
12. Построение финальных manifests и splits.

### 9.1 Нормализация текста

Для русского:

- унификация пунктуации;
- нормализация чисел и валютных форматов;
- единый стиль имён, аббревиатур и латиницы в русской фразе;
- удаление служебных synthetic tokens, если они присутствуют.

Для Uzbek, если Phase 2 будет активирована:

- зафиксировать один канонический письменный стандарт для обучения;
- хранить mapping к альтернативному письму только как дополнительную постобработку;
- не смешивать разные стандарты без явной разметки.

### 9.2 Voice prompt extraction

Для controllable voice inference нужен curated набор voice prompts:

- чистая речь ассистента без перебиваний;
- рекомендуемая длина `6-12 секунд`;
- отсутствие сильного фонового шума;
- отдельный registry `voice_id -> prompt_path`.

Дополнительно должен быть предусмотрен этап предрасчёта `voice prompt embeddings` в `.pt`, так как официальный `PersonaPlex` уже поддерживает их загрузку и это уменьшает runtime overhead.

### 9.3 Persona metadata

Для каждой обучающей сессии должен быть доступен persona пакет:

- `persona_id`
- `role_prompt`
- `domain`
- `style_tags`
- `voice_id`
- `language`

Если в текущем датасете есть только текстовые persona-диалоги без аудио, они не считаются достаточными для основного `speech-to-speech` fine-tuning. Их допустимо использовать:

- для prompt library;
- для auxiliary text conditioning;
- для human eval scenarios;
- для synthetic augmentation, если это отдельно утверждено.

## 10. Требования к обучению

### 10.1 Основная стратегия

Рекомендуемая стратегия обучения:

- Baseline A: `RU-only LoRA adapter`.
- Baseline B: `RU-only LoRA + embedding fine-tuning`.
- Optional C: `RU+UZ multilingual LoRA`.
- Fallback D: separate adapters `RU` и `UZ`.

Рекомендуемое решение по умолчанию:

- сначала довести `RU-only adapter` до целевого качества;
- только затем сравнивать `single multilingual adapter` против `separate adapters`.

Причина: совместный адаптер без достаточного `UZ` корпуса с высокой вероятностью ухудшит русский baseline и размоет persona control.

### 10.2 Требования к training codebase

В реализации должны использоваться:

- `NVIDIA/personaplex` как baseline для инференса;
- `kyutai-labs/moshi-finetune` как baseline для LoRA fine-tuning;
- отдельный internal training wrapper/patch set для связки этих двух контуров.

Ожидаемые доработки training code:

- поддержка persona metadata в даталоадере;
- поддержка language tags и sampling weights;
- поддержка сохранения LoRA adapters в reproducible формате;
- логирование train/eval метрик;
- экспорт конфигурации эксперимента;
- при необходимости:
  - hybrid prompt injection during training;
  - masking loss на prompt-области;
  - кэширование precomputed voice prompt embeddings для eval.

### 10.3 Конфигурация LoRA

Стартовые конфигурации должны быть не жёстко фиксированы, а оформлены как experiment matrix.

Минимальный обязательный набор экспериментов:

1. `LoRA rank 64`, `ft_embed=false`
2. `LoRA rank 128`, `ft_embed=false`
3. `LoRA rank 128`, `ft_embed=true`

Допустимые стартовые опорные параметры, основанные на `moshi-finetune`:

- `full_finetuning=false`
- `lora.enable=true`
- `rank=128` как основной pilot
- `duration_sec=60-100`
- `gradient_checkpointing=true`
- `lr` порядка `2e-6`

Точные параметры батча и длительности сегмента должны быть уточнены после memory profiling на целевом железе.

### 10.4 Multi-stage curriculum

Рекомендуется следующий порядок:

### Stage 0. Data readiness and tokenizer audit

- проверить реальный состав данных;
- измерить tokenizer fragmentation на `RU` и `UZ`;
- собрать English baseline metrics на будущих test сценариях.

### Stage 1. Russian speech-language adaptation

- обучить `RU-only LoRA`;
- добиться уверенного ответа на русском;
- зафиксировать влияние на latency и interruptions.

### Stage 2. Persona conditioning refinement

- добавить/усилить persona-aware training;
- проверить role adherence;
- проверить стабильность voice conditioning.

### Stage 3. Uzbek gate

Переходить сюда только если:

- `UZ` датасет подтверждён;
- tokenizer audit не показывает критической деградации;
- Phase 1 завершена и зафиксирована.

### Stage 4. Multilingual comparison

- сравнить `joint RU+UZ adapter` с `separate adapters`;
- выбрать production path по качеству, latency и операционной простоте.

### 10.5 Ресурсная оценка и planning baseline

Для планирования экспериментов должны использоваться два опорных baseline:

- `Official PersonaPlex baseline`:
  - `24,576` steps;
  - `batch size 32`;
  - `2048` token steps;
  - около `163.84 секунд` максимальной длины последовательности;
  - `8xA100`, время обучения около `6 часов`.
- `Open-source LoRA baseline from moshi-finetune`:
  - `duration_sec=100`;
  - `batch_size=16`;
  - `max_steps=2000`;
  - `lora.rank=128`;
  - `lr=2e-6`;
  - ориентир памяти: `39.6GB` на `1xH100` или `23.7GB/GPU` на `8xH100`.

Практическое требование:

- pilot на `RU` должен стартовать с `open-source LoRA baseline`;
- переход к более длинным сессиям и более тяжёлым батчам допускается только после memory profiling;
- если available hardware слабее `A100 80GB/H100 80GB`, в отчёте должны быть явно зафиксированы снижения `batch_size`, `duration_sec` и ожидаемые trade-offs по качеству и стабильности диалога.

## 11. Требования к evaluation

### 11.1 Общий принцип

Финальная приёмка не может опираться только на train loss. Нужен отдельный evaluation contour:

- automatic metrics;
- scripted offline eval;
- human listening eval;
- real-time smoke in live server mode.

### 11.2 Обязательные группы метрик

### A. Language fidelity

Нужно измерять:

- долю ответов ассистента на целевом языке;
- долю code-switching не по сценарию;
- ошибки в числах, датах, именах, валюте и domain terms.

### B. Persona adherence

Нужно измерять:

- насколько ответ соответствует role prompt;
- сохраняется ли persona на длинной сессии;
- нет ли "срыва" в generic assistant behavior.

### C. Voice consistency

Нужно измерять:

- perceptual similarity к voice prompt;
- стабильность голоса между репликами;
- отсутствие voice drift на длинных сессиях.

### D. Audio quality

Нужно измерять:

- naturalness;
- разборчивость;
- артефакты декодирования;
- clipping, robotic speech, repetitions.

### E. Conversational dynamics

Нужно измерять:

- pause handling;
- backchannel behavior;
- interruption recovery;
- smooth turn taking;
- latency first response;
- latency interrupt stop.

### F. Regression to English baseline

Нужно проверить:

- не сломалась ли английская функциональность, если выбирается multilingual adapter;
- не ухудшились ли core full-duplex качества относительно исходного `PersonaPlex`.

### 11.3 Состав evaluation set

Должны быть подготовлены отдельные тестовые наборы:

- `RU scripted service dialogs`
- `RU casual conversation dialogs`
- `RU interruption / barge-in dialogs`
- `RU long-session stability dialogs`
- `RU persona-switch dialogs`
- `UZ scripted dialogs`, только если активирована Phase 2

Минимальный размер финального `RU test set`:

- не менее `300` диалогов для automatic eval;
- не менее `50` диалогов для human listening eval;
- не менее `20` stress/latency сценариев.

### 11.4 Acceptance thresholds

Обязательные критерии приёмки для `RU`:

- модель отвечает на русском не менее чем в `95%` русских сценариев, где это требуется;
- human preference над базовым English-only `PersonaPlex` на русском тесте не ниже `60/40`;
- role adherence по экспертной оценке не ниже `4.0/5`;
- naturalness по экспертной оценке не ниже `4.0/5`;
- latency regression относительно English baseline на том же железе не более:
  - `+25%` по median;
  - `+30%` по p95;
- interruption stop latency соответствует продуктовым требованиям платформы или, если они не зафиксированы, документируется как отдельная measured metric.

Если используется multilingual adapter, дополнительно:

- русский quality regression относительно `RU-only adapter` не более `5%` по ключевым метрикам;
- английский не деградирует критично на smoke наборе.

### 11.5 Чем измерять

Для автоматического proxy-eval допускается использовать внешние ASR/analysis модели, но финальная приёмка должна содержать human verification.

Обязательные артефакты:

- CSV/JSON с метриками;
- аудиосэмплы до/после обучения;
- side-by-side сравнение baseline vs adapted;
- eval notebook или script;
- финальный отчёт в `md`.

## 12. Требования к inference и интеграции

### 12.1 Inference runtime

Итоговый результат должен интегрироваться в серверный контур `PersonaPlex` и поддерживать:

- выбор LoRA adapter при старте или по конфигу;
- выбор `voice_prompt` или precomputed voice embedding;
- передачу `text_prompt`;
- low-latency streaming;
- корректную обработку барж-инов.

### 12.2 Оптимизации обязательного уровня

Должны быть предусмотрены:

- `bf16` inference на GPU;
- кэширование voice prompt embeddings;
- warm-up перед нагрузочным тестом;
- документированный способ запуска в Docker;
- профилирование использования памяти;
- baseline latency measurement до и после адаптации.

### 12.3 Оптимизации желательного уровня

- объединение adapter loading и server startup в один reproducible path;
- быстрый rollback на base model;
- поддержка отдельного `RU-only` и `multilingual` профилей;
- подготовка к последующему merge adapters, если это будет нужно платформе.

### 12.4 API и конфигурация

В итоговой интеграции должны быть зафиксированы:

- путь к базовой модели;
- путь к LoRA adapter;
- путь к voice prompt embeddings;
- default text prompt templates для `RU`;
- language selector;
- флаги CPU offload или альтернативные degraded режимы.

## 13. Требования к deliverables

Обязательные deliverables Phase 1:

- `RU LoRA adapter`
- training configs
- training scripts или patch set поверх baseline repos
- data preparation scripts
- evaluation scripts
- отчёт по экспериментам
- integration instructions
- Docker runbook

Дополнительные deliverables, если активирована Phase 2:

- `UZ adapter` или `multilingual adapter`
- сравнительный отчёт `RU-only vs multilingual vs separate adapters`

## 14. Требования к документации

Должны быть подготовлены следующие документы:

1. `Data audit report`
2. `Training experiment log`
3. `Evaluation report`
4. `Integration guide`
5. `Rollback guide`

Минимальное содержание integration guide:

- как скачать/подключить базовую модель;
- как применить LoRA adapter;
- как подключить voice prompts;
- как запустить локальный server;
- как прогнать offline eval;
- как откатиться на baseline.

## 15. План исполнения

### 15.1 Phase 0. Discovery and audit

- инвентаризация данных;
- верификация лицензий и доступов;
- проверка sample count, hours, voices, personas;
- tokenizer audit;
- baseline evaluation English-only model на русских сценариях.

Gate выхода:

- подтверждено, что `RU` данные пригодны для обучения;
- принято решение по `UZ`;
- принят canonical data format.

### 15.2 Phase 1. Data preparation

- конвертация корпуса в `Moshi`-совместимый формат;
- построение alignments;
- генерация manifests;
- подготовка voice prompt registry;
- формирование train/val/test.

Gate выхода:

- корпус проходит техническую валидацию;
- train job стартует без format/runtime errors.

### 15.3 Phase 2. Pilot training

- запуск `RU-only LoRA` pilot;
- профилирование памяти;
- подбор rank/lr/batch;
- первичная eval на val/test.

Gate выхода:

- найден стабильный training recipe;
- зафиксирован baseline adapter.

### 15.4 Phase 3. Persona refinement

- дообучение с persona-aware sampling;
- проверка role adherence;
- voice conditioning validation;
- regression checks на latency.

Gate выхода:

- persona quality и voice stability соответствуют acceptance threshold.

### 15.5 Phase 4. Uzbek decision / multilingual branch

- запуск только после утверждения data gate;
- сравнение multilingual vs separate adapters;
- фиксация production recommendation.

### 15.6 Phase 5. Integration and hardening

- подключение адаптера в server runtime;
- warm-up и caching;
- Docker packaging;
- live smoke и нагрузочная проверка.

## 16. Критические риски

### R1. Датасет не соответствует speech-to-speech формату

Риск:

- основной риск проекта;
- при его подтверждении прямой LoRA fine-tuning невозможен без тяжёлой переработки данных.

Митигирование:

- остановить проект после data audit, а не после нескольких неудачных train runs.

### R2. Плохое покрытие RU/UZ tokenizer'ом

Риск:

- слабая генерация текста, нестабильные имена/числа, плохая переносимость на Uzbek.

Митигирование:

- tokenizer audit;
- `ft_embed=true` как отдельный experiment branch;
- separate adapters;
- tokenizer migration только отдельной фазой.

### R3. PersonaPlex training recipe не воспроизводится готовыми open-source инструментами

Риск:

- стандартный `moshi-finetune` не покрывает весь PersonaPlex-specific prompt workflow.

Митигирование:

- заложить время на train loop patching;
- не обещать "без изменений кода" до pilot validation.

### R4. Real-time latency деградирует после LoRA

Риск:

- модель перестаёт соответствовать voice assistant требованиям.

Митигирование:

- измерять latency с первого дня;
- кэшировать voice prompts;
- держать English baseline и rollback path.

### R5. Uzbek scope размывает Phase 1

Риск:

- русская адаптация не доводится до production quality из-за преждевременного multilingual expansion.

Митигирование:

- жёсткий `RU-first` порядок работ.

## 17. Обязательные решения до старта работ

До старта implementation должны быть подтверждены:

1. Является ли `UZ` обязательным deliverable или отдельной фазой после `RU`.
2. Существуют ли реальные `UZ` аудиоданные, а не только тексты.
3. Какой формат имеют текущие датасеты:
   - stereo audio;
   - mono audio;
   - text-only dialogues.
4. Есть ли готовые word-level alignments.
5. Требуется ли сохранять английское качество в рамках одного multilingual adapter.
6. Нужен один adapter или допустимы separate adapters per language.
7. Какие продуктовые latency thresholds считаются обязательными.

Без закрытия этих вопросов ТЗ считается пригодным только для `Discovery / Audit phase`, но не для гарантии fixed-scope delivery.

## 18. Формальные критерии завершения проекта

Проект считается завершённым, если:

- подготовлен и зафиксирован воспроизводимый train pipeline;
- выпущен `RU LoRA adapter`;
- собран и задокументирован evaluation report;
- интеграция в `PersonaPlex` runtime подтверждена;
- rollback на baseline документирован;
- все open questions по `UZ` либо закрыты адаптером, либо официально вынесены в отдельную фазу.

## 19. Рекомендуемая структура артефактов в репозитории

```text
docs/
  specs/
    tech-spec-personaplex-ru-uz-finetune.md
  reports/
    personaplex-data-audit.md
    personaplex-eval-report.md
    personaplex-latency-report.md
training/
  configs/
  scripts/
  adapters/
data/
  manifests/
  prompts/
  voices/
eval/
  offline/
  live/
docker/
  Dockerfile
  docker-compose.yml
```

## 20. Sources

Первичные источники, использованные при подготовке ТЗ:

- NVIDIA PersonaPlex model card: <https://huggingface.co/nvidia/personaplex-7b-v1>
- NVIDIA PersonaPlex repository: <https://github.com/NVIDIA/personaplex>
- PersonaPlex paper: <https://arxiv.org/abs/2602.06053>
- PersonaPlex preprint PDF: <https://research.nvidia.com/labs/adlr/files/personaplex/personaplex_preprint.pdf>
- Moshi repository: <https://github.com/kyutai-labs/moshi>
- Moshi paper: <https://arxiv.org/abs/2410.00037>
- Moshi FAQ: <https://github.com/kyutai-labs/moshi/blob/main/FAQ.md>
- Moshi fine-tuning repository: <https://github.com/kyutai-labs/moshi-finetune>
- FullDuplexBench paper: <https://arxiv.org/abs/2503.04721>
- Helium 1 preview model page: <https://huggingface.co/kyutai/helium-1-preview-2b>

## 21. Итоговая рекомендация

Рекомендуемый go-forward plan:

- не обещать `RU+UZ` как единый фиксированный deliverable сразу;
- зафиксировать `RU-first` как обязательную фазу;
- вынести `UZ` в conditional phase после data audit;
- использовать `PersonaPlex inference repo + moshi-finetune + custom training patches`;
- заложить в scope отдельный этап валидации данных, иначе риск срыва проекта остаётся недопустимо высоким.
