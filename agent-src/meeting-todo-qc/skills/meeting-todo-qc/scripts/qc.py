"""会议待办质检 v1.2 —— 单入口

一条命令跑完四层：D 依据逐字回查 / A 按人切片候选 / C 字段完整性 / 组织视图，
跑之前先做一次「输入体检」：材料不适合质检时先说明，而不是给出 0 分结论。

用法：
  python qc.py --demo                                # 用内置样例跑通（先验环境）
  python qc.py --transcript 转录.txt --todo 待办.csv  # 出报告
  python qc.py --transcript 转录.txt --todo 待办.csv --out 质检输出
  python qc.py --check                               # 只做环境自检

产物（默认写到 ./质检输出/）：
  报告.md          四段式报告：结论（含输入体检）/ 逐条明细 / 修正建议 / 边界
  质检标注.csv      逐条复核标记，不改原表任何字段值
  摘要.json        计数，便于二次加工

只读输入，不改用户的转录与待办表。字段缺失一律保持“待确认”，本脚本不猜。

v1.2 修正（输入容错，2026-11-26）：
  - D 改三态：命中 / 不匹配 / 不可检。依据为空（缺列或空串）标“不可检”，
    不进命中率分母——无法检查不等于检查失败。
  - 依据比对做空白归一化（qc_tools.check_quotes 默认 normalize=True）。
  - 新增输入体检：纪要正文当转录、缺「参会人：」行、表里没有依据列，都会先提示。
  - 不可检不按「依据不可追溯」扣风险分（org_view.build_items 同步调整）。
"""

import argparse
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# scripts/ -> meeting-todo-qc/ -> skills/ -> <插件根>/samples
SAMPLE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "samples")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import qc_tools
    import org_view
except ImportError as exc:  # 脚本被单独拷走时会走到这里
    sys.stderr.write(
        "缺少同目录依赖脚本 %s。请把 scripts/ 整个目录一起拷走（qc_tools.py、org_view.py 必须同层）。\n" % exc
    )
    raise SystemExit(2)

MISSING = {"", "待确认", "待补充", "-", "—", "无", "none", "None", "TBD"}
DUE_RE = re.compile(
    r"(今天|明天|后天|本周[一二三四五六日天]?|下周[一二三四五六日天]?|本周内|下周内|"
    r"周[一二三四五六日天]|下个月\s*\d{1,2}\s*[号日]|\d{1,2}\s*月\s*\d{1,2}\s*[号日]|"
    r"\d{1,2}\s*月(上|中|下)?旬?|月底|月初|季度末|评审会前|上线前|放假前|\d+\s*天内)"
)
SPEAKER_RE = re.compile(r"^[^\s：:，。]{1,4}[：:]", re.M)


def _missing(v):
    return (v or "").strip() in MISSING


def load_transcript(path):
    with open(path, encoding="utf-8") as f:
        raw = f.read()
    names, body = qc_tools.parse_transcript(path)
    return raw, names, body


