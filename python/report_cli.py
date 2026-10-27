"""
Report bridge for the Bun engine.
Reads a legacy-format snapshot (JSON) from stdin, writes reports to reports/,
and prints a JSON object {format: path, "<format>_error": message} on stdout.

Usage:
    python python/report_cli.py [pdf|word|excel|all] < snapshot.json
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from report_generator import ReportGenerator


def main():
    # Windows pipes default to the ANSI code page; the engine sends UTF-8 and the
    # generators print emoji, so force UTF-8 on both ends.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    fmt = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    data = json.load(sys.stdin)
    generator = ReportGenerator()

    if fmt == "all":
        result = generator.generate_all(data)
        if not result:
            result = {"error": "Nenhuma biblioteca de relatório instalada (pip install -r python/requirements.txt)"}
        print(json.dumps(result))
        return

    formats = {
        "pdf": ("has_reportlab", generator.generate_pdf, "reportlab"),
        "word": ("has_docx", generator.generate_word, "python-docx"),
        "excel": ("has_openpyxl", generator.generate_excel, "openpyxl"),
    }
    if fmt not in formats:
        print(json.dumps({"error": f"Formato não suportado: {fmt}"}))
        return

    flag, fn, package = formats[fmt]
    if not getattr(generator, flag, False):
        print(json.dumps({"error": f"Dependência ausente para {fmt}: pip install {package}"}))
        return

    try:
        print(json.dumps({fmt: fn(data)}))
    except Exception as e:  # report libraries raise a wide range of errors
        print(json.dumps({f"{fmt}_error": str(e)}))


if __name__ == "__main__":
    main()
