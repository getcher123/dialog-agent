# Provider Smoke Results

Generated: 2026-03-24T14:07:06.179Z

| Provider | Status | Endpoint | Detail |
|---|---|---|---|
| OpenAI embeddings | passed | POST /v1/embeddings | embedding length 1536 |
| Groq API | passed | GET /openai/v1/models | models visible 18 |
| Deepgram API | passed | GET /v1/models | stt models 398 |
| ElevenLabs API | failed | - | 401: The API key you used is missing the permission models_read to execute this operation. |
| ElevenLabs voice id | passed | GET /v1/voices/:voice_id | voice 'Roger - Laid-Back, Casual, Resonant' resolved |
| Qdrant local | passed | GET /readyz | all shards are ready; collection voice-agent-rag |

Notes:
- Secrets are intentionally not printed in this report.
- This is a control-plane smoke check, not a full end-to-end voice pipeline validation.
