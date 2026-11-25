#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双人标注一致率对照 v1.0

输入两份独立标注的 CSV（列：编号,任务,负责人,截止时间,约束,原文依据,标注人），
输出条目级一致率、字段一致率与分歧清单。

用法：
  python agreement.py 双人标注_标注员A.csv 双人标注_标注员B.csv
  python agreement.py A.csv B.csv --out 一致率对照表.md

判定口径（与《会议待办判定手册 v1.0》配套）：
  条目一致率 ≥ 0.80 且 字段一致率 ≥ 0.80  → 口径可用，可进全量
  0.60 — 0.80                            → 回来补手册条款，重标分歧段
  < 0.60                                → 停，手册不清晰，不是标注员的问题
"""

import csv
import re
import sys

from qc_tools import bigrams, long_common

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROLE_RE = re.compile(r"[（(](主责?|配合|协办|主办)[)）]")
SPLIT_RE = re.compile(r"[／/、,，]+")


def load(path):
    with open(path, encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("任务") or "").strip()]
    return rows


def norm_names(cell):
    cell = ROLE_RE.sub("", cell or "").strip()
    if not cell or "待确认" in cell:
        return set()
    return {p.strip() for p in SPLIT_RE.split(cell) if p.strip()}


def norm_due(cell):
    return re.sub(r"\s+", "", (cell or "").strip())


def similarity(a, b):
    ta, tb = a.get("任务", ""), b.get("任务", "")
    lc = long_common(ta, tb)
    ba, bb = bigrams(ta), bigrams(tb)
    r = len(ba & bb) / max(1, min(len(ba), len(bb))) if ba and bb else 0.0
    return lc, r


def acceptable(a, b):
    lc, r = similarity(a, b)
    if lc >= 4 or r >= 0.5:
        return True
    # 任务表述差异大但负责人+依据完全相同，也认作同一条
    if norm_names(a.get("负责人")) and norm_names(a.get("负责人")) == norm_names(b.get("负责人")):
        qa = (a.get("原文依据") or "").strip("“”\" ")
        qb = (b.get("原文依据") or "").strip("“”\" ")
        if qa and qa == qb:
            return True
    return False


def match(rows_a, rows_b):
    pairs, used_a, used_b = [], set(), set()
    cand = []
    for i, a in enumerate(rows_a):
        for j, b in enumerate(rows_b):
            if not acceptable(a, b):
                continue
            lc, r = similarity(a, b)
            owner_bonus = 1 if norm_names(a.get("负责人")) == norm_names(b.get("负责人")) else 0
            due_bonus = 1 if norm_due(a.get("截止时间")) == norm_due(b.get("截止时间")) else 0
            cand.append((owner_bonus * 2 + due_bonus + lc / 10 + r, i, j))
    cand.sort(reverse=True)
    for score, i, j in cand:
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        pairs.append((rows_a[i], rows_b[j]))
    only_a = [r for i, r in enumerate(rows_a) if i not in used_a]
    only_b = [r for j, r in enumerate(rows_b) if j not in used_b]
    return pairs, only_a, only_b


def sanity(rows, tag):
    """列错位自检：原文依据为空、过短或等于标注人，说明逗号把列挤掉了。"""
    bad = []
    for i, r in enumerate(rows, 2):
        q = (r.get("原文依据") or "").strip()
        who = (r.get("标注人") or "").strip()
        if not q or q == who or len(q) < 4:
            bad.append(i)
    if bad:
        print(f"⚠ {tag} 第 {bad} 行疑似列错位：原文依据为空或等于标注人值。")
        print("  常见原因：用全角逗号或中文引号分隔字段。请用 Excel/WPS 另存为 UTF-8 CSV，"
              "或把含逗号的单元格用英文双引号包起来。\n")
    return bad


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    rows_a, rows_b = load(args[0]), load(args[1])
    sanity(rows_a, args[0])
    sanity(rows_b, args[1])
    pairs, only_a, only_b = match(rows_a, rows_b)

    n_a, n_b, n_m = len(rows_a), len(rows_b), len(pairs)
    union = n_m + len(only_a) + len(only_b)
    item_agree = n_m / union if union else 0.0
    count_dev = abs(n_a - n_b) / max(n_a, n_b) if max(n_a, n_b) else 0.0

    owner_same = sum(1 for a, b in pairs if norm_names(a.get("负责人")) == norm_names(b.get("负责人")))
    due_same = sum(1 for a, b in pairs if norm_due(a.get("截止时间")) == norm_due(b.get("截止时间")))
    quote_same = sum(1 for a, b in pairs
                     if (a.get("原文依据") or "").strip("“”\" ") == (b.get("原文依据") or "").strip("“”\" "))
    field_agree = (owner_same + due_same) / (2 * n_m) if n_m else 0.0

    if item_agree >= 0.8 and field_agree >= 0.8:
        verdict = "口径可用，可进全量标注"
    elif item_agree >= 0.6:
        verdict = "回来补手册条款，重标分歧段"
    else:
        verdict = "停：手册不清晰，不是标注员的问题"

    lines = []
    lines.append(f"## 一致率对照｜{args[0]} × {args[1]}\n")
    lines.append("### 一、汇总")
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    lines.append(f"| A 条数 | {n_a} |")
    lines.append(f"| B 条数 | {n_b} |")
    lines.append(f"| 匹配条数 | {n_m} |")
    lines.append(f"| 仅 A 有 | {len(only_a)} |")
    lines.append(f"| 仅 B 有 | {len(only_b)} |")
    lines.append(f"| 条目一致率 | {item_agree:.1%} |")
    lines.append(f"| 条数偏差 | {count_dev:.1%} |")
    lines.append(f"| 负责人一致率 | {(owner_same / n_m if n_m else 0):.1%} |")
    lines.append(f"| 截止时间一致率 | {(due_same / n_m if n_m else 0):.1%} |")
    lines.append(f"| 原文依据一致率 | {(quote_same / n_m if n_m else 0):.1%} |")
    lines.append(f"| 字段综合一致率 | {field_agree:.1%} |")
    lines.append(f"| 判定 | {verdict} |")

    lines.append("\n### 二、条目级分歧")
    lines.append("| 类型 | 编号 | 任务 | 负责人 | 截止 | 原文依据 |")
    lines.append("|---|---|---|---|---|---|")
    for r in only_a:
        lines.append(f"| 仅 A 有 | {r.get('编号','')} | {r.get('任务','')} | {r.get('负责人','')} | "
                     f"{r.get('截止时间','')} | {r.get('原文依据','')} |")
    for r in only_b:
        lines.append(f"| 仅 B 有 | {r.get('编号','')} | {r.get('任务','')} | {r.get('负责人','')} | "
                     f"{r.get('截止时间','')} | {r.get('原文依据','')} |")
    if not only_a and not only_b:
        lines.append("| 未发现 | — | — | — | — | — |")

    lines.append("\n### 三、字段级分歧（同一条目、不同字段）")
    lines.append("| 编号（A/B） | 任务 | 字段 | A 值 | B 值 |")
    lines.append("|---|---|---|---|---|")
    diff = 0
    for a, b in pairs:
        if norm_names(a.get("负责人")) != norm_names(b.get("负责人")):
            diff += 1
            lines.append(f"| {a.get('编号','')}/{b.get('编号','')} | {a.get('任务','')} | 负责人 | "
                         f"{a.get('负责人','')} | {b.get('负责人','')} |")
        if norm_due(a.get("截止时间")) != norm_due(b.get("截止时间")):
            diff += 1
            lines.append(f"| {a.get('编号','')}/{b.get('编号','')} | {a.get('任务','')} | 截止时间 | "
                         f"{a.get('截止时间','')} | {b.get('截止时间','')} |")
        if (a.get("原文依据") or "").strip("“”\" ") != (b.get("原文依据") or "").strip("“”\" "):
            diff += 1
            lines.append(f"| {a.get('编号','')}/{b.get('编号','')} | {a.get('任务','')} | 原文依据 | "
                         f"{a.get('原文依据','')} | {b.get('原文依据','')} |")
    if diff == 0:
        lines.append("| 未发现 | — | — | — | — |")

    text = "\n".join(lines)
    print(text)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"\n已写入 {out_path}")


if __name__ == "__main__":
    main()