#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""双人标注 · 小样本抽样器 v1.0

从两组修正版待办里固定抽出 12 条，生成两份「预填原文、判断留空」的标注表：

  双人标注_小样本_标注员A.csv
  双人标注_小样本_标注员B.csv

设计原则：
  1) 只预填**原文**（编号、语料组、原文依据），不预填任何判断（任务/负责人/截止）。
     预填答案会锚定标注员，一致率就没有意义了。
  2) 抽样按「判定难点」选，不随机：让 12 条覆盖模糊时限、无时限、多人主配、
     讨论性表述、承接句、纯语义派工、条件触发、单字代称八类。
  3) 两人拿到的文件内容完全相同，唯一的差别在文件名；各自填、互不看。

用法：
  python sample_annotation.py            # 生成两份表并打印抽样说明
  python sample_annotation.py --force    # 已存在也覆盖（默认不覆盖，防误删已填内容）
"""

import csv
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent

SOURCES = {
    "第1组": "会议待办_修正版_v1.1.csv",
    "第4组": "会议待办_修正版_第4组.csv",
}

# 抽中的编号 + 它考的是什么（写进抽样说明，答辩时可以直接讲）
SAMPLE = [
    ("第1组", "2", "四要件齐全的基准条"),
    ("第1组", "4", "范围型时限「本周内」"),
    ("第1组", "7", "没有时限：原文只给了场地时点"),
    ("第1组", "8", "多人主配「赵敏（主）／陈晨（配合）」"),
    ("第1组", "10", "讨论性表述「建议大家先看一下」，算不算任务"),
    ("第1组", "13", "承接句「我整理过一版，可以发群里」"),
    ("第1组", "14", "纯语义派工：没有人称、没有时间"),
    ("第4组", "3", "口语短句 + 单字代称"),
    ("第4组", "4", "条件触发「未确认时拉会」"),
    ("第4组", "5", "范围型时限「这个月内」+ 单字代称"),
    ("第4组", "9", "依赖前序「需丁公布日期后按三天排」"),
    ("第4组", "10", "条件依赖「价格机制确认后」"),
]

OUT_COLUMNS = ["编号", "语料组", "原文依据", "任务", "负责人", "截止时间", "算不算待办", "备注", "标注人"]

HEADER_NOTE = "算不算待办填 Y 或 N；填 N 时后三列留空即可"


def load_source(rel):
    with open(ROOT / rel, encoding="utf-8-sig") as f:
        return {r["编号"]: r for r in csv.DictReader(f)}


def build_rows():
    cache = {g: load_source(f) for g, f in SOURCES.items()}
    rows = []
    for group, no, _why in SAMPLE:
        src = cache[group].get(no)
        if not src:
            raise SystemExit(f"源表里找不到 {group} #{no}")
        rows.append({
            "编号": f"{group[1:]}-{no}" if False else f"{group}-{no}",
            "语料组": group,
            "原文依据": src["原文依据"],
            "任务": "",
            "负责人": "",
            "截止时间": "",
            "算不算待办": "",
            "备注": "",
            "标注人": "",
        })
    return rows


def write_table(path, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(OUT_COLUMNS)
        for r in rows:
            w.writerow([r[c] for c in OUT_COLUMNS])


def explain(rows):
    print(f"## 小样本抽样｜{len(rows)} 条（跨两组）\n")
    print("| 编号 | 语料组 | 考的是什么 |")
    print("|---|---|---|")
    for (group, no, why) in SAMPLE:
        print(f"| {group}-{no} | {group} | {why} |")
    print()
    print("## 填写规则（写进两份表的说明里）")
    print("1. 只依据「原文依据」这一列判断，不要去翻原始转录。")
    print("2. 先判「算不算待办」：填 Y 再填任务/负责人/截止；填 N 就把后三列留空。")
    print("3. 任务写动宾短语、不超过 20 字；负责人只写原文出现的人，没有写「待确认」。")
    print("4. 截止时间原样抄原文表述（「本周内」「这个月内」），不换算日期；没有写「待确认」。")
    print("5. 拿不准的写在备注，别停下来纠结——这一版测的是口径，不是你的水平。")


def main():
    force = "--force" in sys.argv
    rows = build_rows()
    outs = [ROOT / "双人标注_小样本_标注员A.csv", ROOT / "双人标注_小样本_标注员B.csv"]
    existed = [p.name for p in outs if p.exists()]
    if existed and not force:
        raise SystemExit(f"已存在：{'、'.join(existed)}。确认要覆盖请加 --force")
    for p in outs:
        write_table(p, rows)
    explain(rows)
    print()
    print("已生成：")
    for p in outs:
        print(f"  {p.name}（{len(rows)} 条，{p.stat().st_size:,} 字节）")


if __name__ == "__main__":
    main()