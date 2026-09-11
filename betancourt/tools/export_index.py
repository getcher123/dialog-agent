#!/usr/bin/env python3
"""Export one verified local Qdrant collection for a private one-time import."""
import argparse
import hashlib
import json
import os
from pathlib import Path

from qdrant_client import QdrantClient

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    state = json.loads((ROOT / "kb/index-state.json").read_text(encoding="utf-8"))
    cards_path = ROOT / "kb/cards.jsonl"
    source_sha = hashlib.sha256(cards_path.read_bytes()).hexdigest()
    if state != {**state, "sha256": source_sha} or state.get("points") != 87 or state.get("dimensions") != 1536 or state.get("distance") != "Cosine":
        raise ValueError("Index state does not match the verified cards")
    cards = [json.loads(line) for line in cards_path.read_text(encoding="utf-8").splitlines() if line]
    expected_payloads = {card["metadata"]["chunk_id"]: card for card in cards}
    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.getenv("QDRANT_API_KEY") or None, timeout=30)
    points = []
    offset = None
    while True:
        batch, offset = client.scroll(state["collection"], limit=100, offset=offset, with_payload=True, with_vectors=True)
        points.extend(batch)
        if offset is None:
            break
    if len(points) != 87 or {point.payload["metadata"]["chunk_id"]: point.payload for point in points} != expected_payloads:
        raise ValueError("Local Qdrant payloads do not match cards.jsonl")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {"format": "betancourt-qdrant-export-v1", "source_sha256": source_sha, "collection": state["collection"],
                "model": state["model"], "dimensions": state["dimensions"], "distance": state["distance"], "points": 87}
    with output.open("x", encoding="utf-8", newline="\n") as target:
        target.write(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n")
        for point in sorted(points, key=lambda item: str(item.id)):
            target.write(json.dumps({"id": str(point.id), "payload": point.payload, "vector": point.vector}, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False) + "\n")
    output.chmod(0o600)
    print(json.dumps({"path": str(output), "archive_sha256": hashlib.sha256(output.read_bytes()).hexdigest(), **manifest}))


if __name__ == "__main__":
    main()
