# Provider Streaming Latency Results

Generated: 2026-03-24T12:16:56.960Z

Deepgram media source: /mnt/c/Users/Ivan/Downloads/audio_2026-03-24_15-15-24.ogg

| Service | Status | First byte / first event ms | Completed ms | Detail |
|---|---|---:|---:|---|
| OpenAI embeddings | n/a | - | - | No streaming mode for embeddings endpoint |
| Pinecone vector DB | n/a | - | - | No streaming mode for upsert/query endpoints |
| Groq streamed completion | passed | 899 | 944 | The Groq streaming latency test has been confirmed to be as expected. |
| ElevenLabs streamed TTS | passed | 693 | 873 | 71098 audio bytes streamed |
| Deepgram streamed STT | passed | 1143 | 1143 | empty transcript |

Notes:
- OpenAI embeddings and Pinecone are non-stream APIs, so they are marked as n/a.
- Groq is measured as streamed SSE/chat completion.
- ElevenLabs is measured via HTTP chunked audio stream.
- Deepgram is measured via WebSocket streaming STT using the provided media file.
- These are single-run indicative timings from the current environment.
