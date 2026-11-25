# -*- coding: utf-8 -*-
"""对拍数据源：用 Python 版 qc_tools.py 跑两组语料，输出 JSON 供 test_parity.js 比对。

用法：python parity_dump.py            # 打印 JSON
      node test_parity.js              # 自动比对 JS 版与 Python 版
"""
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import qc_tools as q  # noqa: E402


def rows_demo():
    return [dict(zip(q.DEMO_HEADER, r)) for r in q.DEMO_ROWS]


def rows_csv(name):
    with open(os.path.join(HERE, name), encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


CASES = [
    ("示例转录", "会议转录_产品运营周会_示例.txt", rows_demo()),
    ("第2组实录", "会议转录_公开实录_第2组.txt", rows_csv("会议待办_生成版_第2组.csv")),
]


def norm(items, keys):
    out = []
    for it in items:
        out.append(tuple(str(it.get(k, "")) for k in keys))
    return sorted(out)


def run():
    result = {}
    for label, path, rows in CASES:
        full = os.path.join(HERE, path)
        names, body = q.parse_transcript(full)
        sents = q.build_sentences(body)
        cands, low, orgs = q.slice_scan(names, sents, rows)
        result[label] = {
            "names": names,
            "count": len(sents),
            "cands": norm(cands, ["人物", "句", "置信度", "时间"]),
            "low": norm(low, ["人物", "句", "置信度", "时间"]),
            "orgs": norm(orgs, ["主体", "句", "时间"]),
            "cand_n": len(cands),
            "low_n": len(low),
            "org_n": len(orgs),
        }
    return result


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    print(json.dumps(run(), ensure_ascii=False))