# -*- coding: utf-8 -*-
"""wer.py —— 真实语音识别的字错率（CER）、句级正确率与关键信息召回

配套《真实语音准确率验证方案_v1.0.md》第 4.3 节。只做「识别层」度量，不下质检结论；
「错字会不会害结论」（A/B/C 归因、FPR_qc）仍走第 4.4 节的人工归因。

用法
----
    # 单段
    python wer.py --asr 段01.txt --gold 段01.gold.txt

    # 一段一段批量：目录下 段XX.gold.txt 与同名去掉 .gold 的稿子配对
    python wer.py --dir 语料/ --boot 1000 --json 结果.json --md 结果.md

    # 专名/数字召回：给人名清单（不给则从 gold 首行「参会人：」里取）
    python wer.py --asr a.txt --gold a.gold.txt --names 张岚,王睿

    # 自测（不读外部文件，内置 10 条断言，可在任何机器上验口径）
    python wer.py --selftest

输入与口径
----------
- ASR 稿：页面「实时转写」或工作台导出的 txt（行首 [mm:ss] 时间码 + 说话人前缀）。
- gold：人工逐字稿，一句一行；确实听不清的写 [听不清]。
- 归一化与 qc_tools.normalize_asr_text 同规则：去行首时间码、去说话人前缀、去标点、
  去空白。**唯一差别是占位符**：
    * 听不清 / 听不见 / 无法识别 / inaudible / unintelligible → 保留为标记 ¶，
      参与编辑距离（识别失败的显式信号，计入错误；洗掉它 CER 会变好看）。
    * 噪声 / 音乐 / 笑声 / 掌声 / 沉默 / 静音 / 重叠 → 两侧都移除（不是说话内容）。
  用 --no-ph 可退回「占位全部移除」的旧口径，此时与 qc_tools 逐字一致（脚本默认会
  用 --check-parity 自证这一点）。

指标
----
CER   = (S + D + I) / N_gold        字级编辑距离；分母是 gold 归一化后的字数
SA    句级正确率：按句对齐后，与 gold 完全一致的句数 / gold 句数
召回  关键信息召回：gold 里的数字串、人名串在 ASR 稿里还能找到的比例
CI    95% 区间：CER 用按段（cluster）bootstrap，SA 用 Wilson 区间
"""

import argparse
import json
import math
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    from array import array
except Exception:  # pragma: no cover
    array = None

# ---------------------------------------------------------------- 正则（与 qc_tools 同规则）

TS_RE = re.compile(r"^\s*[\[\(【]?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\]\)】]?\s*")
SPEAKER_RE = re.compile(r"^([^\s：:，。；]{1,12})[：:](.*)$")
PUNCT_ALL_RE = re.compile(r"[。！？；，、：,.!?;:]")

# 占位符：分成「算错误」与「不算内容」两类（qc_tools 的 PLACEHOLDER_RE 是两类合并）
ERR_PH_RE = re.compile(
    r"[\[\(（【]\s*(听不清|听不见|无法识别|unintelligible|inaudible)\s*[\]\)）】]", re.I)
DROP_PH_RE = re.compile(
    r"[\[\(（【]\s*(噪声|噪音|音乐|笑声|掌声|沉默|静音|重叠|noise|music|laughter|silence|overlap)\s*[\]\)）】]",
    re.I)

PH_MARK = "\u00b6"          # ¶ 占位标记，只用于对齐，不进入任何展示文本
NUM_RE = re.compile(r"\d+(?:[.:：]\d+)?%?")
NAMES_LINE_RE = re.compile(r"^\s*参会人\s*[：:]\s*(.+)$")

# 会议头信息：人工稿常有、ASR 导出常没有。两侧都跳过，否则「参会人：张岚、王睿」
# 会整整 6 个字被算成删除，CER 系统性虚高。--keep-meta 可关掉这个豁免。
META_LINE_RE = re.compile(
    r"^\s*(会议主题|主题|参会人|参会人员|列席|缺席|会议时间|会议地点|地点|"
    r"主持人|记录人|日期|会议纪要)\s*[：:]")
SKIP_META = True