def load_rows(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


FORM_CN = {
    "timestamp+speaker": "时间码+说话人",
    "speaker": "仅说话人标记",
    "timestamp": "仅时间码",
    "plain": "纯文本",
    "empty": "空输入",
}
VERDICT_CN = {"usable": "可检", "degraded": "降级可检", "unusable": "不可检"}


def preflight(raw, rows, names, sentences, asr_info=None):
    """输入体检：判断“这份材料能不能被检”，而不是直接判它错。"""
    issues = []
    asr_info = asr_info or qc_tools.detect_asr(raw)

    if not (raw or "").strip():
        issues.append({"level": "block", "text": "转录为空。", "fix": "先给一份逐字转写稿，或用 --demo 看样例。"})
    has_names = "参会人：" in raw or "参会人:" in raw
    speakers = len(SPEAKER_RE.findall(raw or ""))
    if raw.strip() and not has_names:
        if asr_info["is_asr"] and names:
            issues.append({"level": "info",
                           "text": "没有「参会人：」行，名单由说话人标签反推 %d 人。" % len(names),
                           "fix": "反推只认出现 ≥2 次的真名；请核对是否漏人，或把转写误识别的词当成了人名。"})
        else:
            issues.append({"level": "warn", "text": "没读到「参会人：」行。",
                           "fix": "按人切片查遗漏需要这份名单；缺了 A 通道不可用，D 与 C 仍可跑。"})
    if raw.strip() and has_names and speakers == 0:
        issues.append({"level": "block", "text": "读到了参会人，但一句「姓名：内容」都没切出来。",
                       "fix": "检查每行是否「姓名：」开头，姓名要与名单一致（甲/乙/丙/丁也支持）。"})
    if raw.strip() and not has_names and speakers == 0 and len(raw) > 60:
        issues.append({"level": "block", "text": "这段文字看着像会议纪要正文，不像逐字转写稿。",
                       "fix": "纪要正文是概括过的，依据回查会全不匹配——不要用它跑 D。"})
    if raw.strip() and asr_info["is_asr"]:
        issues.append({"level": "info",
                       "text": "识别为录音转写稿（%s，%d 行：时间码 %d 行、说话人 %d 行、识别占位 %d 处）。"
                               % (FORM_CN.get(asr_info["form"], asr_info["form"]), asr_info["lines"],
                                  asr_info["ts_lines"], asr_info["speaker_lines"], asr_info["placeholder"]),
                       "fix": "已按转写稿口径处理：比对前去掉时间码、说话人前缀、识别占位与标点；结论「%s」。%s"
                              % (VERDICT_CN.get(asr_info["verdict"], asr_info["verdict"]),
                                 "；".join(asr_info["notes"]) if asr_info["notes"] else "")})

    if not rows:
        issues.append({"level": "block", "text": "待办表读不出任务行。", "fix": "表头要有「任务」列。"})
    with_quote = sum(1 for r in rows if (r.get("原文依据") or "").strip())
    if rows and with_quote == 0:
        issues.append({"level": "block", "text": "待办表没有「原文依据」，或这一列全为空。",
                       "fix": "补上依据列，否则 D 只能标「不可检」，这不是「全部不匹配」。"})
    if rows and all(_missing(r.get("负责人")) and not (r.get("负责人") or "").strip() for r in rows):
        issues.append({"level": "warn", "text": "「负责人」列全空。",
                       "fix": "C 与分档会把这些全判为待人工判断，这不是数据结论。"})
    if rows and all(not (r.get("截止时间") or "").strip() for r in rows):
        issues.append({"level": "warn", "text": "「截止时间」列全空。",
                       "fix": "先确认是不是列名写成「时限/截止」没被识别。"})
    return issues


def field_check(rows, names, sentences):
    """C 通道：字段缺失分两类——原文确实没线索 / 原文有线索但表里没填。"""
    out = []
    for row in rows:
        no_owner = _missing(row.get("负责人"))
        no_due = _missing(row.get("截止时间"))
        task = (row.get("任务") or "").strip()
        quote = (row.get("原文依据") or "").strip()
        pool = task + " " + quote

        owner_hint = "—"
        if no_owner:
            hit = [nm for nm in names if nm and nm in pool]
            if hit and qc_tools.actions(pool):
                owner_hint = "原文出现 %s，且同句有指派动作，待确认是否责任人" % "、".join(hit)
            elif hit:
                owner_hint = "原文出现 %s，但无指派动作，不能据此认定" % "、".join(hit)
            else:
                owner_hint = "原文无线索"

        due_hint = "—"
        if no_due:
            m = DUE_RE.search(pool)
            if m:
                due_hint = "原文有时限词「%s」，需确认是完成时限还是动作时点" % m.group(1)
            else:
                due_hint = "原文无线索"

        if no_owner and no_due:
            status = "缺负责人+缺截止"
        elif no_owner:
            status = "缺负责人"
        elif no_due:
            status = "缺截止"
        else:
            status = "字段齐"

        out.append(
            {
                "编号": row.get("编号", ""),
                "任务": task,
                "负责人": row.get("负责人", ""),
                "截止时间": row.get("截止时间", ""),
                "字段状态": status,
                "负责人线索": owner_hint,
                "截止线索": due_hint,
            }
        )
    return out


def md_table(headers, rows):
    if not rows:
        return "_（无）_\n"
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join(["---"] * len(headers)) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(r.get(h, "")).replace("|", "\\|") for h in headers) + " |")
    return "\n".join(out) + "\n"


