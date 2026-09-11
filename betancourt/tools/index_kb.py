#!/usr/bin/env python3
"""Index complete, validated cards without splitting or deleting collections."""
import hashlib
import json
import os
from pathlib import Path
import uuid

from openai import OpenAI
from qdrant_client import QdrantClient, models
import tiktoken

from validate_kb import read_cards, validate

ROOT = Path(__file__).resolve().parents[1]
MODEL = "text-embedding-3-small"
DIMENSIONS = 1536
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "dialog-agent/betancourt/cards")


def index_cards():
    path = ROOT / "kb/cards.jsonl"
    cards = read_cards(path)
    errors = validate(cards)
    if errors:
        raise ValueError("KB validation failed: " + "; ".join(errors))
    tokenizer = tiktoken.encoding_for_model(MODEL)
    sizes = [len(tokenizer.encode(c["content"])) for c in cards]
    if max(sizes) > 800:
        raise ValueError("A card exceeds the 800-token limit; review its content before indexing")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    config_hash = hashlib.sha256(f"{MODEL}:{DIMENSIONS}:Cosine".encode()).hexdigest()[:8]
    collection = f"betancourt_{digest[:16]}_{config_hash}"
    points = {str(uuid.uuid5(NAMESPACE, c["metadata"]["chunk_id"])): c for c in cards}
    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.getenv("QDRANT_API_KEY") or None, timeout=30)
    exists = client.collection_exists(collection)
    existing = {}
    if exists:
        info = client.get_collection(collection)
        vector_config = info.config.params.vectors
        if not isinstance(vector_config, models.VectorParams) or vector_config.size != DIMENSIONS or vector_config.distance != models.Distance.COSINE:
            raise ValueError("Existing collection has incompatible vector configuration; refusing to modify it")
        offset = None
        while True:
            records, offset = client.scroll(collection, limit=100, offset=offset, with_payload=True, with_vectors=False)
            existing.update({str(r.id): r.payload for r in records})
            if offset is None:
                break
        if set(existing) - set(points) or any(existing[k] != points[k] for k in existing):
            raise ValueError("Existing collection has unexpected points or payloads; refusing to overwrite it")

    skipped = existing == points
    if not skipped:
        # A partial upload may be retried, at the cost of embedding all cards again.
        if exists:
            print(json.dumps({"event": "retry_partial_index", "cards_to_embed": len(cards)}))
        api = OpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0, timeout=60)
        response = api.embeddings.create(model=MODEL, dimensions=DIMENSIONS, input=[c["content"] for c in cards])
        vectors = sorted(response.data, key=lambda entry: entry.index)
        if len(vectors) != len(cards) or any(len(v.embedding) != DIMENSIONS for v in vectors):
            raise ValueError("Embedding response is incomplete")
        if not exists:
            client.create_collection(collection, vectors_config=models.VectorParams(size=DIMENSIONS, distance=models.Distance.COSINE))
        client.upsert(collection, points=[models.PointStruct(id=pid, vector=vector.embedding, payload=card)
                                         for (pid, card), vector in zip(points.items(), vectors)], wait=True)
    records = client.retrieve(collection, ids=list(points), with_payload=True, with_vectors=False)
    if {str(r.id): r.payload for r in records} != points or client.count(collection, exact=True).count != len(cards):
        raise ValueError("Post-index verification failed")
    state = {"sha256": digest, "model": MODEL, "dimensions": DIMENSIONS, "distance": "Cosine",
             "collection": collection, "points": len(cards), "max_card_tokens": max(sizes), "skipped": skipped}
    (ROOT / "kb/index-state.json").write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(state))


if __name__ == "__main__":
    index_cards()
