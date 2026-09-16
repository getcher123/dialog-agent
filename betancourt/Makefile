PYTHON ?= python3
CARDS ?= kb/cards.jsonl
STATE ?= $(dir $(CARDS))index-state.json
INDEX_EXPORT ?= reports/betancourt-index.jsonl
SMOKE_ARGS ?=

.PHONY: check index export-index up smoke
check:
	node --test tests/backend.test.mjs
	node --test tests/rag.test.mjs
	node --test tests/import-index.test.mjs
	node --test tests/backup-qdrant.test.mjs
	$(PYTHON) tools/validate_kb.py --source kb/source/extracted.txt
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

index:
	node tools/run-index.mjs --cards "$(CARDS)" --state "$(STATE)"

export-index:
	.venv/bin/python tools/export_index.py --cards "$(CARDS)" --state "$(STATE)" --output "$(INDEX_EXPORT)"

up:
	docker compose up -d --build

smoke:
	node tools/smoke.mjs $(SMOKE_ARGS)
