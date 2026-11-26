# -*- coding: utf-8 -*-
"""asr_lab.py —— 录音识别稿（ASR）对照实验

把已有的人工整理转录，按真实 ASR 导出形态改写（逐句一行、行首时间码、无句末
标点、夹 [听不清] 占位、可去掉“参会人：”行），再跑同一套质检，看两件事：

1. 形态检测能不能认出来（detect_asr 的 form / verdict）；
2. 引擎在“不归一化 / 归一化”两种模式下的检出差异，证明归一化修的是格式噪声、
   不是把不匹配洗成匹配。

产物：
  samples/会议转录_示例_ASR模拟稿.txt      —— 带参会人行的 ASR 稿（V1/V2 基线）
  samples/会议转录_示例_ASR模拟稿_无名单.txt —— 真实导出常见的无“参会人：”版本（V3）
  录音转写对照实验.md                      —— 对照结果表（供演示页与文档引用）

用法：
  python asr_lab.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "agent-src", "meeting-todo-qc", "skills", "meeting-todo-qc", "scripts")
sys.path.insert(0, SCRIPTS)

import qc_tools as Q          # noqa: E402
import org_view               # noqa: E402
import qc as QC               # noqa: E402

SRC_T = os.path.join(HERE, "会议转录_产品运营周会_示例.txt")
SRC_ROWS = os.path.join(HERE, "会议待办_修正版_v1.1.csv")
OUT_DIR = os.path.join(HERE, "samples")
OUT_V1 = os.path.join(OUT_DIR, "会议转录_示例_ASR模拟稿.txt")
OUT_V3 = os.path.join(OUT_DIR, "会议转录_示例_ASR模拟稿_无名单.txt")
OUT_MD = os.path.join(HERE, "录音转写对照实验.md")

PLACE_AT = {4, 11, 19}   # 第 N 句（从 0 计）挂“听不清”占位


def make_asr(raw, keep_roster=True, with_placeholder=True):
    """把人工稿改写成 ASR 形态：逐句一行 + 行首时间码 + 无句末标点。"""
    lines, name_lines, seq = [], [], 0
    for line in raw.splitlines():
        text = line.strip()
        if not text:
            continue
        if re.match(r"^参会人[：:]", text):
            name_lines.append(text)
            continue
        m = re.match(r"^([\u4e00-\u9fa5]{1,4})[：:](.*)$", text)
        if not m:
            continue
        sp, rest = m.group(1), m.group(2).strip()
        for sent in [s.strip() for s in re.split(r"(?<=[。！？；])", rest) if s.strip()]:
            sent = re.sub(r"[。！？；]+$", "", sent)
            mm, ss = divmod(seq * 8 + 12, 60)
            stamp = "[%02d:%02d:%02d]" % (divmod(mm, 60)[0], mm % 60, ss)
            if with_placeholder and seq in PLACE_AT:
                sent = sent + " [听不清]"
            lines.append("%s %s：%s" % (stamp, sp, sent))
            seq += 1
    head = name_lines if keep_roster else []
    return "\n".join(head + lines) + "\n", seq


def run(raw, rows, strict=False):
    names, body = Q.parse_transcript(None, raw=raw)
    sentences = Q.build_sentences(body)
    hits = Q.check_quotes(rows, raw, normalize=not strict)
    checkable = [h for h in hits if h.get("checkable", True)]
    ok = [h for h in checkable if h["hit"]]
    cands, low, orgs = Q.slice_scan(names, sentences, rows)
    items = org_view.build_items(rows, names, raw)
    rd = {"可直接建单": 0, "需补字段": 0, "待人工判断": 0}
    for it in items:
        rd[org_view.readiness(it)] = rd.get(org_view.readiness(it), 0) + 1
    return {
        "names": names, "sentences": sentences, "hit": len(ok), "checkable": len(checkable),
        "cands": len(cands), "low": len(low), "orgs": len(orgs),
        "rd": "%d/%d/%d" % (rd["可直接建单"], rd["需补字段"], rd["待人工判断"]),
        "miss": [h["编号"] for h in checkable if not h["hit"]],
    }


def load_rows(path):
    import csv
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def main():
    raw0 = open(SRC_T, encoding="utf-8").read()
    rows = load_rows(SRC_ROWS)
    asr1, n1 = make_asr(raw0, keep_roster=True, with_placeholder=False)
    asr2, _ = make_asr(raw0, keep_roster=True, with_placeholder=True)
    asr3, _ = make_asr(raw0, keep_roster=False, with_placeholder=True)

    os.makedirs(OUT_DIR, exist_ok=True)
    open(OUT_V1, "w", encoding="utf-8", newline="\n").write(asr2)
    open(OUT_V3, "w", encoding="utf-8", newline="\n").write(asr3)

    cases = [
        ("人工整理稿（基线）", raw0),
        ("ASR 稿 · 有时间码", asr1),
        ("ASR 稿 · 时间码 + 听不清", asr2),
        ("ASR 稿 · 无参会人行", asr3),
    ]

    md = ["# 录音识别稿对照实验\n",
          "把同一份人工整理转录改写成录音识别（ASR）常见形态，跑同一套质检，",
          "观察形态检测与归一化各自修掉了什么。所有数字由 `asr_lab.py` 实跑生成。\n",
          "| 变体 | 形态判定 | 说话人 | 句子 | 依据·归一化 | 依据·严格 | 候选 | 三档 |",
          "|---|---|---|---|---|---|---|---|"]

    print("=" * 96)
    for name, raw in cases:
        d = Q.detect_asr(raw)
        rn = run(raw, rows, strict=False)
        rs = run(raw, rows, strict=True)
        pf = QC.preflight(raw, rows, rn["names"], rn["sentences"])
        blk = sum(1 for x in pf if x["level"] == "block")
        mdl = sum(1 for x in pf if x["level"] == "warn")
        print(f"[{name}]")
        print(f"  detect: form={d['form']} is_asr={d['is_asr']} verdict={d['verdict']} "
              f"ts={d['ts_ratio']:.0%} spk={d['speaker_ratio']:.0%} "
              f"punctless={d['punctless_ratio']:.0%} ph={d['placeholder']}")
        print(f"  names={len(rn['names'])} sentence={len(rn['sentences'])} "
              f"D(归一化)={rn['hit']}/{rn['checkable']} D(严格)={rs['hit']}/{rs['checkable']} "
              f"候选={rn['cands']} 三档={rn['rd']} 体检=阻断{blk}/提示{mdl}")
        print(f"  严格模式不匹配条目：{rs['miss']}")
        md.append("| %s | %s / %s | %d | %d | %d/%d | %d/%d | %d | %s |" % (
            name, d["form"], d["verdict"], len(rn["names"]), len(rn["sentences"]),
            rn["hit"], rn["checkable"], rs["hit"], rs["checkable"], rn["cands"], rn["rd"]))
        print()

    md += ["", "说明：", "",
           "- “严格”= 关闭全部归一化，原样比对，代表直接拿 ASR 原文回查依据。",
           "- “归一化”= 去掉时间码、说话人前缀、识别占位与标点后再比对；只去格式，不改用词。",
           "- 同音错字不会被归一化修掉——它会让对应条目继续不匹配，这是识别误差的正确暴露。",
           "- 本实验是把人工稿改写成 ASR 形态，用于验证引擎行为，不代表真实录音的识别准确率。", ""]
    with open(OUT_MD, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(md))
    print("已写：", OUT_MD)
    print("已写：", OUT_V1)
    print("已写：", OUT_V3)


if __name__ == "__main__":
    main()