def build_report(ctx):
    L = []
    L.append("# 会议待办质检报告\n")
    asr = ctx.get("asr") or {}
    L.append(
        "输入：参会人 %d 人｜句子 %d 条｜待办 %d 条%s\n"
        % (len(ctx["names"]), len(ctx["sentences"]), len(ctx["rows"]),
           "｜**录音转写稿**（%s）" % FORM_CN.get(asr.get("form"), asr.get("form")) if asr.get("is_asr") else "")
    )

    # 1 结论
    L.append("## 一、结论\n")
    issues = ctx.get("issues") or []
    L.append("- 输入体检：%s\n" % ("**%d 项提示**（见下）" % len(issues) if issues else "通过"))
    for x in issues:
        tag = {"block": "阻断", "info": "信息"}.get(x["level"], "提示")
        L.append("  - [%s] %s %s\n" % (tag, x["text"], x["fix"]))
    if asr.get("is_asr"):
        L.append(
            "- 转写形态：**%s**｜时间码 %d%%｜说话人 %d%%｜无标点长句 %d 行｜识别占位 %d 处｜结论：**%s**\n"
            % (FORM_CN.get(asr["form"], asr["form"]), round(asr["ts_ratio"] * 100),
               round(asr["speaker_ratio"] * 100), asr["punctless_long"], asr["placeholder"],
               VERDICT_CN.get(asr["verdict"], asr["verdict"]))
        )

    d_bad = [h for h in ctx["d_hits"] if h.get("checkable", True) and not h["hit"]]
    d_uncheck = [h for h in ctx["d_hits"] if not h.get("checkable", True)]
    checkable = len(ctx["d_hits"]) - len(d_uncheck)
    L.append(
        "- 依据回查：**%d/%d 命中**%s%s\n"
        % (
            checkable - len(d_bad),
            checkable,
            ("（另 %d 条不可检，不计入分母）" % len(d_uncheck)) if d_uncheck else "",
            ("，不匹配 %d 条：%s" % (len(d_bad), "、".join("#%s" % h["编号"] for h in d_bad)))
            if d_bad
            else "",
        )
    )
    L.append(
        "- 遗漏候选：**%d 条**（另低置信池 %d 条、机构主体 %d 条，均不进入候选表）\n"
        % (len(ctx["cands"]), len(ctx["low"]), len(ctx["orgs"]))
    )
    rd = ctx["readiness"]
    L.append(
        "- 可建单三档：可直接建单 **%d** 条｜需补字段 **%d** 条｜待人工判断 **%d** 条\n"
        % (rd.get("可直接建单", 0), rd.get("需补字段", 0), rd.get("待人工判断", 0))
    )
    L.append("\n")

    # 2 逐条明细
    L.append("## 二、逐条明细\n")
    L.append("### D 依据逐字回查\n")
    if not checkable:
        L.append("本次没有可检依据（待办表缺「原文依据」列或全为空），D 标为不可检，不算不匹配。\n")
    elif not d_bad:
        L.append("可检 %d 条全部命中，未发现改写或跨会议引用。\n" % checkable)
    else:
        L.append("以下条目的原文依据在本次转录中找不到对应句，属概括、改写或跨会议引用：\n")
        for h in d_bad:
            L.append("- **#%s**：引用句「%s」未命中\n" % (h["编号"], h["quote"]))
        if d_uncheck:
            L.append("\n另 %d 条无依据可查（不可检）：%s\n" % (len(d_uncheck), "、".join("#%s" % h["编号"] for h in d_uncheck)))
    L.append("\n")

    L.append("### A 按人切片候选（只出候选，采纳权在用户）\n")
    if ctx["cands"]:
        L.append(
            md_table(
                ["序号", "人物", "时间线索", "置信度", "原文", "备注"],
                [
                    {
                        "序号": i,
                        "人物": c["人物"],
                        "时间线索": c["时间"],
                        "置信度": c["置信度"],
                        "原文": c["句"],
                        "备注": c["备注"] or "—",
                    }
                    for i, c in enumerate(ctx["cands"], 1)
                ],
            )
        )
    else:
        L.append("本次未产出候选。**候选 0 条不等于没问题**：覆盖判断按表内条目吸收同句动作，若同句两件事被一条吸收，需人工再读一遍。\n")
    if ctx["low"]:
        L.append("\n低置信池（需人工过目，不上候选表）：\n")
        for c in ctx["low"]:
            L.append("- [低] %s｜%s\n" % (c["人物"], c["句"]))
    if ctx["orgs"]:
        L.append("\n机构主体（责任在机构而非个人，单列提醒）：\n")
        for o in ctx["orgs"]:
            L.append("- %s｜%s｜%s\n" % (o["主体"], o["时间"], o["句"]))
    L.append("\n")

    L.append("### C 字段完整性\n")
    L.append(
        md_table(
            ["编号", "字段状态", "任务", "负责人线索", "截止线索"],
            ctx["fields"],
        )
    )
    L.append("\n")

    # 3 修正建议
    L.append("## 三、修正建议\n")
    todo = [f for f in ctx["fields"] if f["字段状态"] != "字段齐"]
    if not todo:
        L.append("字段层面无待补项。\n")
    for f in todo:
        L.append("- **#%s** %s：%s；%s\n" % (f["编号"], f["字段状态"], f["负责人线索"], f["截止线索"]))
    if d_bad:
        L.append("\n依据层面：以下条目需回原文重引，或改写成可直接建单的描述：\n")
        for h in d_bad:
            L.append("- #%s\n" % h["编号"])
    L.append("\n组织处理顺序（风险高在前）：\n")
    L.append(
        md_table(
            ["编号", "任务", "处置"],
            [{"编号": it.get("编号", ""), "任务": it.get("任务", ""), "处置": it.get("处置", "")} for it in ctx["queue_risk"]],
        )
    )
    L.append("\n")

    # 4 边界
    L.append("## 四、边界与口径\n")
    L.append("- 本报告由确定性脚本产出：D 为字符串匹配，A 为规则切片，C 为字段与线索匹配；B（误提）与语义级判断不在脚本内，需人工或模型复核。\n")
    L.append("- 依据为空（缺列或空串）标「不可检」，不计入命中率分母，也不按「依据不可追溯」扣风险分——无法检查不等于检查失败。\n")
    L.append("- 依据比对已做空白归一化（去空格/换行后逐字匹配），不放宽到同义词、不改标点。\n")
    if ctx["cands"]:
        L.append("- A 通道人物归属按句级判定：同句出现两人时可能标成句子里先出现的那个，候选必须人工改判后再采纳。\n")
    if not ctx["names"]:
        L.append("- 转录缺少 `参会人：` 行，**A 通道未启用**：按人切片需要先知道谁被点名。\n")
    L.append("- 「可直接执行」（四要件齐全）与「可直接建单」（能直接建进任务系统）不是一回事，本报告按后者分档。\n")
    if ctx["same_source"]:
        L.append("- 待办表由生成环节与本次质检同一来源产出时，存在同源确认偏差：D 以外三层需外部复核。\n")
    L.append("- 报告不带准确率与 Kappa：样本量不足时不构成统计估计，只有条目级计数。\n")
    return "".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description="会议待办质检单入口")
    ap.add_argument("--transcript")
    ap.add_argument("--todo")
    ap.add_argument("--out", default="质检输出")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--strict-space", action="store_true", help="关闭空白归一化（默认开）")
    args = ap.parse_args(argv)

    if args.check:
        print("python:", sys.version.split()[0])
        for mod in ("qc_tools", "org_view", "agreement"):
            try:
                __import__(mod)
                print("  module %-10s OK" % mod)
            except Exception as exc:
                print("  module %-10s FAIL %s" % (mod, exc))
        t = os.path.join(SAMPLE_DIR, "样例_转录.txt")
        c = os.path.join(SAMPLE_DIR, "样例_待办.csv")
        print("  samples:", "OK" if os.path.exists(t) and os.path.exists(c) else "MISSING")
        print("  normalize:", "off" if args.strict_space else "on")
        return 0

    if args.demo:
        transcript = os.path.join(SAMPLE_DIR, "样例_转录.txt")
        todo = os.path.join(SAMPLE_DIR, "样例_待办.csv")
        if not (os.path.exists(transcript) and os.path.exists(todo)):
            sys.stderr.write("样例文件缺失：%s\n" % SAMPLE_DIR)
            return 2
    else:
        if not args.transcript or not args.todo:
            ap.print_help()
            return 1
        transcript, todo = args.transcript, args.todo
        for p in (transcript, todo):
            if not os.path.exists(p):
                sys.stderr.write("找不到输入文件：%s\n" % p)
                return 2

    if transcript.split(".")[-1].lower() == "csv" and not todo.endswith(".csv"):
        transcript, todo = todo, transcript

    raw, names, body = load_transcript(transcript)
    sentences = qc_tools.build_sentences(body)
    rows = load_rows(todo)

    d_hits = qc_tools.check_quotes(rows, raw, normalize=not args.strict_space)
    cands, low, orgs = qc_tools.slice_scan(names, sentences, rows)
    fields = field_check(rows, names, sentences)
    asr_info = qc_tools.detect_asr(raw)
    issues = preflight(raw, rows, names, sentences, asr_info)

    items = org_view.build_items(rows, names, raw)
    rd = {"可直接建单": 0, "需补字段": 0, "待人工判断": 0}
    queue_risk = []
    for it in items:
        level = org_view.readiness(it)
        rd[level] = rd.get(level, 0) + 1
        queue_risk.append(
            {
                "编号": it.get("编号", ""),
                "任务": it.get("任务", ""),
                "处置": level,
            }
        )
    queue_risk.sort(key=lambda x: (x["处置"] == "可直接建单", x["编号"]))

    ctx = {
        "rows": rows,
        "names": names,
        "sentences": sentences,
        "d_hits": d_hits,
        "cands": cands,
        "low": low,
        "orgs": orgs,
        "fields": fields,
        "readiness": rd,
        "queue_risk": queue_risk,
        "issues": issues,
        "asr": asr_info,
        "same_source": False,
    }

    os.makedirs(args.out, exist_ok=True)
    rp = os.path.join(args.out, "报告.md")
    with open(rp, "w", encoding="utf-8") as f:
        f.write(build_report(ctx))

    cp = os.path.join(args.out, "质检标注.csv")
    qmap = {h["编号"]: h for h in d_hits}
    with open(cp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["编号", "任务", "负责人", "截止时间", "字段状态", "依据结论", "负责人线索", "截止线索"])
        for row, fl in zip(rows, fields):
            q = qmap.get(row.get("编号", "")) or {}
            if not q.get("checkable", True):
                verdict = "不可检"
            else:
                verdict = "命中" if q.get("hit") else "不匹配"
            w.writerow(
                [
                    row.get("编号", ""),
                    row.get("任务", ""),
                    row.get("负责人", ""),
                    row.get("截止时间", ""),
                    fl["字段状态"],
                    verdict,
                    fl["负责人线索"],
                    fl["截止线索"],
                ]
            )

    checkable = sum(1 for h in d_hits if h.get("checkable", True))
    with open(os.path.join(args.out, "摘要.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "参会人": len(names),
                "句子": len(sentences),
                "待办": len(rows),
                "依据命中": sum(1 for h in d_hits if h.get("checkable", True) and h["hit"]),
                "依据可检": checkable,
                "依据不可检": len(d_hits) - checkable,
                "遗漏候选": len(cands),
                "低置信池": len(low),
                "机构主体": len(orgs),
                "可建单分档": rd,
                "输入体检": len(issues),
                "转写形态": asr_info["form"],
                "转写可检性": asr_info["verdict"],
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(build_report(ctx))
    print("\n产物：%s（报告.md / 质检标注.csv / 摘要.json）" % os.path.abspath(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())