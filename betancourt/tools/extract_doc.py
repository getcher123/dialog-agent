#!/usr/bin/env python3
"""Локальное извлечение DOC/DOCX: абзацы и таблицы, включая вложенные.

Не формирует смысловую KB автоматически. cards.jsonl редактируется отдельно.
Промежуточный DOCX удаляется; оригинал не изменяется. Внешних API нет.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def paragraph_text(element: ET.Element) -> str:
    parts: list[str] = []
    for node in element.iter():
        if node.tag == W + 't':
            parts.append(node.text or '')
        elif node.tag == W + 'tab':
            parts.append('\t')
        elif node.tag in (W + 'br', W + 'cr'):
            parts.append('\n')
    return ''.join(parts)


def extract_docx(path: Path) -> tuple[str, dict]:
    with ZipFile(path) as z:
        body = ET.fromstring(z.read('word/document.xml')).find(W + 'body')
    if body is None:
        raise ValueError('В DOCX не найдено тело документа.')
    output: list[str] = []
    top_tables = 0

    def table(t: ET.Element, label: str) -> None:
        output.append(f'\n[ТАБЛИЦА {label}]')
        for row_number, row in enumerate(t.findall(W + 'tr'), 1):
            output.append(f'[СТРОКА {row_number}]')
            for cell_number, cell in enumerate(row.findall(W + 'tc'), 1):
                props = cell.find(W + 'tcPr')
                details: list[str] = []
                if props is not None:
                    for key in ('gridSpan', 'vMerge'):
                        prop = props.find(W + key)
                        if prop is not None:
                            details.append(f'{key}={prop.get(W + "val", "continue")}')
                output.append(f'[ЯЧЕЙКА {cell_number}' + ('; ' + ', '.join(details) if details else '') + ']')
                nested = 0
                for block in cell:
                    if block.tag == W + 'p':
                        output.append(paragraph_text(block))
                    elif block.tag == W + 'tbl':
                        nested += 1
                        table(block, f'{label}.{row_number}.{cell_number}.{nested}')
        output.append(f'[КОНЕЦ ТАБЛИЦЫ {label}]\n')

    for block in body:
        if block.tag == W + 'p':
            output.append(paragraph_text(block))
        elif block.tag == W + 'tbl':
            top_tables += 1
            table(block, str(top_tables))
    all_tables = len(list(body.iter(W + 'tbl')))
    stats = {'top_level_tables': top_tables, 'nested_tables': all_tables-top_tables,
             'all_tables': all_tables, 'paragraphs_including_table_cells': len(list(body.iter(W+'p')))}
    return '\n'.join(output).strip() + '\n', stats


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path, nargs='?', default=Path('kb/source/КП_Ремесленная.doc'))
    parser.add_argument('--output', type=Path, default=Path('kb/source/extracted.txt'))
    args = parser.parse_args()
    source = args.source.resolve()
    if not source.is_file():
        parser.error(f'Исходный файл не найден: {source}')
    if source.suffix.lower() not in ('.doc', '.docx'):
        parser.error('Поддерживается исходный .doc или .docx.')
    with tempfile.TemporaryDirectory(prefix='betancourt_extract_') as temp:
        tempdir = Path(temp)
        target = source
        if source.suffix.lower() == '.doc':
            executable = shutil.which('libreoffice') or shutil.which('soffice')
            if not executable:
                parser.error('Для DOC требуется локальный LibreOffice/soffice. Готовая KB от него не зависит.')
            target = tempdir / (source.stem + '.docx')
            command = [executable, '-env:UserInstallation='+(tempdir/'profile').as_uri(),
                       '--headless', '--convert-to', 'docx', '--outdir', str(tempdir), str(source)]
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=120)
            if not target.is_file():
                raise RuntimeError('LibreOffice не создал ожидаемый DOCX.')
        text, stats = extract_docx(target)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text, encoding='utf-8')
        stats.update({'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                      'source_bytes': source.stat().st_size,
                      'extracted_sha256': hashlib.sha256(text.encode('utf-8')).hexdigest(),
                      'output': str(args.output)})
        print(json.dumps(stats, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f'Ошибка извлечения: {error}') from error
