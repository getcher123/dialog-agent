PYTHON ?= python3

.PHONY: check index export-index up smoke
check:
	node --test tests/gateway.test.mjs
	node --test tests/rag.test.mjs
	node --test tests/import-index.test.mjs
	$(PYTHON) tools/validate_kb.py --source kb/source/extracted.txt
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

index:
	node tools/run-index.mjs

export-index:
	.venv/bin/python tools/export_index.py --output reports/betancourt-index.jsonl

up:
	docker compose up -d --build

smoke:
	node tools/smoke.mjs