MAX_CELLS = 4_000_000       # 超过这个 DP 规模就改用「按句对齐后累加」，避免几百 MB 与几十秒


# ---------------------------------------------------------------- 归一化


def norm_parts(text, keep_ph=True):
    """返回 (拼接文本, 逐句列表, 听不清占位数)。行结构保留给句级对齐用。"""
    lines = []
    ph = 0
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if SKIP_META and META_LINE_RE.match(line):
            continue
        m = TS_RE.match(line)
        if m:
            line = line[m.end():]
        m = SPEAKER_RE.match(line)
        if m:
            line = m.group(2)
        if keep_ph:
            def _keep(mm):
                nonlocal ph
                ph += 1
                return PH_MARK
            line = ERR_PH_RE.sub(_keep, line)
        else:
            line = ERR_PH_RE.sub("", line)
        line = DROP_PH_RE.sub("", line)
        line = PUNCT_ALL_RE.sub("", line)
        line = re.sub(r"\s+", "", line)
        if line:
            lines.append(line)
    return "".join(lines), lines, ph


# ---------------------------------------------------------------- 字级对齐


def align(a, b):
    """字级编辑距离，返回 S/D/I/dist/ok。用 1 维 int 数组存矩阵，回溯拆 S/D/I。"""
    n, m = len(a), len(b)
    if n == 0 and m == 0:
        return {"S": 0, "D": 0, "I": 0, "dist": 0, "ok": 0}
    if n == 0:
        return {"S": 0, "D": 0, "I": m, "dist": m, "ok": 0}
    if m == 0:
        return {"S": 0, "D": n, "I": 0, "dist": n, "ok": 0}

    W = m + 1
    d = array("i", [0]) * ((n + 1) * W)
    for i in range(n + 1):
        d[i * W] = i
    for j in range(m + 1):
        d[j] = j
    for i in range(1, n + 1):
        ai = a[i - 1]
        row = i * W
        prow = row - W
        for j in range(1, m + 1):
            v = d[prow + j - 1] + (0 if ai == b[j - 1] else 1)
            up = d[prow + j] + 1
            left = d[row + j - 1] + 1
            if up < v:
                v = up
            if left < v:
                v = left
            d[row + j] = v

    dist = d[n * W + m]
    S = D = I = ok = 0
    i, j = n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = 0 if a[i - 1] == b[j - 1] else 1
            if d[i * W + j] == d[(i - 1) * W + (j - 1)] + cost:
                if cost:
                    S += 1
                else:
                    ok += 1
                i -= 1
                j -= 1
                continue
        if i > 0 and d[i * W + j] == d[(i - 1) * W + j] + 1:
            D += 1
            i -= 1
            continue
        I += 1
        j -= 1
    return {"S": S, "D": D, "I": I, "dist": dist, "ok": ok}


def sent_align(g_lines, a_lines):
    """句级对齐：替换代价 = 1 - 相似度（difflib），删/插代价 = 1。

    返回 (配对的 (gi, ai) 列表, 未配对 gold 句, 未配对 ASR 句)。
    """
    import difflib

    n, m = len(g_lines), len(a_lines)
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        dp[i][0] = float(i)
    for j in range(m + 1):
        dp[0][j] = float(j)
    ratio = [[0.0] * m for _ in range(n)]
    for i in range(n):
        for j in range(m):
            ratio[i][j] = difflib.SequenceMatcher(None, g_lines[i], a_lines[j]).ratio()
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = min(dp[i - 1][j - 1] + (1.0 - ratio[i - 1][j - 1]),
                           dp[i - 1][j] + 1.0,
                           dp[i][j - 1] + 1.0)

    pairs, ug, ua = [], [], []
    i, j = n, m
    while i > 0 and j > 0:
        if abs(dp[i][j] - (dp[i - 1][j - 1] + (1.0 - ratio[i - 1][j - 1]))) < 1e-9:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif abs(dp[i][j] - (dp[i - 1][j] + 1.0)) < 1e-9:
            ug.append(i - 1)
            i -= 1
        else:
            ua.append(j - 1)
            j -= 1
    while i > 0:
        ug.append(i - 1)
        i -= 1
    while j > 0:
        ua.append(j - 1)
        j -= 1
    pairs.reverse()
    ug.reverse()
    ua.reverse()
    return pairs, ug, ua


