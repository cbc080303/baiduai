#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会议待办 -> 任务系统导入模板 v1.0

把《会议待办质检器》的修正版 CSV 转成三份可落到任务系统的导入模板：
飞书任务 / 钉钉待办 / Teambition 任务，并给出字段映射表与导入前检查清单。

设计原则：
  1) 只做字段搬运与格式规范化，不推断原文没有的信息。
  2) 相对时间按 --base-date 换算成 ISO 日期；换算不了的（"待确认""价格机制确认后"）
     留空，并把原文与原因写进检查清单，由人补。
  3) 平台列名集中在 PROFILES 里，可用 --profile 覆盖。平台自带的批量导入以它自己
     下载的空模板首行为准，本脚本给的是语义对齐的默认列名。

用法：
  python to_task_import.py 会议待办_修正版_v1.1.csv --out 导入模板_第1组
  python to_task_import.py 会议待办_修正版_第4组.csv --out 导入模板_第4组 --base-date 2026-11-26
  python to_task_import.py 修正版.csv --out out --list-name "产品运营周会"

输出（--out 目录下）：
  feishu_tasks.csv      飞书任务
  dingtalk_todo.csv     钉钉待办
  teambition_tasks.csv  Teambition 任务
  字段映射表.md          源字段 -> 三平台字段 + 转换规则
  导入前检查清单.md      逐条状态、空值原因、需人工项

