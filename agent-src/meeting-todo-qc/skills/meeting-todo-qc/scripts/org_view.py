#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会议待办组织视图 v1.0

把一张待办表从“任务清单”变成管理者能用的三张视图：
  1) 按人聚合负载：每个人被派了几条、几条没时限、风险分多少
  2) 风险排序：缺负责人 > 缺截止 > 责任共担 > 软要求，给出处置建议
  3) 补字段队列：每条待确认字段配一句“下次会上问什么”

只读，不修改任何文件；判定口径见《会议待办判定手册 v1.0》。

用法：
  python org_view.py 修正版.csv 转录.txt
  python org_view.py 修正版.csv 转录.txt --no-quote-check
"""

import csv
import re
import sys

import qc_tools

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 风险权重（与手册保持一致，改动需同步手册版本号）
W_NO_OWNER = 3   # 缺负责人：任务无人接，直接卡死
W_NO_DUE = 2     # 缺截止：无法排期
W_SHARED = 1     # 责任共担：跨部门推诿风险
W_SOFT = 2       # 软要求：可能根本不该执行
W_BAD_QUOTE = 3  # 依据不可追溯：无法追责


def load_rows(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def parse_owners(cell, names):
    """返回 [(姓名, '主'|'配合')]"""
    if not cell or "待确认" in cell:
        return []
    out = []
    for seg in re.split(r"[／/]", cell):
        seg = seg.strip()
        if not seg:
            continue
        role = "配合" if "配合" in seg else "主"
        for nm in names:
            if nm in seg:
                out.append((nm, role))
                break
    return out


def quote_ok(row, raw):
    """与 qc_tools.check_quotes 同口径：先做空白归一化再逐字比对。

    空依据返回 False（不加分），但调用方应另行提示“不可检”，
    而不是把它当成“依据不可追溯”扣风险分——两者责任不同。
    """
    def squeeze(s):
        return re.sub(r"\s+", "", s)

    body = squeeze(raw or "")
    parts = [p.strip() for p in re.split(r"[｜|＋+]", (row.get("原文依据") or "")) if p.strip()]
    if not parts:
        return False
    return all(squeeze(p.strip("“”\"")) in body for p in parts)


def build_items(rows, names, raw):
    items = []
    for r in rows:
        owners = parse_owners(r.get("负责人"), names)
        no_owner = not owners
        due = (r.get("截止时间") or "").strip()
        no_due = (not due) or due.startswith("待确认")
        shared = len(owners) > 1
        soft = "讨论性表述" in (r.get("约束") or "")
        has_quote = bool((r.get("原文依据") or "").strip())
        # 不可检（缺依据列/空串）不算“依据不可追溯”：无法检查不等于检查失败，不扣风险分
        bad_quote = (has_quote and not quote_ok(r, raw)) if raw else False

        risk = 0
        tags = []
        if no_owner:
            risk += W_NO_OWNER
            tags.append("缺负责人")
        if no_due:
            risk += W_NO_DUE
            tags.append("缺截止")
        if soft:
            risk += W_SOFT
            tags.append("软要求待定")
        if shared:
            risk += W_SHARED
            tags.append("责任共担")
        if bad_quote:
            risk += W_BAD_QUOTE
            tags.append("依据不可追溯")

        level = "P0" if risk >= 3 else ("P1" if risk == 2 else ("P2" if risk == 1 else "P3"))
        items.append({"编号": r["编号"], "任务": r["任务"], "负责人": r.get("负责人", ""),
                      "截止时间": due or "待确认", "owners": owners, "risk": risk,
                      "level": level, "tags": tags, "soft": soft, "no_due": no_due,
                      "no_owner": no_owner, "shared": shared})
    return items


def readiness(it):
    """三档：可直接建单 / 需补字段 / 待人工判断"""
    if it["no_owner"] or it["soft"]:
        return "待人工判断"
    if it["no_due"] or it["shared"]:
        return "需补字段"
    return "可直接建单"


def person_view(items, names):
    table = {nm: {"主": 0, "配合": 0, "有截止": 0, "缺截止": 0, "风险": 0, "最高": 0} for nm in names}
    for it in items:
        for nm, role in it["owners"]:
            d = table[nm]
            d[role] += 1
            if it["no_due"]:
                d["缺截止"] += 1
            else:
                d["有截止"] += 1
            d["风险"] += it["risk"]
            d["最高"] = max(d["最高"], it["risk"])
    rows = []
    for nm, d in table.items():
        total = d["主"] + d["配合"]
        if total == 0:
            continue
        note = ""
        if total >= 3 and d["缺截止"] >= 2:
            note = "负载集中且时限不清，建议会上一次性对齐"
        elif d["缺截止"] >= 2:
            note = "多条缺时限，排期风险高"
        elif total >= 3:
            note = "承担条数偏多，可考虑分派"
        rows.append({"姓名": nm, "总": total, "主": d["主"], "配合": d["配合"],
                     "有截止": d["有截止"], "缺截止": d["缺截止"],
                     "风险": d["风险"], "最高": d["最高"], "提示": note or "—"})
    rows.sort(key=lambda x: (-x["风险"], -x["总"]))
    return rows


QUESTIONS = {
    "负责人": "这件事谁来牵头？",
    "截止时间": "什么时候能给到？",
}


def queue_view(items):
    out = []
    for it in items:
        if it["no_owner"]:
            out.append({"编号": it["编号"], "待补": "负责人", "任务": it["任务"],
                        "建议问法": "这件事谁来牵头？", "备注": "原文只有“大家”，未落到人"})
        elif it["no_due"]:
            who = it["owners"][0][0] if it["owners"] else "责任人"
            out.append({"编号": it["编号"], "待补": "截止时间", "任务": it["任务"],
                        "建议问法": f"{who}这边什么时候能给到？",
                        "备注": "原文未给完成时限" if not re.search(r"\d|[一二三四五六日天]|月|号", it["原文依据"] if "原文依据" in it else "") else "原文只有锁定时点，非完成时限"})
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) < 2:
        print(__doc__)
        return
    table_path, transcript_path = args[0], args[1]
    raw = ""
    if "--no-quote-check" not in sys.argv:
        with open(transcript_path, encoding="utf-8") as f:
            raw = f.read()
    names, _ = qc_tools.parse_transcript(transcript_path)
    rows = load_rows(table_path)
    items = build_items(rows, names, raw)

    total = len(items)
    bucket = {"可直接建单": 0, "需补字段": 0, "待人工判断": 0}
    for it in items:
        bucket[readiness(it)] += 1

    print(f"## 组织视图｜{table_path}\n共 {total} 条｜可直接建单 {bucket['可直接建单']}｜"
          f"需补字段 {bucket['需补字段']}｜待人工判断 {bucket['待人工判断']}\n")

    print("### 一、按人聚合负载（按风险分降序）")
    print("| 姓名 | 承担条数 | 主责 | 配合 | 有截止 | 缺截止 | 风险分 | 最高风险 | 提示 |")
    print("|---|---|---|---|---|---|---|---|---|")
    pv = person_view(items, names)
    for r in pv:
        print(f"| {r['姓名']} | {r['总']} | {r['主']} | {r['配合']} | {r['有截止']} | "
              f"{r['缺截止']} | {r['风险']} | {r['最高']} | {r['提示']} |")
    unassigned = [it for it in items if it["no_owner"]]
    if unassigned:
        print(f"| 未分配 | {len(unassigned)} | 0 | 0 | 0 | 0 | "
              f"{sum(i['risk'] for i in unassigned)} | — | 无人承接，需当场指派 |")

    print("\n### 二、风险排序")
    print("| 优先级 | 编号 | 任务 | 负责人 | 问题类型 | 风险分 | 建议动作 |")
    print("|---|---|---|---|---|---|---|")
    for it in sorted(items, key=lambda x: (-x["risk"], int(re.sub(r"\D", "", x["编号"]) or 0))):
        if it["risk"] == 0:
            continue
        action = ("当场指派负责人" if it["no_owner"] else
                  ("补完成时限" if it["no_due"] else "确认是否需要执行"))
        if it["shared"] and not it["no_owner"]:
            action = "明确主责与配合分工" + ("，并补时限" if it["no_due"] else "")
        print(f"| {it['level']} | {it['编号']} | {it['任务']} | {it['负责人']} | "
              f"{'/'.join(it['tags'])} | {it['risk']} | {action} |")

    print("\n### 三、补字段队列（下次会上逐条问）")
    print("| 编号 | 待补字段 | 任务 | 建议问法 |")
    print("|---|---|---|---|")
    for q in queue_view(items):
        print(f"| {q['编号']} | {q['待补']} | {q['任务']} | {q['建议问法']} |")

    print("\n### 四、负载均衡")
    if pv:
        counts = [r["总"] for r in pv]
        man_times = sum(counts)          # 人次，共担任务会被计两次
        assigned = len([it for it in items if it["owners"]])  # 条数
        avg = man_times / len(counts)
        top = max(pv, key=lambda r: r["总"])   # 负载最高者，不能取风险排序后的首行
        print(f"有主待办 {assigned} 条，分摊到 {man_times} 人次，人均 {avg:.1f} 人次，"
              f"最高 {max(counts)} 人次（{top['姓名']}），集中度 {max(counts) / avg:.1f} 倍。")


if __name__ == "__main__":
    main()