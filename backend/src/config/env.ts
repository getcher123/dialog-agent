import path from "node:path";

import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv({
  path: path.resolve(process.cwd(), ".env"),
  quiet: true
});
loadEnv({
  path: path.resolve(process.cwd(), "../.env"),
  quiet: true,
  override: false
});

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3300),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  FRONTEND_DIST_PATH: z.string().default("../frontend/dist"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEEPGRAM_API: z.string().optional(),
  GROQ_API: z.string().optional(),
  GROQ_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
  ELEVENLABS_API: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().url().default("https://api.elevenlabs.io"),
  OPENAI_API_KEY: z.string().optional(),
  QDRANT_URL: z.string().default("http://localhost:6333"),
  QDRANT_COLLECTION: z.string().default("voice-agent-rag"),
  QDRANT_STORAGE_PATH: z.string().default("./.qdrant"),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default("eleven_turbo_v2_5"),
  ELEVENLABS_MULTILINGUAL_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  RENDER_EXTERNAL_URL: z.string().optional()
});

export const env = envSchema.parse(process.env);
