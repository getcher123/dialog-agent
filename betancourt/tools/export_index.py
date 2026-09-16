#!/usr/bin/env python3
"""Export one verified local Qdrant collection for a private one-time import."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from qdrant_client import QdrantClient

ROOT = Path(__file__).resolve().parents[1]
FORMAT = "betancourt-qdrant-export-v2"
MODEL = "text-embedding-3-small"
DIMENSIONS = 1536


def default_cards_path() -> Path:
    return ROOT / "kb/cards.jsonl"


def load_state(path: Path, cards_sha256: str, cards_count: int) -> dict:
    state = json.loads(path.read_text(encoding="utf-8"))
    state_sha256 = state.get("cards_sha256", state.get("sha256"))
    if (state_sha256 != cards_sha256 or state.get("points") != cards_count or state.get("model") != MODEL or
            state.get("dimensions") != DIMENSIONS or state.get("distance") != "Cosine" or
            not isinstance(state.get("collection"), str)):
        raise ValueError("Index state does not match the verified cards")
    return state


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cards", type=Path, default=default_cards_path())
    parser.add_argument("--state", type=Path, default=None)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    cards_path = args.cards.resolve()
    cards = [json.loads(line) for line in cards_path.read_text(encoding="utf-8").splitlines() if line]
    if not cards:
        raise ValueError("Cards file is empty")
    cards_sha256 = hashlib.sha256(cards_path.read_bytes()).hexdigest()
    state_path = (args.state or cards_path.with_name("index-state.json")).resolve()
    state = load_state(state_path, cards_sha256, len(cards))
    expected_payloads = {card["metadata"]["chunk_id"]: card for card in cards}
    if len(expected_payloads) != len(cards):
        raise ValueError("Duplicate chunk_id in cards")

    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.getenv("QDRANT_API_KEY") or None, timeout=30)
    points = []
    offset = None
    while True:
        batch, offset = client.scroll(state["collection"], limit=100, offset=offset, with_payload=True, with_vectors=True)
        points.extend(batch)
        if offset is None:
            break
    actual_payloads = {point.payload["metadata"]["chunk_id"]: point.payload for point in points}
    if len(points) != len(cards) or actual_payloads != expected_payloads:
        raise ValueError("Local Qdrant payloads do not match cards.jsonl")

    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "format": FORMAT,
        "cards_sha256": cards_sha256,
        "collection": state["collection"],
        "model": state["model"],
        "dimensions": state["dimensions"],
        "distance": state["distance"],
        "points": len(cards),
    }
    with output.open("x", encoding="utf-8", newline="\n") as target:
        target.write(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
        for point in sorted(points, key=lambda item: str(item.id)):
            target.write(json.dumps({"id": str(point.id), "payload": point.payload, "vector": point.vector}, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False) + "\n")
    output.chmod(0o600)
    print(json.dumps({"path": str(output), "archive_sha256": hashlib.sha256(output.read_bytes()).hexdigest(), **manifest}))


if __name__ == "__main__":
    main()
