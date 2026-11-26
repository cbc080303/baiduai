#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双人标注一致率对照 v1.1

输入两份独立标注的 CSV，输出条目级一致率、字段一致率与分歧清单。

两种模式：
  全量（默认）：列 编号,任务,负责人,截止时间,约束,原文依据,标注人
      两人各自从转录里摘条目、各自编号，所以按任务文本配对。
  小样本（--small）：列 编号,语料组,原文依据,任务,负责人,截止时间,算不算待办,备注,标注人
      条目由脚本预填、编号统一，按编号配对；先比"算不算待办"，再比字段。

用法：
  python agreement.py 双人标注_标注员A.csv 双人标注_标注员B.csv
  python agreement.py A.csv B.csv --out 一致率对照表.md
  python agreement.py 双人标注_小样本_标注员A.csv 双人标注_小样本_标注员B.csv --small

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


def load_small(path):
    """小样本表按「编号」预填且唯一，直接以编号为键。"""
    with open(path, encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("编号") or "").strip()]
    return {r["编号"].strip(): r for r in rows}


def verdict_of(row):
    """小样本专用判断：True=算待办，False=不算，None=没填。

    优先级：先看「算不算待办」列，再看任务列是否写了字。
    填了 N 却仍写了任务，按 N 算（以显式判断为准）。
    """
    v = (row.get("算不算待办") or "").strip().upper()
    task = (row.get("任务") or "").strip()
    if v.startswith("N"):
        return False
    if v.startswith("Y"):
        return True if task else None
    if task:
        return True
    return None


def small_main(path_a, path_b, out_path):
    """小样本模式：按编号配对，先比「算不算」，再比字段。"""
    a, b = load_small(path_a), load_small(path_b)
    ids = sorted(set(a) | set(b), key=lambda s: (s.split("-")[0], int(s.split("-")[-1])
                                                  if s.split("-")[-1].isdigit() else 0))
    n = len(ids)
    both_y, both_n, mixed, unfilled = [], [], [], []
    for i in ids:
        va, vb = verdict_of(a.get(i, {})), verdict_of(b.get(i, {}))
        if va is None or vb is None:
            unfilled.append(i)
        elif va and vb:
            both_y.append(i)
        elif not va and not vb:
            both_n.append(i)
        else:
            mixed.append((i, va, vb))

    filled = n - len(unfilled)
    item_agree = (len(both_y) + len(both_n)) / n if n else 0.0
    owner_same = sum(1 for i in both_y
                     if norm_names(a[i].get("负责人")) == norm_names(b[i].get("负责人")))
    due_same = sum(1 for i in both_y
                   if norm_due(a[i].get("截止时间")) == norm_due(b[i].get("截止时间")))
    quote_same = sum(1 for i in both_y
                     if (a[i].get("原文依据") or "").strip("“”\" ") ==
                        (b[i].get("原文依据") or "").strip("“”\" "))
    m = len(both_y)
    field_agree = (owner_same + due_same) / (2 * m) if m else 0.0

    if not filled:
        verdict = "尚未填写：两人都还没填，先按《20 分钟标注卡》各填一遍"
    elif item_agree >= 0.8 and field_agree >= 0.8:
        verdict = "口径可用（小样本方向性通过），可进全量标注"
    elif item_agree >= 0.6:
        verdict = "回来补手册条款，重标分歧段"
    else:
        verdict = "停：手册不清晰，先改条款再标"

    L = []
    L.append(f"## 小样本一致率｜{path_a} × {path_b}\n")
    L.append("> 关口：这是 12 条预填样本的方向性结果，**不是统计估计**；"
             "条目一致率按「两人对同一条是否算待办 + 字段是否写一致」计算，误差范围很宽。\n")
    L.append("### 一、汇总")
    L.append("| 指标 | 值 |")
    L.append("|---|---|")
    L.append(f"| 样本条数 | {n} |")
    L.append(f"| 已填条数 | {filled} |")
    L.append(f"| 两人都判「算」 | {len(both_y)} |")
    L.append(f"| 两人都判「不算」 | {len(both_n)} |")
    L.append(f"| 一人算一人不算 | {len(mixed)} |")
    L.append(f"| 未填 | {len(unfilled)} |")
    L.append(f"| 条目一致率 | {item_agree:.1%} |")
    L.append(f"| 负责人一致率 | {(owner_same / m if m else 0):.1%} |")
    L.append(f"| 截止时间一致率 | {(due_same / m if m else 0):.1%} |")
    L.append(f"| 原文依据一致率 | {(quote_same / m if m else 0):.1%} |")
    L.append(f"| 字段综合一致率 | {field_agree:.1%} |")
    L.append(f"| 判定 | {verdict} |")

    L.append("\n### 二、「算不算待办」分歧")
    L.append("| 编号 | A | B | 原文依据 |")
    L.append("|---|---|---|---|")
    for i, va, vb in mixed:
        L.append(f"| {i} | {'算' if va else '不算'} | {'算' if vb else '不算'} "
                 f"| {(a.get(i) or b.get(i)).get('原文依据', '')} |")
    if not mixed:
        L.append("| 未发现 | — | — | — |")

    L.append("\n### 三、字段分歧（仅两人都判「算」的条目）")
    L.append("| 编号 | 字段 | A | B |")
    L.append("|---|---|---|---|")
    diff = 0
    for i in both_y:
        if norm_names(a[i].get("负责人")) != norm_names(b[i].get("负责人")):
            diff += 1
            L.append(f"| {i} | 负责人 | {a[i].get('负责人', '')} | {b[i].get('负责人', '')} |")
        if norm_due(a[i].get("截止时间")) != norm_due(b[i].get("截止时间")):
            diff += 1
            L.append(f"| {i} | 截止时间 | {a[i].get('截止时间', '')} | {b[i].get('截止时间', '')} |")
        if (a[i].get("原文依据") or "").strip("“”\" ") != (b[i].get("原文依据") or "").strip("“”\" "):
            diff += 1
            L.append(f"| {i} | 原文依据 | 被改动 | 被改动 |")
    if not diff:
        L.append("| 未发现 | — | — | — |")

    if unfilled:
        L.append("\n### 四、还没填的条目")
        L.append("| 编号 |")
        L.append("|---|")
        for i in unfilled:
            L.append(f"| {i} |")

    text = "\n".join(L)
    print(text)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"\n已写入 {out_path}")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return
    out_path = None
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    if "--small" in sys.argv:
        small_main(args[0], args[1], out_path)
        return

    rows_a, rows_b = load(args[0]), load(args[1])
    if not rows_a and not rows_b:
        print("两份表都没有条目。全量模式按「任务」列非空才算一条；")
        print("如果用的是 12 条预填表，请加 --small（它按「算不算待办」判断，允许任务留空）。")
        return
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