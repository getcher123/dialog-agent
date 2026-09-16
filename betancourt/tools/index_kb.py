#!/usr/bin/env python3
"""Index a complete, already-split KB without touching unrelated collections."""
from __future__ import annotations

import argparse
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
TOKEN_LIMIT = 800
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "dialog-agent/betancourt/cards")


def default_cards_path() -> Path:
    return ROOT / "kb/cards.jsonl"


def collection_name(cards_sha256: str) -> str:
    config_hash = hashlib.sha256(f"{MODEL}:{DIMENSIONS}:Cosine".encode()).hexdigest()[:8]
    return f"betancourt_{cards_sha256[:16]}_{config_hash}"


def index_cards(cards_path: Path, state_path: Path) -> dict:
    cards_path = cards_path.resolve()
    state_path = state_path.resolve()
    cards = read_cards(cards_path)
    errors = validate(cards)
    if errors:
        raise ValueError("KB validation failed: " + "; ".join(errors))

    tokenizer = tiktoken.encoding_for_model(MODEL)
    sizes = [len(tokenizer.encode(card["content"], disallowed_special=())) for card in cards]
    if max(sizes) > TOKEN_LIMIT:
        raise ValueError(f"A card exceeds the {TOKEN_LIMIT}-token limit; review its content before indexing")

    cards_sha256 = hashlib.sha256(cards_path.read_bytes()).hexdigest()
    collection = collection_name(cards_sha256)
    points = {str(uuid.uuid5(NAMESPACE, card["metadata"]["chunk_id"])): card for card in cards}
    if len(points) != len(cards):
        raise ValueError("Deterministic point ID collision")

    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.getenv("QDRANT_API_KEY") or None, timeout=30)
    exists = client.collection_exists(collection)
    existing: dict[str, dict] = {}
    if exists:
        info = client.get_collection(collection)
        vector_config = info.config.params.vectors
        if (not isinstance(vector_config, models.VectorParams) or vector_config.size != DIMENSIONS or
                vector_config.distance != models.Distance.COSINE):
            raise ValueError("Existing collection has incompatible vector configuration; refusing to modify it")
        offset = None
        while True:
            records, offset = client.scroll(collection, limit=100, offset=offset, with_payload=True, with_vectors=False)
            existing.update({str(record.id): record.payload for record in records})
            if offset is None:
                break
        if set(existing) - set(points) or any(existing[key] != points[key] for key in existing):
            raise ValueError("Existing collection has unexpected points or payloads; refusing to overwrite it")

    skipped = existing == points
    if not skipped:
        if exists:
            print(json.dumps({"event": "retry_partial_index", "cards_to_embed": len(cards)}))
        api = OpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=0, timeout=60)
        response = api.embeddings.create(model=MODEL, dimensions=DIMENSIONS, input=[card["content"] for card in cards])
        vectors = sorted(response.data, key=lambda entry: entry.index)
        if len(vectors) != len(cards) or any(len(vector.embedding) != DIMENSIONS for vector in vectors):
            raise ValueError("Embedding response is incomplete")
        if not exists:
            client.create_collection(collection, vectors_config=models.VectorParams(size=DIMENSIONS, distance=models.Distance.COSINE))
        client.upsert(collection, points=[models.PointStruct(id=point_id, vector=vector.embedding, payload=card)
                                          for (point_id, card), vector in zip(points.items(), vectors)], wait=True)

    records = client.retrieve(collection, ids=list(points), with_payload=True, with_vectors=False)
    if {str(record.id): record.payload for record in records} != points or client.count(collection, exact=True).count != len(cards):
        raise ValueError("Post-index verification failed")

    state = {
        "cards_sha256": cards_sha256,
        "model": MODEL,
        "dimensions": DIMENSIONS,
        "distance": "Cosine",
        "collection": collection,
        "points": len(cards),
        "max_card_tokens": max(sizes),
        "skipped": skipped,
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(state))
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=default_cards_path())
    parser.add_argument("--state", type=Path, default=None)
    args = parser.parse_args()
    cards_path = args.cards.resolve()
    state_path = (args.state or cards_path.with_name("index-state.json")).resolve()
    index_cards(cards_path, state_path)


if __name__ == "__main__":
    main()
