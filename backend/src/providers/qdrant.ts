import { randomUUID } from "node:crypto";

import { env } from "../config/env.js";

export interface KnowledgeChunk {
  id: string;
  text: string;
  source: string;
  ordinal: number;
}

export interface SearchMatch {
  id: string;
  score: number;
  text: string;
  source: string;
  ordinal: number;
}

export async function ensureCollection(): Promise<void> {
  const existing = await fetch(collectionUrl(), {
    method: "GET",
    signal: AbortSignal.timeout(10000)
  });

  if (existing.ok) {
    return;
  }

  if (existing.status !== 404) {
    const body = await existing.text();
    throw new Error(`Qdrant ensureCollection failed: ${existing.status} ${body.slice(0, 500)}`);
  }

  const response = await fetch(collectionUrl(), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      vectors: {
        size: 1536,
        distance: "Cosine"
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Qdrant ensureCollection failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

export async function upsertKnowledge(
  documentName: string,
  chunks: Array<KnowledgeChunk & { embedding: number[] }>
): Promise<void> {
  await ensureCollection();

  const response = await fetch(
    `${collectionUrl()}/points?wait=true`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        points: chunks.map((chunk) => ({
          id: chunk.id,
          vector: chunk.embedding,
          payload: {
            text: chunk.text,
            source: chunk.source,
            ordinal: chunk.ordinal,
            document_name: documentName
          }
        }))
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Qdrant upsert failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

export async function searchKnowledge(vector: number[], limit = 3): Promise<SearchMatch[]> {
  await ensureCollection();

  const response = await fetch(`${collectionUrl()}/points/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: vector,
      limit,
      with_payload: true
    }),
    signal: AbortSignal.timeout(15000)
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Qdrant search failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  }

  const result =
    body && typeof body === "object" && "result" in body && body.result && typeof body.result === "object" && "points" in body.result && Array.isArray(body.result.points)
      ? body.result.points
      : [];

  return result.map((entry: Record<string, unknown>) => ({
    id: String(entry.id ?? "unknown"),
    score: Number(entry.score ?? 0),
    text: String((entry.payload as Record<string, unknown> | undefined)?.text ?? ""),
    source: String((entry.payload as Record<string, unknown> | undefined)?.source ?? "knowledge"),
    ordinal: Number((entry.payload as Record<string, unknown> | undefined)?.ordinal ?? 0)
  }));
}

export async function deleteKnowledgeBySource(source: string): Promise<void> {
  const response = await fetch(`${collectionUrl()}/points/delete?wait=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filter: {
        must: [
          {
            key: "source",
            match: {
              value: source
            }
          }
        ]
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Qdrant delete failed: ${response.status} ${body.slice(0, 500)}`);
  }
}

export function chunkMarkdown(markdown: string, source = "ui-markdown"): KnowledgeChunk[] {
  const normalized = markdown.replace(/\r/g, "").trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks: KnowledgeChunk[] = [];
  let current = "";
  let ordinal = 0;

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length > 900 && current) {
      chunks.push({
        id: randomUUID(),
        text: current,
        source,
        ordinal
      });
      ordinal += 1;
      current = paragraph;
      continue;
    }

    current = candidate;
  }

  if (current) {
    chunks.push({
      id: randomUUID(),
      text: current,
      source,
      ordinal
    });
  }

  return chunks;
}

function collectionUrl(): string {
  return `${env.QDRANT_URL.replace(/\/$/, "")}/collections/${encodeURIComponent(env.QDRANT_COLLECTION)}`;
}
