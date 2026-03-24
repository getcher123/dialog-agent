# Provider Latency Results

Generated: 2026-03-24T14:07:25.762Z

Run id: 154cb466-e34a-4310-b8fb-3af657568c32

| Service | Status | Latency ms | Detail |
|---|---|---:|---|
| OpenAI embeddings | passed | 579 | embedding length 1536 |
| Qdrant upsert | passed | 15 | collection voice-agent-rag |
| Qdrant query | passed | 6 | top match 154cb466-e34a-4310-b8fb-3af657568c32 |
| Groq completion | passed | 179 | llama-3.3-70b-versatile: The Groq latency smoke test is now operational. |
| ElevenLabs TTS | passed | 480 | configured voice CwhRBWXzGAHq8TQ4Fs17, 75276 bytes |
| Deepgram STT | passed | 1624 | empty transcript (source: audio_2026-03-24_15-15-24.ogg) |

Notes:
- These are single-call indicative latencies from the current environment, not p95/p99 production metrics.
- ElevenLabs voice source used for synthesis: configured (CwhRBWXzGAHq8TQ4Fs17).
- Deepgram sample source used: /mnt/c/Users/Ivan/Downloads/audio_2026-03-24_15-15-24.ogg.
- Secrets are intentionally not included in this report.