# ---------------------------------------------------------------- 打分


def parse_names(text, given=None):
    if given:
        return [x.strip() for x in re.split(r"[，,、\s]+", given) if x.strip()]
    for line in (text or "").splitlines()[:3]:
        m = NAMES_LINE_RE.match(line)
        if m:
            return [x.strip() for x in re.split(r"[，,、\s]+", m.group(1)) if x.strip()]
    return []


def recall_of(gold_text, asr_text, names):
    """关键信息召回：gold 中出现的数字串与人名，在 ASR 归一化文本里还能找到的比例。"""
    gj, _, _ = norm_parts(gold_text)
    aj, _, _ = norm_parts(asr_text)
    nums = NUM_RE.findall(gj)
    num_hit = sum(1 for t in nums if t in aj)
    per_total = [n for n in names for _ in range(gj.count(n))] if names else []
    per_hit = [n for n in per_total if n in aj]
    return {
        "num_total": len(nums), "num_hit": num_hit,
        "num_recall": (num_hit / len(nums)) if nums else None,
        "per_total": len(per_total), "per_hit": len(per_hit),
        "per_recall": (len(per_hit) / len(per_total)) if per_total else None,
    }


def score_case(name, asr_text, gold_text, names=None, keep_ph=True, meta=None):
    init_globals = globals().get("SKIP_META", True)
    meta_lines = 0
    if init_globals:
        meta_lines = sum(1 for l in (gold_text or "").splitlines() if META_LINE_RE.match(l.strip()))
    gj, g_lines, g_ph = norm_parts(gold_text, keep_ph=keep_ph)
    aj, a_lines, a_ph = norm_parts(asr_text, keep_ph=keep_ph)
    pairs, ug, ua = sent_align(g_lines, a_lines)

    method = "full"
    if len(gj) * len(aj) <= MAX_CELLS:
        r = align(gj, aj)
    else:
        # 规模太大：按对齐好的句子逐对累加，再补未配对句（与整体口径可解释、可比较）
        method = "segmented"
        r = {"S": 0, "D": 0, "I": 0, "dist": 0, "ok": 0}
        for gi, ai in pairs:
            x = align(g_lines[gi], a_lines[ai])
            for k in ("S", "D", "I", "dist", "ok"):
                r[k] += x[k]
        r["D"] += sum(len(g_lines[i]) for i in ug)
        r["I"] += sum(len(a_lines[j]) for j in ua)
        r["dist"] = r["S"] + r["D"] + r["I"]

    sent_ok = sum(1 for gi, ai in pairs if g_lines[gi] == a_lines[ai])
    out = {
        "case": name,
        "method": method,
        "gold_chars": len(gj),
        "asr_chars": len(aj),
        "gold_sents": len(g_lines),
        "asr_sents": len(a_lines),
        "S": r["S"], "D": r["D"], "I": r["I"],
        "dist": r["dist"],
        "cer": (r["dist"] / len(gj)) if gj else None,
        "sent_ok": sent_ok,
        "sa": (sent_ok / len(g_lines)) if g_lines else None,
        "sent_unmatched_gold": len(ug),
        "sent_unmatched_asr": len(ua),
        "ph_gold": g_ph, "ph_asr": a_ph,
        "meta_lines": meta_lines,
    }
    out.update(recall_of(gold_text, asr_text, names))
    if meta:
        out.update(meta)
    return out


def wilson(k, n, z=1.96):
    if not n:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (round(max(0.0, c - h), 4), round(min(1.0, c + h), 4))


