"""Render a meeting's monthly score table as an .xlsx workbook.

Reads one JSON object on stdin:
    { "title": str, "period": str,
      "rows": [{ person, hours, completion, quality, learn, total, status, highlight, improve, basis[] }] }

Usage: python scores-xlsx.py <target.xlsx>
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

HEADERS = ['人员', '课时', '完成率%', '工作质量', '学习参与', '总分', '状态', '亮点', '待改进', '依据']
WIDTHS = [14, 8, 10, 10, 10, 8, 8, 30, 30, 56]


def main() -> int:
    # The host writes UTF-8 JSON into the pipe; Windows would otherwise decode stdin with
    # the locale code page and mangle every Chinese name.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass
    if len(sys.argv) < 2:
        print('usage: scores-xlsx.py <target.xlsx>', file=sys.stderr)
        return 2
    target = sys.argv[1]
    try:
        payload = json.loads(sys.stdin.buffer.read().decode('utf-8') or '{}')
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        print(f'invalid payload: {error}', file=sys.stderr)
        return 2
    rows = payload.get('rows') or []

    book = Workbook()
    sheet = book.active
    sheet.title = '月度评分'
    sheet.append([payload.get('title') or '月度评分'])
    sheet['A1'].font = Font(bold=True, size=14)
    sheet.append([f"周期：{payload.get('period') or '（无）'}"])
    sheet.append([])
    sheet.append(HEADERS)

    header_row = sheet[4]
    for cell in header_row:
        cell.font = Font(bold=True)
        cell.fill = PatternFill('solid', fgColor='EEEEEE')
        cell.alignment = Alignment(horizontal='center')

    for row in rows:
        sheet.append([
            row.get('person', ''),
            row.get('hours', 0),
            row.get('completion', 0),
            row.get('quality', 0),
            row.get('learn', 0),
            row.get('total', 0),
            '已确认' if row.get('status') == 'confirmed' else '草稿',
            row.get('highlight', ''),
            row.get('improve', ''),
            ' / '.join(row.get('basis') or []),
        ])

    for index, width in enumerate(WIDTHS, start=1):
        sheet.column_dimensions[chr(64 + index)].width = width
    sheet.freeze_panes = 'A5'

    book.save(target)
    return 0


if __name__ == '__main__':
    sys.exit(main())