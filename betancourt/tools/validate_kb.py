#!/usr/bin/env python3
"""Проверка контракта B1 v2 без API и сторонних библиотек.

Проверяет структуру/дубли/служебные пути и наличие ориентиров источника.
НЕ измеряет качество retrieval/LLM и НЕ доказывает смысловую верность всех фраз.
Длины указываются в символах и UTF-8 байтах, не выдаются за токены.
"""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import unicodedata

SCOPES = {'residential', 'commercial', 'parking', 'common', 'comparison'}
STATUSES = {'source_only', 'preliminary', 'planned', 'conflict', 'missing'}
FIELDS = {'chunk_id', 'section', 'scope', 'source_status', 'source_refs'}
SERVICE_PATH = re.compile(r'(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\]+[\\/]|/mnt/data/|/home/|/opt/|sandbox:)')
SECRET = re.compile(r'\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})\b')


def normalize(text: str) -> str:
    """Только форматирование для поиска ориентира; исходник не исправляется."""
    text = unicodedata.normalize('NFKC', text).casefold()
    text = text.translate(str.maketrans({'—':'-', '–':'-', 'ё':'е', '«':'"', '»':'"'}))
    return re.sub(r'\s+', ' ', text).strip()


def read_cards(path: Path) -> list[dict]:
    cards: list[dict] = []
    for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            raise ValueError(f'Строка {number}: пустая строка JSONL.')
        try:
            card = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f'Строка {number}: некорректный JSON: {error.msg}') from error
        if not isinstance(card, dict):
            raise ValueError(f'Строка {number}: нужен объект JSON.')
        cards.append(card)
    if not cards:
        raise ValueError('Набор карточек пуст.')
    return cards


def validate(cards: list[dict], source_text: str | None = None) -> list[str]:
    errors: list[str] = []
    ids: set[str] = set()
    contents: set[str] = set()
    source = normalize(source_text) if source_text is not None else None
    for n, c in enumerate(cards, 1):
        context = f'Строка {n}'
        if set(c) != {'content', 'metadata'}:
            errors.append(f'{context}: нужны только content и metadata.')
        content = c.get('content')
        m = c.get('metadata')
        if not isinstance(content, str) or not content.strip():
            errors.append(f'{context}: пустой/некорректный content.')
            continue
        if not isinstance(m, dict) or set(m) != FIELDS:
            errors.append(f'{context}: metadata должна содержать ровно пять полей v2.')
            continue
        id = m['chunk_id']
        if not isinstance(id, str) or not re.fullmatch(r'[a-z][a-z0-9_]{2,79}', id):
            errors.append(f'{context}: некорректный chunk_id.')
        else:
            context = id
            if id in ids:
                errors.append(f'{context}: повтор chunk_id.')
            ids.add(id)
        if normalize(content) in contents:
            errors.append(f'{context}: точный дубль content.')
        contents.add(normalize(content))
        if not isinstance(m['scope'], str) or m['scope'] not in SCOPES:
            errors.append(f'{context}: неизвестный scope.')
        if not isinstance(m['source_status'], str) or m['source_status'] not in STATUSES:
            errors.append(f'{context}: неизвестный source_status.')
        if not isinstance(m['section'], str) or not m['section'].strip():
            errors.append(f'{context}: пустой section.')
        refs = m['source_refs']
        if not isinstance(refs, list) or not refs or any(not isinstance(r, str) or not r.strip() for r in refs):
            errors.append(f'{context}: source_refs должен быть непустым списком текстовых ориентиров.')
        elif len(set(refs)) != len(refs):
            errors.append(f'{context}: повтор source_refs.')
        elif source is not None:
            for ref in refs:
                for part in ref.split(' → '):
                    if normalize(part) not in source:
                        errors.append(f'{context}: в извлечении не найден ориентир {part!r}.')
        if not content.startswith('Дом «Бетанкур». '):
            errors.append(f'{context}: в начале content нет объекта.')
        serialized = json.dumps(c, ensure_ascii=False)
        if SERVICE_PATH.search(serialized):
            errors.append(f'{context}: найден служебный путь.')
        if SECRET.search(serialized):
            errors.append(f'{context}: найдено значение, похожее на секрет.')
    return errors


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('cards', type=Path, nargs='?', default=Path('kb/cards.jsonl'))
    p.add_argument('--source', type=Path, default=None,
                   help='Необязательное извлечение: проверка существования текстовых ориентиров.')
    args = p.parse_args()
    try:
        cards = read_cards(args.cards)
        source = args.source.read_text(encoding='utf-8') if args.source else None
        errors = validate(cards, source)
        if errors:
            print(json.dumps({'result':'FAIL', 'cards':len(cards), 'errors':errors}, ensure_ascii=False, indent=2))
            raise SystemExit(1)
        content_lengths = [len(c['content']) for c in cards if isinstance(c.get('content'), str)]
        result = {'result': 'PASS' if not errors else 'FAIL',
                  'cards': len(cards),
                  'sha256': hashlib.sha256(args.cards.read_bytes()).hexdigest(),
                  'scope_counts': dict(sorted(Counter(c.get('metadata', {}).get('scope') for c in cards).items())),
                  'status_counts': dict(sorted(Counter(c.get('metadata', {}).get('source_status') for c in cards).items())),
                  'max_content_characters': max(content_lengths, default=0),
                  'max_content_utf8_bytes': max((len(c['content'].encode('utf-8')) for c in cards if isinstance(c.get('content'),str)),default=0),
                  'token_count': 'not_measured; check with actual model tokenizer in B2',
                  'source_locator_check': 'PASS' if source is not None and not errors else ('FAIL' if source is not None else 'not_requested'),
                  'retrieval_and_llm_tests': 'NOT_RUN_B1_ONLY', 'errors':errors}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(1 if errors else 0)
    except (ValueError, OSError) as error:
        raise SystemExit(f'Ошибка: {error}') from error

if __name__ == '__main__':
    main()
