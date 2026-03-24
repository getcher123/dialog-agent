# STT Streaming Comparison

Generated: 2026-03-24T12:31:02.953Z

Input source: /mnt/c/Users/Ivan/Downloads/audio_2026-03-24_15-15-24.ogg

| Service | Status | First event ms | Completed ms | Transcript |
|---|---|---:|---:|---|
| Deepgram streaming | passed | 2148 | 5513 | Можешь еще тут deploy, вот эти переводы правильно перевести, пожалуйста? |
| ElevenLabs Scribe Realtime v2 | passed | 2611 | 4950 | Можешь еще, дедиплоя, вот эти переводы правильно перевести, пожалуйста? |

Notes:
- Both services received the same PCM 16kHz mono stream generated from the provided audio file.
- Audio was paced in 100ms chunks to approximate live streaming instead of batch upload.
- These are single-run indicative timings from the current environment.
