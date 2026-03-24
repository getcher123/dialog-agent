import { env } from "../config/env.js";

export async function embedText(input: string): Promise<number[]> {
  const [embedding] = await embedTexts([input]);
  return embedding;
}

export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: inputs
    }),
    signal: AbortSignal.timeout(30000)
  });

  const rawText = await response.text();

  let body: unknown = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    body = null;
  }

  if (!response.ok) {
    const parsedError = extractResponseMessage(body);
    throw new Error(parsedError || `OpenAI embeddings failed: ${response.status} ${rawText.slice(0, 500)}`);
  }

  const vectors =
    body &&
    typeof body === "object" &&
    "data" in body &&
    Array.isArray(body.data)
      ? body.data
          .map((item) =>
            item && typeof item === "object" && "embedding" in item && Array.isArray(item.embedding)
              ? item.embedding
              : null
          )
          .filter((embedding): embedding is number[] => Array.isArray(embedding))
      : [];

  if (vectors.length === 0) {
    throw new Error("OpenAI embeddings response does not contain vectors");
  }

  return vectors;
}

function extractResponseMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  if ("error" in body && body.error && typeof body.error === "object" && "message" in body.error) {
    return typeof body.error.message === "string" ? body.error.message : null;
  }

  if ("message" in body) {
    return typeof body.message === "string" ? body.message : null;
  }

  return null;
}