def boot_ci(cases, B=1000):
    """按段（cluster）bootstrap：同一段内句子误差相关，按句重采样会低估区间。"""
    usable = [c for c in cases if c.get("gold_chars")]
    if len(usable) < 2:
        return None
    import random
    rnd = random.Random(20261127)
    vals = []
    for _ in range(max(1, B)):
        dist = chars = 0
        for _ in range(len(usable)):
            c = usable[rnd.randrange(len(usable))]
            dist += c["dist"]
            chars += c["gold_chars"]
        if chars:
            vals.append(dist / chars)
    vals.sort()
    if not vals:
        return None
    lo = vals[int(0.025 * (len(vals) - 1))]
    hi = vals[int(0.975 * (len(vals) - 1))]
    return {"n_cases": len(usable), "B": B, "lo": round(lo, 4), "hi": round(hi, 4),
            "p50": round(vals[len(vals) // 2], 4)}


# ---------------------------------------------------------------- 口径自证


def check_parity():
    """内置归一化（占位全部移除）应与 qc_tools.normalize_asr_text 逐字一致。"""
    try:
        import qc_tools as Q
    except Exception as e:
        return {"ok": None, "why": "qc_tools 不可导入（%s）" % e}
    sample = ("[00:01:23] 张岚：这周先把首页改版做出来，周五之前给我看一眼。\n"
              "王睿：好[听不清]我今晚开始弄")
    mine = norm_parts(sample, keep_ph=False)[0]
    theirs = re.sub(r"\s+", "", Q.normalize_asr_text(sample))
    return {"ok": mine == theirs, "mine": mine, "theirs": theirs}


# ---------------------------------------------------------------- 自测


def selftest():
    ok = 0
    fail = []

    def chk(tag, cond, got=None):
        nonlocal ok
        if cond:
            ok += 1
        else:
            fail.append("%s → %r" % (tag, got))

    g = "今天我们开会"
    chk("相等", align(g, g)["dist"] == 0, align(g, g))
    r = align(g, "今天我们开回")
    chk("1 替换", (r["S"], r["D"], r["I"], r["dist"]) == (1, 0, 0, 1), r)
    # 插入/删除按「字」计：插一个「我们」是 2 个字符、2 次插入，不是 1 处
    r = align("今天开会", "今天要开会")
    chk("插入 1 字", (r["S"], r["D"], r["I"], r["dist"]) == (0, 0, 1, 1), r)
    r = align("今天开会", "今天我们开会")
    chk("插入 2 字", (r["S"], r["D"], r["I"], r["dist"]) == (0, 0, 2, 2), r)
    r = align("今天我们开会", "今天开会")
    chk("删除 2 字", (r["S"], r["D"], r["I"], r["dist"]) == (0, 2, 0, 2), r)

    c = score_case("去噪", "[00:01:23] 张岚：这周先把首页改版做出来，周五之前给我看一眼。",
                   "张岚：这周先把首页改版做出来。周五之前给我看一眼。")
    chk("时间码/说话人/标点被去噪", c["dist"] == 0 and c["cer"] == 0.0, c["dist"])

    c = score_case("听不清", "下周三[听不清]场地", "下周三锁定场地")
    chk("听不清计入错误（1 替换 + 1 删除）", c["dist"] == 2 and c["ph_asr"] == 1, c)

    c = score_case("重叠", "先不展开[重叠]", "先不展开")
    chk("重叠不算错误", c["dist"] == 0, c["dist"])
    c = score_case("重叠两侧", "[重叠]先不展开", "先不展开[重叠]")
    chk("重叠两侧都忽略", c["dist"] == 0, c["dist"])

    # 句按行切：一句一行是输入约定，挤在一行会被当成一句
    c = score_case("句准", "张岚：这周做改版。\n王睿：好。",
                   "张岚：这周做改版。\n王睿：好的。")
    chk("句准 1/2", c["sa"] == 0.5 and c["sent_ok"] == 1, (c["sa"], c["sent_ok"], c["gold_sents"]))

    c = score_case("空段", "任意", "")
    chk("gold 为空不崩", c["cer"] is None and c["sa"] is None, c["cer"])

    global SKIP_META
    _save = SKIP_META
    SKIP_META = True
    c = score_case("头信息", "张岚：这周做改版。",
                   "参会人：张岚、王睿\n会议主题：Q3 周会\n张岚：这周做改版。", names=["张岚"])
    chk("会议头信息行两侧跳过", c["dist"] == 0 and c["meta_lines"] == 2, (c["dist"], c["meta_lines"]))
    SKIP_META = False
    c = score_case("头信息不跳", "张岚：这周做改版。", "参会人：张岚、王睿\n张岚：这周做改版。")
    chk("--keep-meta 时不再豁免", c["dist"] > 0, c["dist"])
    SKIP_META = _save

    # 召回只问「还在不在」，不是编辑距离：ASR 丢了数字，人名还在
    c = score_case("召回", "评审会见张岚", "评审会见张岚，定 9 月 12 日交 3.5 万",
                   names=["张岚"])
    chk("人名召回 1/1", c["per_hit"] == 1 and c["per_total"] == 1, (c["per_hit"], c["per_total"]))
    chk("数字有缺（3 项丢光）", c["num_hit"] == 0 and c["num_total"] == 3,
        (c["num_hit"], c["num_total"]))

    p = check_parity()
    if p["ok"] is None:
        print("  口径对账：跳过（%s）" % p["why"])
    else:
        chk("与 qc_tools 归一化一致", p["ok"] is True, p)

    print("自测：%d 项通过，%d 项失败" % (ok, len(fail)))
    for f in fail:
        print("  FAIL %s" % f)
    return 0 if not fail else 1


# ---------------------------------------------------------------- 输出


def fmt(v, nd=2):
    if v is None:
        return "—"
    if isinstance(v, float):
        return ("%." + str(nd) + "f") % v
    return str(v)


def pct(v, nd=1):
    if v is None:
        return "—"
    return ("%." + str(nd) + "f%%") % (v * 100)


def disp_w(s):
    """终端显示宽度：CJK 与全角记 2 列，否则中文列会歪。"""
    return sum(2 if ord(ch) > 0x2E80 else 1 for ch in s)


def pad(s, width):
    return s + " " * max(0, width - disp_w(s))


def render_console(cases, summary):
    head = ("段", "句", "gold字", "S", "D", "I", "CER", "句准")
    rows = []
    for c in cases:
        rows.append((c.get("case", "?"), fmt(c.get("gold_sents")), fmt(c.get("gold_chars")),
                     fmt(c.get("S")), fmt(c.get("D")), fmt(c.get("I")),
                     pct(c.get("cer")), pct(c.get("sa"))))
    widths = [max([disp_w(head[i])] + [disp_w(r[i]) for r in rows]) for i in range(len(head))]
    line = "  ".join(pad(head[i], widths[i]) for i in range(len(head)))
    print(line)
    print("-" * disp_w(line))
    for r in rows:
        print("  ".join(pad(r[i], widths[i]) for i in range(len(head))))
    print()
    s = summary
    print("合计：gold %d 字 / %d 句；S %d、D %d、I %d"
          % (s["gold_chars"], s["gold_sents"], s["S"], s["D"], s["I"]))
    print("CER %s%s；句准 %s%s"
          % (pct(s["cer"]), ("  [%s, %s]" % (pct(s["cer_ci"]["lo"]), pct(s["cer_ci"]["hi"]))
                             if s.get("cer_ci") else "  （单段不给区间）"),
             pct(s["sa"]), ("  [%s, %s]" % (pct(s["sa_ci"][0]), pct(s["sa_ci"][1]))
                            if s.get("sa_ci") and s["sa_ci"][0] is not None else "")))
    if s.get("num_recall") is not None:
        print("关键信息召回：数字 %s、人名 %s"
              % (pct(s["num_recall"]), pct(s.get("per_recall"))))
    if s.get("tier"):
        print("档位：%s —— %s" % (s["tier"], s["tier_note"]))


def tier_of(cer, cases):
    """只看识别层能给的档位；质检层（FPR_qc）要人工归因后才有，不在这里猜。"""
    if cer is None:
        return None, None
    if cer <= 0.10:
        return "绿（识别层达线）", "CER ≤10%：识别层可宣称，仍需 FPR_qc 才能定最终档"
    if cer <= 0.20:
        return "黄（识别层需校对）", "10%<CER≤20%：默认开去噪，注明识别误差可能进入判定"
    return "红（识别层不达标）", "CER>20%：不宣称支持语音输入，识别稿需人工校对"


def write_md(path, cases, summary):
    lines = ["# 真实语音识别验证结果（wer.py 生成）", ""]
    lines.append("| 段 | 场景 | 设备 | 时长 | 句数 | gold 字数 | S | D | I | CER | 句准 | 备注 |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for c in cases:
        note = c.get("method", "full")
        if c.get("ph_asr"):
            note += "；ASR 占位 %d 处" % c["ph_asr"]
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |"
                     % (c.get("case", "?"), c.get("scene", "—"), c.get("device", "—"),
                        c.get("dur", "—"), fmt(c.get("gold_sents")), fmt(c.get("gold_chars")),
                        c.get("S"), c.get("D"), c.get("I"),
                        pct(c.get("cer")), pct(c.get("sa")), note))
    lines.append("")
    lines.append("## 汇总")
    lines.append("")
    lines.append("- CER **%s**%s" % (pct(summary["cer"]),
                                     ("（95%% bootstrap 按段 [%s, %s]，B=%d）"
                                      % (pct(summary["cer_ci"]["lo"]), pct(summary["cer_ci"]["hi"]),
                                         summary["cer_ci"]["B"])) if summary.get("cer_ci") else ""))
    if summary.get("sa_ci") and summary["sa_ci"][0] is not None:
        lines.append("- 句准 **%s**（Wilson 95%% [%s, %s]）"
                     % (pct(summary["sa"]), pct(summary["sa_ci"][0]), pct(summary["sa_ci"][1])))
    else:
        lines.append("- 句准 **%s**" % pct(summary["sa"]))
    lines.append("- 分母口径：gold 归一化后 %d 字 / %d 句；S %d、D %d、I %d"
                 % (summary["gold_chars"], summary["gold_sents"], summary["S"], summary["D"], summary["I"]))
    if summary.get("num_recall") is not None:
        lines.append("- 关键信息召回：数字 %s（%d/%d）、人名 %s（%d/%d）"
                     % (pct(summary["num_recall"]), summary["num_hit"], summary["num_total"],
                        pct(summary.get("per_recall")), summary.get("per_hit", 0),
                        summary.get("per_total", 0)))
    if summary.get("tier"):
        lines.append("- 档位：**%s** —— %s" % (summary["tier"], summary["tier_note"]))
    lines.append("")
    lines.append("> 口径：归一化去时间码/说话人/标点/空白；`[听不清]` 类占位计入错误（标记 ¶），"
                 "`[重叠]`/噪声/笑声等两侧移除。数字与人名召回只算「是否还在」，不是编辑距离。"
                 "本文件只覆盖识别层，`FPR_qc` 需按方案 4.4 节人工归因后另报。")
    open(path, "w", encoding="utf-8", newline="\n").write("\n".join(lines) + "\n")


# ---------------------------------------------------------------- 主流程


def collect(args):
    jobs = []
    if args.asr or args.gold:
        if not (args.asr and args.gold):
            raise SystemExit("--asr 与 --gold 要成对给")
        jobs.append((os.path.basename(args.gold).replace(".gold.txt", "").replace(".gold", ""),
                     args.asr, args.gold))
    elif args.dir:
        for fn in sorted(os.listdir(args.dir)):
            if not fn.endswith(".gold.txt"):
                continue
            gold = os.path.join(args.dir, fn)
            asr = gold[: -len(".gold.txt")] + ".txt"
            if not os.path.exists(asr):
                print("跳过 %s：找不到同名 ASR 稿 %s" % (gold, os.path.basename(asr)))
                continue
            jobs.append((fn[: -len(".gold.txt")], asr, gold))
    else:
        raise SystemExit(__doc__)
    return jobs


def meta_of(case):
    parts = case.split("_")
    out = {}
    if len(parts) >= 2:
        out["scene"] = parts[1]
    if len(parts) >= 3:
        out["device"] = parts[2]
    return out


def main():
    ap = argparse.ArgumentParser(add_help=True, description="CER / 句准 / 关键信息召回打分器")
    ap.add_argument("--asr", help="ASR 稿（页面导出）")
    ap.add_argument("--gold", help="人工逐字稿")
    ap.add_argument("--dir", help="批量目录：按 *.gold.txt 与同名 .txt 配对")
    ap.add_argument("--names", help="人名清单，逗号分隔；不给则读 gold 首行「参会人：」")
    ap.add_argument("--json", dest="json_out", help="结构化结果输出路径")
    ap.add_argument("--md", dest="md_out", help="按方案报告模板输出 Markdown")
    ap.add_argument("--boot", type=int, default=1000, help="bootstrap 次数，0 表示不算")
    ap.add_argument("--no-ph", action="store_true", help="占位全部移除（与 qc_tools 完全一致的口径）")
    ap.add_argument("--keep-meta", action="store_true",
                    help="不跳过「参会人／会议主题」等头信息行（默认两侧都跳过）")
    ap.add_argument("--check-parity", action="store_true", help="只做归一化口径对账后退出")
    ap.add_argument("--selftest", action="store_true", help="跑内置自测断言（不读外部文件）")
    args = ap.parse_args()

    global SKIP_META
    SKIP_META = not args.keep_meta

    if args.selftest:
        sys.exit(selftest())

    if args.check_parity:
        p = check_parity()
        if p["ok"] is None:
            print("跳过：%s" % p["why"])
            sys.exit(0)
        print("口径对账：%s" % ("一致" if p["ok"] else "不一致"))
        if not p["ok"]:
            print("  内置：%s" % p["mine"])
            print("  qc_tools：%s" % p["theirs"])
        sys.exit(0 if p["ok"] else 1)

    keep_ph = not args.no_ph
    jobs = collect(args)
    if not jobs:
        raise SystemExit("没有可打分的段")

    cases = []
    for case, asr, gold in jobs:
        with open(asr, encoding="utf-8", errors="replace") as f:
            asr_text = f.read()
        with open(gold, encoding="utf-8", errors="replace") as f:
            gold_text = f.read()
        names = parse_names(gold_text, args.names)
        meta = meta_of(case)
        c = score_case(case, asr_text, gold_text, names=names, keep_ph=keep_ph, meta=meta)
        c["asr_file"] = asr
        c["gold_file"] = gold
        cases.append(c)

    tot_dist = sum(c["dist"] for c in cases)
    tot_chars = sum(c["gold_chars"] for c in cases)
    tot_g = sum(c["gold_sents"] for c in cases)
    tot_ok = sum(c["sent_ok"] for c in cases)
    num_total = sum(c["num_total"] for c in cases)
    num_hit = sum(c["num_hit"] for c in cases)
    per_total = sum(c["per_total"] for c in cases)
    per_hit = sum(c["per_hit"] for c in cases)

    summary = {
        "cases": len(cases),
        "gold_chars": tot_chars, "gold_sents": tot_g,
        "S": sum(c["S"] for c in cases), "D": sum(c["D"] for c in cases),
        "I": sum(c["I"] for c in cases), "dist": tot_dist,
        "cer": (tot_dist / tot_chars) if tot_chars else None,
        "sent_ok": tot_ok, "sa": (tot_ok / tot_g) if tot_g else None,
        "sa_ci": wilson(tot_ok, tot_g),
        "num_total": num_total, "num_hit": num_hit,
        "num_recall": (num_hit / num_total) if num_total else None,
        "per_total": per_total, "per_hit": per_hit,
        "per_recall": (per_hit / per_total) if per_total else None,
    }
    if args.boot and len(cases) >= 2:
        summary["cer_ci"] = boot_ci(cases, args.boot)
    t, note = tier_of(summary["cer"], cases)
    summary["tier"], summary["tier_note"] = t, note

    print("段数 %d｜占位口径：%s｜归一化：时间码/说话人/标点/空白（与 qc_tools 同规则）"
          % (len(cases), "占位计入错误" if keep_ph else "占位全部移除"))
    print()
    render_console(cases, summary)

    if args.json_out:
        payload = {"summary": summary, "cases": cases,
                   "parity": check_parity()["ok"]}
        open(args.json_out, "w", encoding="utf-8", newline="\n").write(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        print("\nJSON → %s" % args.json_out)
    if args.md_out:
        write_md(args.md_out, cases, summary)
        print("Markdown → %s" % args.md_out)


if __name__ == "__main__":
    main()