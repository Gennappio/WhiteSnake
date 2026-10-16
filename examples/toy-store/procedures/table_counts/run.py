#!/usr/bin/env python3
"""Sum a numeric column of the first markdown table in a file, excluding any row labelled Total.

Usage: run.py <markdown-file> <column-header-substring>
Prints JSON: {"column": ..., "rows": [[arm, value], ...], "total": n}
"""
import json
import re
import sys


def main() -> int:
    path, wanted = sys.argv[1], sys.argv[2].lower()
    rows = [l.strip() for l in open(path, encoding="utf-8") if l.strip().startswith("|")]
    if len(rows) < 2:
        print(json.dumps({"error": "no markdown table found"}))
        return 2
    header = [c.strip() for c in rows[0].strip("|").split("|")]
    idx = next((i for i, h in enumerate(header) if wanted in h.lower()), None)
    if idx is None:
        print(json.dumps({"error": f"no column matching {wanted!r}", "header": header}))
        return 2
    out, total = [], 0
    for line in rows[2:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or cells[0].lower() == "total":
            continue
        m = re.search(r"-?\d+", cells[idx]) if idx < len(cells) else None
        if not m:
            continue
        value = int(m.group())
        out.append([cells[0], value])
        total += value
    print(json.dumps({"column": header[idx], "rows": out, "total": total}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
