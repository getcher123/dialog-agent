#!/usr/bin/env python3
"""Создает читаемое MD-представление. Редактировать нужно только cards.jsonl."""
from __future__ import annotations
import argparse
from collections import Counter
import hashlib
from pathlib import Path
from validate_kb import read_cards, validate

STATUS={'source_only':'По источнику; актуальность не подтверждена','conflict':'Неоднозначность / расхождение','missing':'Недостаточно данных / тема не подключена','preliminary':'Предварительное значение','planned':'План / концепция'}

def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cards',type=Path,default=Path('kb/cards.jsonl'))
    parser.add_argument('--output',type=Path,default=Path('kb/preview.md'))
    args=parser.parse_args()
    cards=read_cards(args.cards)
    errors=validate(cards)
    if errors:
        raise SystemExit('\n'.join(errors))
    sha=hashlib.sha256(args.cards.read_bytes()).hexdigest()
    out=['# База знаний «Бетанкур» — результат B1', '',
         '> Производное представление `cards.jsonl`. Не редактировать вручную: изменения вносятся в JSONL, затем этот файл создается заново.', '',
         'Источник: `КП_Ремесленная.doc`. Подтвержденная дата актуальности сведений неизвестна. Это консультант по тексту, не реестр текущих цен, наличия или состояния объекта.', '',
         f'Карточек: **{len(cards)}**. SHA-256 исходного JSONL: `{sha}`.', '',
         'Оригинал и этот набор не разрешены к автоматической публичной публикации. Предназначено для работы владельца и уполномоченных агентов.', '',
         '| Область | Карточек |', '|---|---:|']
    for scope,count in sorted(Counter(c['metadata']['scope'] for c in cards).items()):
        out.append(f'| `{scope}` | {count} |')
    out.extend(['','Для каждой карточки ниже указаны точные разделы и текстовые ориентиры оригинала. Это не результаты живого retrieval и не оценка ответов модели.',''])
    for n,c in enumerate(cards,1):
        m=c['metadata']
        out.extend([f'## {n:02d}. {m["section"]}', '',c['content'],'',
                    f'**ID:** `{m["chunk_id"]}`. **Статус:** {STATUS[m["source_status"]]}.','',
                    '**Исходные места:** '+'; '.join(m['source_refs'])+'.',''])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text('\n'.join(out),encoding='utf-8')
    print(f'Создано: {args.output}; карточек: {len(cards)}.')

if __name__=='__main__':
    main()
