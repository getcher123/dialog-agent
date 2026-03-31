import { env } from "../config/env.js";

interface GroqStreamOptions {
  systemPrompt: string;
  userPrompt: string;
  onDelta: (delta: string) => void;
}

export async function streamGroqCompletion(
  options: GroqStreamOptions
): Promise<{ text: string; firstByteMs?: number; endpointHost: string }> {
  if (!env.GROQ_API) {
    throw new Error("GROQ_API is not configured");
  }

  const baseUrl = env.GROQ_BASE_URL.replace(/\/$/, "");
  const endpointHost = new URL(baseUrl).host;
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      stream: true,
      temperature: 0.1,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content: options.systemPrompt
        },
        {
          role: "user",
          content: options.userPrompt
        }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`Groq completion failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let fullText = "";
  let firstByteMs: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split("\n\n");
    buffered = parts.pop() ?? "";

    for (const part of parts) {
      for (const line of part.split("\n")) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            if (firstByteMs === undefined) {
              firstByteMs = Date.now() - startedAt;
            }
            fullText += delta;
            options.onDelta(delta);
          }
        } catch {
          // Ignore partial SSE fragments.
        }
      }
    }
  }

  return {
    text: fullText.trim(),
    firstByteMs,
    endpointHost
  };
}