CSV 输入列：编号,任务,负责人,截止时间,约束,原文依据
"""

import csv
import datetime
import pathlib
import re
import sys

SRC_COLUMNS = ["编号", "任务", "负责人", "截止时间", "约束", "原文依据"]

# 平台列名与取值规则：语义对齐各平台的开放接口/界面字段，可整体替换。
PROFILES = {
    "feishu": {
        "file": "feishu_tasks.csv",
        "label": "飞书任务",
        "columns": ["任务名称", "负责人", "截止时间", "描述", "清单"],
    },
    "dingtalk": {
        "file": "dingtalk_todo.csv",
        "label": "钉钉待办",
        "columns": ["待办标题", "执行人", "截止时间", "描述", "优先级"],
    },
    "teambition": {
        "file": "teambition_tasks.csv",
        "label": "Teambition 任务",
        "columns": ["任务标题", "执行者", "截止时间", "优先级", "任务列表", "备注"],
    },
}

DEFAULT_LIST = "会议待办质检导入"
DEFAULT_PRIORITY = "普通"
WEEK = "一二三四五六日天"


def read_rows(path):
    with open(path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    miss = [c for c in SRC_COLUMNS if rows and c not in rows[0]]
    if miss:
        sys.exit(f"输入缺少列：{'、'.join(miss)}")
    return rows


def parse_owner(cell):
    """把负责人单元格拆成主责 + 附带说明。不猜人名，只处理原文写法。"""
    cell = (cell or "").strip()
    if not cell or "待确认" in cell:
        return "", ""
    parts = re.split(r"[／/]", cell)
    main = parts[0].strip()
    extra = ""
    if len(parts) > 1:
        tails = []
        for p in parts[1:]:
            notes = re.findall(r"[（(]([^）)]*)[）)]", p)
            name = re.sub(r"[（(][^）)]*[）)]", "", p).strip()
            if name:
                tails.append(f"{name}（{'/'.join(notes)}）" if notes else name)
        extra = "；配合：" + "、".join(tails) if tails else ""
    main = re.sub(r"[（(][^）)]*[）)]", "", main).strip()
    return main, extra


def _weekday_index(ch):
    return WEEK.index(ch)


def resolve_due(text, base):
    """相对时间 -> (ISO 日期或空, 备注)。换算不了就留空，不猜。"""
    raw = (text or "").strip()
    if not raw:
        return "", "原文未给时限"
    norm = raw.replace("之前", "前").replace(" ", "")

    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", norm)
    if m:
        return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat(), ""

    if "待确认" in norm:
        return "", f"原文未给时限：{raw}"
    if "确认后" in norm or "评审会前" in norm or "之后" in norm:
        return "", f"非日历日期，依赖前序事件：{raw}"

    m = re.search(r"(下个月|本月|这个月)?(\d{1,2})号", norm)
    if m:
        scope = m.group(1) or ""
        day = int(m.group(2))
        year, month = base.year, base.month
        if scope == "下个月":
            month += 1
            if month > 12:
                year, month = year + 1, 1
        try:
            d = datetime.date(year, month, day)
        except ValueError:
            return "", f"日期不存在：{raw}"
        note = "" if d >= base else "该日期已过，需确认是否指下个月"
        return d.isoformat(), note

    if re.search(r"(本|这)个月(内|底|末)", norm) or "月底" in norm or "月末" in norm:
        nxt = datetime.date(base.year + (base.month == 12), (base.month % 12) + 1, 1)
        return (nxt - datetime.timedelta(days=1)).isoformat(), "按月末处理"

    m = re.search(r"(本|这|下)?(?:周|星期)([一二三四五六日天])", norm)
    if m:
        scope = m.group(1) or ""
        idx = _weekday_index(m.group(2))
        monday = base - datetime.timedelta(days=base.weekday())
        d = monday + datetime.timedelta(days=idx)
        note = ""
        if scope == "下":
            d += datetime.timedelta(days=7)
        elif d < base:
            note = "该日早于基准日，按本周处理，需确认"
        if "条件触发" in norm:
            note = (note + "；" if note else "") + "条件触发：见约束列"
        return d.isoformat(), note

    if re.search(r"(本|这)周(内|末)", norm):
        monday = base - datetime.timedelta(days=base.weekday())
        return (monday + datetime.timedelta(days=6)).isoformat(), "按本周日处理"

    return "", f"无法换算为日历日期：{raw}"


def build(row, base):
    no = (row.get("编号") or "").strip()
    task = (row.get("任务") or "").strip()
    owner, owner_extra = parse_owner(row.get("负责人"))
    due, due_note = resolve_due(row.get("截止时间"), base)
    cons = (row.get("约束") or "").strip()
    quote = (row.get("原文依据") or "").strip()

    desc = f"约束：{cons}" if cons else ""
    desc += ("；" if desc else "") + f"原文依据：{quote}"
    desc += f"；质检编号：#{no}"

    note_parts = [p for p in (owner_extra.lstrip("；"), due_note) if p]
    remark = "；".join(note_parts)
    return {
        "编号": no,
        "任务": task,
        "负责人": owner,
        "负责人备注": owner_extra.lstrip("；"),
        "截止时间": due,
        "截止原文": (row.get("截止时间") or "").strip(),
        "截止备注": due_note,
        "约束": cons,
        "描述": desc,
        "备注": remark,
    }


def to_profile(item, profile, list_name):
    if profile == "feishu":
        return [item["任务"], item["负责人"], item["截止时间"], item["描述"], list_name]
    if profile == "dingtalk":
        return [item["任务"], item["负责人"], item["截止时间"], item["描述"], DEFAULT_PRIORITY]
    if profile == "teambition":
        return [item["任务"], item["负责人"], item["截止时间"], DEFAULT_PRIORITY,
                list_name, item["备注"]]
    raise ValueError(profile)


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def status_of(item):
    """三档，与 org_view.py 的 readiness 同口径：可直接建单 / 需补字段 / 待人工判断。

    判定用原文而不是换算结果：条件型时限（如「价格机制确认后」）在组织视图里算
    「有截止」，因为能不能开工是清楚的；但它的导入值仍是空的，检查清单会单独点名。
    这样一份数据在两个脚本里的档位一致，不会出现两套数字。
    """
    cons = item.get("约束") or ""
    soft = ("讨论性表述" in cons) or ("需人工判断" in cons)
    shared = "配合：" in (item.get("备注") or "")
    if not item["负责人"] or soft:
        return "待人工判断"
    if not item["截止原文"] or item["截止原文"].startswith("待确认") or shared:
        return "需补字段"
    return "可直接建单"


def mapping_md(items, base, list_name):
    out = ["# 字段映射表（会议待办 -> 任务系统）", "",
           f"> 基准日：{base.isoformat()}（周四）；清单/任务列表默认 `{list_name}`；"
           f"优先级默认 `{DEFAULT_PRIORITY}`（脚本不推断优先级）。",
           "> 平台列名以各平台下载的空模板首行为准；若不一致，改 `PROFILES` 里的列名即可，不影响取值逻辑。",
           "", "## 一、源字段 -> 三平台字段", "",
           "| 源字段 | 飞书任务 | 钉钉待办 | Teambition | 转换规则 |",
           "|---|---|---|---|---|",
           "| 编号 | 描述内 `质检编号：#n` | 描述内 `质检编号：#n` | 备注内 `质检编号：#n` | 原样，用于回溯到质检报告 |",
           "| 任务 | 任务名称 | 待办标题 | 任务标题 | 原样，仅去首尾空白 |",
           "| 负责人 | 负责人 | 执行人 | 执行者 | `待确认` 置空；多人写 `A（主）／B（配合）` 时取 A，B 进备注 |",
           "| 截止时间 | 截止时间 | 截止时间 | 截止时间 | 相对时间按基准日换算为 ISO；不可换算者置空并写原因 |",
           "| 约束 | 描述 `约束：…` | 同上 | 同上 | 原样 |",
           "| 原文依据 | 描述 `原文依据：…` | 同上 | 同上 | 逐字引用，不改写 |",
           "", "## 二、空值与默认值", "",
           "| 情形 | 处理 |",
           "|---|---|",
           "| 负责人为 `待确认` | 置空，检查清单标「需补负责人」 |",
           "| 截止时间为 `待确认` / `…确认后` / `评审会前` | 置空，备注写依赖原因 |",
           "| 优先级 | 统一填 `普通`，由人按会议重要性二次调整 |",
           "| 清单 / 任务列表 | 统一填会话名，可 `--list-name` 改 |",
           "", "## 三、本次输入的换算结果", "",
           "| 编号 | 截止原文 | 换算结果 | 说明 |",
           "|---|---|---|---|"]
    for it in items:
        out.append(f"| {it['编号']} | {it['截止原文'] or '—'} | {it['截止时间'] or '（空）'} "
                   f"| {it['截止备注'] or '—'} |")
    return "\n".join(out) + "\n"


def checklist_md(items, base, src, list_name):
    counts = {}
    for it in items:
        counts[status_of(it)] = counts.get(status_of(it), 0) + 1
    out = ["# 导入前检查清单", "",
           f"- 输入：`{pathlib.Path(src).name}`，{len(items)} 条",
           f"- 基准日：{base.isoformat()}",
           f"- 清单/任务列表：`{list_name}`",
           "", "## 一、汇总", "",
           "| 状态 | 条数 |", "|---|---|"]
    for k in ("可直接建单", "需补字段", "待人工判断"):
        if counts.get(k):
            out.append(f"| {k} | {counts[k]} |")
    out += ["", "## 二、逐条", "",
            "| 编号 | 任务（截断） | 负责人 | 截止时间 | 状态 | 说明 |",
            "|---|---|---|---|---|---|"]
    for it in items:
        title = it["任务"] if len(it["任务"]) <= 18 else it["任务"][:18] + "…"
        note = it["备注"]
        if not it["截止时间"] and it["截止原文"] and not it["截止原文"].startswith("待确认"):
            note = "；".join(p for p in (note, "条件时限，导入前须换算成具体日期") if p)
        out.append(f"| {it['编号']} | {title} | {it['负责人'] or '（空）'} "
                   f"| {it['截止时间'] or '（空）'} | {status_of(it)} | {note or '—'} |")
    out += ["", "## 三、导入前必须人工确认的三件事", "",
            "1. **负责人换成平台账号**：CSV 里是人名（真实会议上可能是「甲/乙」代称），"
            "导入前须替换为邮箱/手机号或平台成员 ID，否则平台会丢该字段。",
            "2. **核对相对日期换算**：换算基准是上面的基准日，跨周/跨月要复核；"
            "标「该日早于基准日」的条目务必改。",
            "3. **补空值**：检查清单里「需补…」的条目，建议先补齐再导入，"
            "否则平台里会出现无负责人或无截止的孤儿任务。"]
    return "\n".join(out) + "\n"


def sanity(items, outdir, profiles):
    errs = []
    if not items:
        errs.append("输入为空")
    nos = [it["编号"] for it in items]
    if len(set(nos)) != len(nos):
        errs.append("编号重复")
    for it in items:
        if not it["任务"]:
            errs.append(f"#{it['编号']} 任务为空")
        if "待确认" in it["负责人"]:
            errs.append(f"#{it['编号']} 负责人残留「待确认」")
    for p in profiles:
        path = outdir / PROFILES[p]["file"]
        with open(path, encoding="utf-8-sig") as f:
            got = list(csv.reader(f))
        if len(got) - 1 != len(items):
            errs.append(f"{PROFILES[p]['file']} 行数 {len(got) - 1} != {len(items)}")
        if got[0] != PROFILES[p]["columns"]:
            errs.append(f"{PROFILES[p]['file']} 表头不符")
    return errs


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    src = args[0]
    outdir = pathlib.Path(args[args.index("--out") + 1] if "--out" in args
                           else pathlib.Path(src).with_suffix("").name + "_导入模板")
    base = datetime.date.today()
    if "--base-date" in args:
        base = datetime.date.fromisoformat(args[args.index("--base-date") + 1])
    list_name = args[args.index("--list-name") + 1] if "--list-name" in args else DEFAULT_LIST
    profiles = [a for a in args if a in PROFILES] or list(PROFILES)

    rows = read_rows(src)
    items = [build(r, base) for r in rows]
    outdir.mkdir(parents=True, exist_ok=True)

    for p in profiles:
        write_csv(outdir / PROFILES[p]["file"], PROFILES[p]["columns"],
                  [to_profile(it, p, list_name) for it in items])
    (outdir / "字段映射表.md").write_text(mapping_md(items, base, list_name), encoding="utf-8")
    pathlib.Path(outdir / "导入前检查清单.md").write_text(
        checklist_md(items, base, src, list_name), encoding="utf-8")

    errs = sanity(items, outdir, profiles)
    stat = {}
    for it in items:
        stat[status_of(it)] = stat.get(status_of(it), 0) + 1

    print(f"## 输入｜{src}\n{len(items)} 条｜基准日 {base.isoformat()}｜清单名 {list_name}\n")
    print("| 状态 | 条数 |")
    print("|---|---|")
    for k in ("可直接建单", "需补字段", "待人工判断"):
        if stat.get(k):
            print(f"| {k} | {stat[k]} |")
    print()
    for p in profiles:
        print(f"- {PROFILES[p]['label']}：{PROFILES[p]['file']}（{len(items)} 行）")
    print("- 字段映射表.md / 导入前检查清单.md")
    print()
    print("自检：" + ("PASS" if not errs else "FAIL"))
    for e in errs:
        print("  - " + e)
    if errs:
        sys.exit(1)


if __name__ == "__main__":
    main()