PYTHON ?= python3

.PHONY: check index up smoke
check:
	node --test tests/gateway.test.mjs
	$(PYTHON) tools/validate_kb.py --source kb/source/extracted.txt
	$(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v

index:
	node tools/run-index.mjs

up:
	docker compose up -d --build

smoke:
	node tools/smoke.mjs
