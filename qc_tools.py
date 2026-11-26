#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会议待办质检辅助工具 v1.5

设计原则：只做机器能给出硬证据的部分，不假装能判断语义。
三个通道，分别对应质检的 D / A / B 维度：

  1) check_quotes   D 维度：原文依据是否在转录中逐字存在（字符串匹配，硬结论）
  2) slice_scan     A 维度：按人切片 + 规则扫描，只输出“候选”，不下“遗漏”结论
  3) soft 标记      B 维度辅助：标出含软要求词的句子，供人工/模型判断

v1.5 修正（输入容错，2026-11-26）：
  - check_quotes 增加空白归一化（默认开 normalize=True）：从 Word/微信复制的转录常夹
    全角空格或不换行空格，严格逐字会把整表判成“不匹配”，看起来像工具坏了。
    归一化只去空白，不放宽到同义词、不改标点。
  - 依据为空（缺列或空串）不再算“不匹配”，单独标 checkable=False，不进命中率分母。
  - 既有四组结果经复核零变化：示例 14/14、第 2 组 8/9、第 4 组 9/9 与 10/10。
  - 调用方拿到 hit 时须同时看 checkable：checkable=False 表示“无法检查”，不是“检查失败”。

v1.4 修正（对照第 4 组 v1.3 的沉默型漏检：同句两动作被覆盖判断吸收）：
  - 覆盖判断改用「任务」列（不含约束列）的动作词做否决：任务含成果类动词
    （制作/公布/起草/交付…）、候选句一个动作词都不共享 → 判“不是同一件事”，
    不再算覆盖。此前“制作第二批素材”把同句的“在群里公布日期”吞掉了。
  - 否决只在任务列含 ACTION_EXTRA 成果动词时启用，泛动词（对/补/盯/查）
    在同一件事的不同句里常见，用它们否决会误伤已覆盖项。
  - 任一侧抽不出动作词时退回原二 gram 逻辑。
  - 句级规则⑤主持人复述句（三人以上 + 长句，动作词稀疏，靠形态判）。
  - 句级规则⑥回溯疑问句（“乙你之前是不是整理过一个版本？”——问过去，不派活）。
  - 效果：第 4 组候选 0 → 1（召回 1/1，但同句多人时人物按句级判，要人工改判）；
    示例 4 条、第 2 组 0 条 + 4 机构主体，三组基线均未动。

v1.3 修正（对照第 4 组真实内部会议：单字代称脱敏）：
  - 说话人标签正则由 2–4 字放宽为 1–4 字。此前“甲：/乙：”这类单字代称
    完全不匹配，切句得 0 条、A 通道静默失效，而 D 通道照常输出 9/9——
    最危险的是它不报错，还看起来正常。
  - 名单校验保留（名字须出现在“参会人：”行内），避免“说明：/主持：”
    等元信息行被误认成发言。

v1.2 修正（对照第 2 组公开实录的 5 条误报）：
  - 规则①程序性动词句（邀请/出席/介绍/回答/讲到）整句排除
  - 规则②两个以上人名 + 冒号引出的名单句整句排除
  - 规则③责任落在机构（财政部/我们/相关部门）时单列“机构主体清单”，
    用“机构（个人待确认）”占位，不进入候选表、不计精确率

v1.1 修正（对照 v1.0 首轮 17 条候选的噪声）：
  - 参会人解析不再按中文逗号切分，避免把职务括号切碎
  - “给我 / 发你 / 抄送某某”视为接收方，不再被当作责任人
  - “我来发”一类承接句并入上一句，责任人记为本句说话人
  - “X 牵头 …… Y 配合”只核配合方，牵头方视为管理角色不重复计
  - 覆盖判断引入上一句上下文，避免把“你去谈”这类指示句误报
  - 低置信候选单列，不进入候选表

用法：
  python qc_tools.py 转录.txt --demo
  python qc_tools.py 转录.txt --table 生成版.csv

表格 CSV 列：编号,任务,负责人,截止时间,约束,原文依据
"""

import csv
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ---------------------------------------------------------------- 词典

VERBS = [
    "修", "做", "出", "拉", "拿", "发", "对", "谈", "确认", "整理", "补齐", "统一",
    "安排", "写", "跟进", "联系", "准备", "提测", "上线", "锁", "催", "排", "复盘",
    "评估", "对齐", "盯", "查", "挪", "落实", "推进", "补", "打", "电话",
]

WEAK_VERBS = ["记", "说", "想", "觉得", "怀疑", "看", "讨论"]

TIME_RE = re.compile(
    r"(下周[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]前"
    r"|下个月\s*\d+\s*[号日]?|\d+\s*月\s*第?[一二三四]?周|\d+\s*月\s*\d+\s*[日号]"
    r"|今天|明天|后天|月底|月底前|下月初|评审会前|上线前|会前)"
)

SOFT_RE = re.compile(r"(建议|可以考虑|可以|要不|最好|我觉得|要不要|是不是|如果|先不)")

ACK_RE = re.compile(r"^(好|对|行|可以|明白|嗯|收到|没问题)")

LEADER_RE = r"[^，。；]{0,4}(牵头|负责|主导)"

# v1.2 三条排除规则用到的词典
PROCEDURAL_RE = re.compile(r"(邀请|出席|参加|介绍|回答|讲到|提到|感谢|欢迎|主持)")
ROLLCALL_RE = re.compile(r"(还有|的有|出席|参加|邀请)[：:]")
ASSIGN_AFTER_NAME = r"[^，。；]{0,6}(做|出|写|发|整理|确认|准备|跟进|补齐|统一|落实|推进|完成)"
ORG_RE = re.compile(r"(财政部|我部|我们|有关部门|相关部门|各部门|各部委)")
ORG_COMMIT_RE = re.compile(
    r"(必须|确保|务必|完成|落实|下达|出台|印发|建立|推动|加快|抓好|做好"
    r"|研究|推进|发行|统一|扩大|完善)"
)
PAST_RE = re.compile(r"(今年以来|近年来|近几年|去年|过去|此前|已经|曾经|早前|原来)")


def strip_recipients(text):
    """去掉“给我”“发你”“抄送赵敏”这类接收方，避免把收件人当责任人。"""
    t = text.replace("给我们", "").replace("给我", "")
    t = re.sub(r"(发|给|抄送|报给|通知|告诉|回复)(你|您)", "", t)
    t = re.sub(r"抄送[\u4e00-\u9fa5]{2,3}", "", t)
    return t


# ---------------------------------------------------------------- 录音转写稿（ASR）适配


# 行首时间码：00:01:23 / 01:23 / [00:01:23.450] / (00:01:23)
TS_RE = re.compile(r"^\s*[\[\(【]?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\]\)】]?\s*")
# ASR 非语言占位：听不清、噪音、笑声…… 中英双语
PLACEHOLDER_RE = re.compile(
    r"[\[\(（【]\s*(听不清|听不见|无法识别|噪声|噪音|音乐|笑声|掌声|沉默|静音|重叠|"
    r"unintelligible|inaudible|noise|music|laughter|silence|overlap)\s*[\]\)）】]", re.I)
# 自动编号说话人：说话人1 / Speaker 2 —— 不是真名，不能拿来按人切片
SPEAKER_NUM_RE = re.compile(r"^(说话人|发言人|嘉宾|speaker|spk)[\s_]*\d{1,2}$", re.I)
PUNCT_RE = re.compile(r"[。！？；]")
ASR_ENUM_HEADS = ("说话人", "发言人", "嘉宾")


def detect_asr(raw):
    """判断这段文字是不是录音识别（ASR）产出的转写稿，并给出可机械核对的指标。

    只做形态判断，不评价识别准确率——没有参考文本，“错字率”不可测。能测的是
    “这段稿子还能不能被质检”：有没有说话人、有没有时间码、有没有把一句压成
    几百字、有没有 [听不清] 这类占位。
    """
    lines = [l.strip() for l in (raw or "").splitlines() if l.strip()]
    total = len(lines)
    if not total:
        return {"form": "empty", "is_asr": False, "lines": 0, "ts_lines": 0,
                "speaker_lines": 0, "placeholder": 0, "punctless_long": 0,
                "ts_ratio": 0.0, "speaker_ratio": 0.0, "punctless_ratio": 0.0,
                "verdict": "unusable", "notes": ["输入为空。"]}

    ts_lines = speaker_lines = punctless = 0
    for line in lines:
        m_ts = TS_RE.match(line)
        if m_ts:
            ts_lines += 1
            line = line[m_ts.end():]
        head = re.match(r"^([^\s：:，。；]{1,12})[：:](.*)$", line)
        if head:
            speaker_lines += 1
            line = head.group(2)
        body = line.strip()
        if len(body) >= 30 and not PUNCT_RE.search(body) and not re.search(r"[，、]", body):
            punctless += 1

    ph = len(PLACEHOLDER_RE.findall(raw or ""))
    ts_ratio = ts_lines / total
    sp_ratio = speaker_lines / total
    pl_ratio = punctless / total

    is_asr = bool(ts_lines or ph or pl_ratio >= 0.3)
    if ts_lines and speaker_lines:
        form = "timestamp+speaker"
    elif speaker_lines:
        form = "speaker"
    elif ts_lines:
        form = "timestamp"
    else:
        form = "plain"

    notes = []
    if is_asr and not speaker_lines:
        notes.append("没有说话人标记：按人切片的遗漏检查无法执行，只能跑依据回查与字段核查。")
    if is_asr and pl_ratio >= 0.3:
        notes.append("有 %d 行是无标点长句：按标点切句会失效，需按时间码或长度切。" % punctless)
    if ph:
        notes.append("含 %d 处识别占位（“听不清”“笑声”等）：这些位置不能当依据原句。" % ph)
    if not is_asr and not speaker_lines:
        notes.append("无时间码、无说话人标记、句子带标点：按人工整理稿处理。")

    if is_asr and sp_ratio >= 0.8:
        verdict = "usable"
    elif is_asr and sp_ratio > 0:
        verdict = "degraded"
    elif is_asr:
        verdict = "unusable"
    else:
        verdict = "usable"
    return {"form": form, "is_asr": is_asr, "lines": total, "ts_lines": ts_lines,
            "speaker_lines": speaker_lines, "placeholder": ph, "punctless_long": punctless,
            "ts_ratio": round(ts_ratio, 3), "speaker_ratio": round(sp_ratio, 3),
            "punctless_ratio": round(pl_ratio, 3), "verdict": verdict, "notes": notes}


PUNCT_ALL_RE = re.compile(r"[。！？；，、：,.!?;:]")


def normalize_asr_text(text):
    """去掉 ASR 稿里的格式噪声（行首时间码、说话人前缀、识别占位、标点），保留词语。

    只动格式，不动用词：同音错字属于识别误差，必须留给“依据不匹配”去暴露。
    标点也算格式——ASR 稿常没有句末标点，若依据抄自人工稿，会因为一个“。”
    整条判成不匹配，那是格式差异，不是可追溯性问题。
    """
    out = []
    for line in (text or "").splitlines():
        m = TS_RE.match(line)
        if m:
            line = line[m.end():]
        m = re.match(r"^([^\s：:，。；]{1,12})[：:](.*)$", line)
        if m:
            line = m.group(2)
        line = PLACEHOLDER_RE.sub("", line)
        out.append(PUNCT_ALL_RE.sub("", line))
    return "\n".join(out)


def derive_names(body_lines):
    """ASR 稿常没有“参会人：”行：从说话人标签反推人名。

    只认 1–4 个中文字、且出现至少 2 次的标签；“说话人1 / Speaker 2”这类自动
    编号不算人名——它们在待办表里对不上，硬用只会把 A 通道变成误报源。
    """
    cnt = {}
    for line in body_lines or []:
        m_ts = TS_RE.match(line)
        if m_ts:
            line = line[m_ts.end():]
        m = re.match(r"^([^\s：:，。；]{1,12})[：:]", line)
        if not m:
            continue
        tag = m.group(1)
        if not re.fullmatch(r"[\u4e00-\u9fa5]{1,4}", tag):
            continue
        if tag in ASR_ENUM_HEADS or tag.startswith(ASR_ENUM_HEADS):
            continue
        if SPEAKER_NUM_RE.match(tag):
            continue
        cnt[tag] = cnt.get(tag, 0) + 1
    return [t for t, c in sorted(cnt.items(), key=lambda kv: (-kv[1], kv[0])) if c >= 2]


def _split_turn(text, has_ts):
    """把一轮发言切成句子：标点优先，其次时间码分段，再次逗号，最后按长度兜底。"""
    parts = [p for p in re.split(r"(?<=[。！？；])", text) if p.strip()]
    if len(parts) > 1 or (parts and PUNCT_RE.search(parts[0])):
        return [p.strip() for p in parts]
    if has_ts:
        return [text]
    if len(text) <= 80:
        return [text]
    out = []
    for seg in [s.strip() for s in re.split(r"[，、；]", text) if s.strip()]:
        while len(seg) > 40:
            out.append(seg[:40])
            seg = seg[40:]
        if seg:
            out.append(seg)
    return out or [text]


# ---------------------------------------------------------------- 解析


def parse_transcript(path, raw=None):
    """返回 (参会人名单, [(说话人, 句子), ...])

    v1.6 起兼容录音识别稿：行首时间码先剥离；“参会人：”缺失时从说话人标签
    反推名单（只认真名，不认“说话人1”）；无句末标点时按时间码、逗号、长度
    依次兜底切句。人工整理稿的切分结果与 v1.5 完全一致。
    """
    if raw is None:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    lines = raw.splitlines()

    names = []
    for line in lines:
        m = re.match(r"^参会人[：:](.+)$", line.strip())
        if m:
            for seg in re.split(r"[、]", m.group(1)):
                nm = seg.split("（")[0].strip()
                if nm:
                    names.append(nm)
            break
    if not names:
        names = derive_names([l.strip() for l in lines if l.strip()])

    body = []
    for line in lines:
        text = line.strip()
        if not text:
            continue
        m_ts = TS_RE.match(text)
        has_ts = bool(m_ts)
        if has_ts:
            text = text[m_ts.end():]
        m = re.match(r"^([^\s：:，。；]{1,12})[：:](.*)$", text)
        if not m:
            continue
        sp, rest = m.group(1), m.group(2).strip()
        if not rest:
            continue
        if names and sp not in names:
            continue
        if not names and (sp in ASR_ENUM_HEADS or sp.startswith(ASR_ENUM_HEADS)):
            continue
        for sent in _split_turn(rest, has_ts):
            if sent.strip():
                body.append((sp, sent.strip()))
    return names, body


def build_sentences(body):
    """合并寒暄式应答句，处理指代，返回句子对象列表。"""
    out = []
    for sp, sent in body:
        prev = out[-1] if out else None
        is_ack = len(sent) <= 14 and ACK_RE.match(sent)
        has_self = "我" in sent.replace("我们", "")
        if prev is not None and is_ack and has_self and len(sent) <= 8:
            # “我来发。”一类承接句：并入上一句，但责任人记为本句说话人
            prev["text"] += sent
            prev["self_owner"] = sp
            continue
        if prev is not None and is_ack and not has_self:
            # “好，那你发一下。”一类确认句并入上一句，并记录被指派人
            prev["text"] += sent
            if "你" in sent and prev.get("you_target") is None:
                prev["you_target"] = prev["sp"]
            continue
        out.append({"sp": sp, "text": sent, "prev": prev["sp"] if prev else None,
                    "you_target": None, "self_owner": None})
    return out


INVITEE_RE = re.compile(
    r"把[^。！？；]{0,30}?(?:都)?叫上|(?:和|与|跟)[\u4e00-\u9fa5]{1,4}一起"
)


def strip_invitees(text):
    """v1.3 规则④：剥离“把 X 和 Y 都叫上”“和 X 一起”里的参会对象。

    被召集人和协同方不是责任人。第 4 组实测：主持人说“把产品负责人和丙
    都叫上”，丙被误判成“被指派拉会”，产出一条唯一也是误报的候选。
    """
    return INVITEE_RE.sub("", text)


def persons_in(sent_obj, names):
    """抽取句子里的责任人：显式点名 + 被指派的“你”，排除接收方与参会对象。"""
    text = sent_obj["text"]
    found = set()
    cleaned = strip_invitees(strip_recipients(text))
    for nm in names:
        if nm in cleaned:
            found.add(nm)
    if not found and "你" in cleaned:
        tgt = sent_obj.get("you_target") or sent_obj.get("prev")
        if tgt:
            found.add(tgt)
    if sent_obj.get("self_owner"):
        found.add(sent_obj["self_owner"])
        found.discard(sent_obj["sp"])
    return found


# ---------------------------------------------------------------- 通道 1：依据校验


def check_quotes(rows, transcript_text, normalize=True):
    """D 维度：原文依据能否在转录中逐字匹配（三态）。

    normalize=True 时先去掉两边的空白再比对——从文档/聊天窗复制的转录常带
    全角空格，严格比对会把整表判成“不匹配”，那是输入问题，不是依据问题。
    checkable=False 表示这条没有依据可查（缺列或空串），它不是“不命中”，
    调用方不得把它算进命中率分母。
    """
# v1.6：录音识别稿先去掉时间码/说话人前缀/识别占位再比对，避免把“格式差异”
    # 误判成“依据不可追溯”。严格模式（normalize=False）不做任何归一化，保持原样，
    # 用来演示噪声本身的影响。
    asr = detect_asr(transcript_text or "")
    asr_norm = bool(normalize and asr["is_asr"])

    def squeeze(s):
        return re.sub(r"\s+", "", s) if normalize else s

    def clean_quote(s):
        """依据侧也要按同一口径去噪：只去占位与标点，不剥说话人/时间码。"""
        s = s.strip("“”\"")
        if asr_norm:
            s = PLACEHOLDER_RE.sub("", PUNCT_ALL_RE.sub("", s))
        return squeeze(s)

    body = squeeze(normalize_asr_text(transcript_text or "")) if asr_norm else squeeze(transcript_text or "")
    results = []
    for r in rows:
        quote = (r.get("原文依据") or "").strip()
        parts = [p.strip() for p in re.split(r"[｜|＋+]", quote) if p.strip()]
        if not parts:
            results.append({"编号": r.get("编号", "?"), "hit": False, "quote": quote, "checkable": False})
            continue
        ok = all(clean_quote(p) in body for p in parts)
        results.append({"编号": r.get("编号", "?"), "hit": ok, "quote": quote, "checkable": True})
    return results


# ---------------------------------------------------------------- 通道 2：切片扫描


# v1.4 动作否决用词表：VERBS 之外补上「任务」列里常见的成果类动词，
# 让“制作素材”与“在群里公布日期”能被判成两件事，而不是靠字面相似度混为一谈。
ACTION_EXTRA = [
    "制作", "公布", "发布", "起草", "审核", "审批", "交付", "设计", "开发", "测试",
    "汇报", "通知", "统计", "归档", "招聘", "培训", "采购", "报销", "签约", "结算",
    "对账", "投放", "拍摄", "剪辑", "撰写", "翻译", "校对", "排期", "定价", "盘点",
    "调研", "走访", "拜访", "谈判", "催收", "回访", "报名", "登记", "录入", "导入",
    "备份", "部署", "巡检", "排查", "修复", "核对", "汇总", "拆解", "落地",
]
def _act_words():
    """保序去重后再按长度降序，保证 JS 侧用同样算法能得到同一匹配优先级。"""
    seen, out = set(), []
    for w in VERBS + ACTION_EXTRA:
        if w not in seen:
            seen.add(w)
            out.append(w)
    return sorted(out, key=len, reverse=True)   # sorted 稳定，等长词保留原序


ACT_RE = re.compile("|".join(_act_words()))


def actions(text):
    """抽取文本里的动作词（任务侧的“做什么”）。"""
    return set(ACT_RE.findall(text or ""))


def bigrams(s):
    s = re.sub(r"[^\u4e00-\u9fa5A-Za-z0-9]", "", s)
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else set()


def long_common(a, b):
    """最长公共子串长度"""
    best = 0
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            if a[i - 1] == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best:
                    best = cur[j]
        prev = cur
    return best


def owners_of(row, names):
    cell = row.get("负责人", "")
    if "待确认" in cell:
        return []
    return [n for n in names if n in cell]


def coverage(row, person, ctx, names):
    """该行是否覆盖了“这个人做的这件事”。ctx = 上一句 + 本句

    负责人为“待确认”的行不参与覆盖判断：它还没绑定到任何人，
    若允许靠文字相似吞掉候选，“会前阅读竞品方案”就会吞掉
    “王睿把竞品方案发到群里”这类真实遗漏。
    """
    if "待确认" in (row.get("负责人") or ""):
        return False
    if person not in owners_of(row, names):
        return False

    task = (row.get("任务") or "") + (row.get("约束") or "")
    task_only = row.get("任务") or ""
    dl = row.get("截止时间") or ""
    if dl and dl != "待确认" and dl in ctx:
        return True

    # v1.4 动作否决：先用「任务」列（不含约束）的动作词与候选句的动作词比对。
    # 两边一个动作词都不共享，说明不是同一件事——即使字面高度重叠也不能算覆盖。
    # 第 4 组的真遗漏就是这样被吞掉的：第 9 条是“制作第二批素材”，
    # 而漏掉的那句是“在群里公布日期”，二 gram 相似度却很高。
    # 任一侧抽不到动作词时退回原二 gram 逻辑，避免把短任务误否决。
    ta, ca = actions(task_only), actions(ctx)
    # 只在该任务含“成果类动词”（ACTION_EXTRA）时才启用否决：泛动词（对、补、盯、查）
    # 在同一件事的不同句里很常见，用它们否决会把“补全退款规则”这类已覆盖项翻出来。
    if (ta & set(ACTION_EXTRA)) and ca and not (ta & ca):
        return False

    tb, sb = bigrams(task), bigrams(ctx)
    ratio = len(tb & sb) / len(tb) if tb else 0.0
    return long_common(task, ctx) >= 4 or ratio >= 0.3


def is_procedural(text, names):
    """v1.2 规则①：程序性动词句。

    发布会/宣讲会里“邀请某人介绍情况”“回答记者提问”“刚才都讲到了”，
    有动词、有人名，但没有活。判据：含程序性动词 + 无“你”指派 +
    没有“点名的人紧跟动作”的结构。
    """
    if not PROCEDURAL_RE.search(text):
        return False
    if "你" in strip_recipients(text):
        return False
    for nm in names:
        if re.search(re.escape(nm) + ASSIGN_AFTER_NAME, text):
            return False
    return True


def is_rollcall(text, names):
    """v1.2 规则②：名单句。

    “出席今天新闻发布会的还有：廖岷先生，王东伟先生，郭婷婷女士。”
    两个以上人名、以冒号引出、无独立动作，整句排除。
    """
    if len([nm for nm in names if nm in text]) < 2:
        return False
    for nm in names:
        # “参加的有张三，张三你去对接”这类句子里带指派，不能当名单句排掉
        if re.search(re.escape(nm) + ASSIGN_AFTER_NAME, text):
            return False
    return bool(ROLLCALL_RE.search(text))


RECAP_HINT_RE = re.compile(r"(之前|上次|那次|是不是|有没有|还记得|刚才说)")


def is_recap(text, names):
    """v1.4 规则⑤：主持人复述句。

    会议末尾主持人常把全场待办复述一遍（“乙小红书数据下周三，丙素材周五第一批，
    丁价格机制周四盯……”）。这类句人名多、时间多、动作多，会同时命中多个切片，
    但它是复述已列表项，不是新任务。判据：≥2 个人名 + ≥2 个时间线索 + ≥3 个动作词。
    真实指派句通常只有一个人名和一个时限，不会被这条规则误伤。
    """
    people = len([nm for nm in names if nm in text])
    if people < 2:
        return False
    # 复述句的动作词很稀：主持人念的是“乙小红书数据下周三，丙素材周五第一批”，
    # 动词几乎全省，靠动作词数量判不出来。改看「多人名 + 长句」这个形态特征。
    if people >= 3 and len(text) >= 25:
        return True
    if len(actions(text)) < 3:
        return False
    return len(TIME_RE.findall(text)) >= 2


def is_lookback(text):
    """v1.4 规则⑥：回溯疑问句。

    “退款规则那个事，乙你之前是不是整理过一个版本？”——问的是过去做过什么，
    不是派活。判据：含回溯词，且整句没有任何时间线索（有“下周/周五”这类时限的
    句子不排除，那通常是真指派）。
    """
    if not RECAP_HINT_RE.search(text):
        return False
    return not TIME_RE.search(text)


def org_covered(org, rows):
    """机构句是否已被表内条目覆盖，避免与表重复计数。"""
    text = org["句"]
    for r in rows:
        task = (r.get("任务") or "") + (r.get("约束") or "")
        tb = bigrams(task)
        if not tb:
            continue
        if long_common(task, text) >= 4 or len(tb & bigrams(text)) / len(tb) >= 0.4:
            return True
    return False


def org_subject(text, names, rows):
    """v1.2 规则③：机构主体。

    责任落在“财政部/我们/相关部门”而不是任何个人时，此前整句失明
    （第 2 组郭婷婷 12 句零候选就是这种情况）。改为单列清单：
    只收含承诺动词、未点名个人、未被表覆盖的句子，人物记“机构（个人待确认）”，
    不进入候选表，不计入精确率。
    """
    if "你" in text or any(nm in text for nm in names):
        return None
    if PAST_RE.search(text[:12]):
        return None  # 回顾性陈述（“今年以来我们认真落实……”）不是待办
    m = ORG_RE.search(text)
    if not m or not ORG_COMMIT_RE.search(text):
        return None
    org = {"人物": "机构（个人待确认）", "主体": m.group(1), "句": text,
           "时间": (TIME_RE.search(text).group(1) if TIME_RE.search(text) else "无")}
    if org_covered(org, rows):
        return None
    return org


def slice_scan(names, sentences, rows):
    """按人切片：输出个人候选、低置信池、机构主体清单（都只是候选，不是结论）"""
    cands, low, orgs = [], [], []
    for idx, s in enumerate(sentences):
        text = s["text"]
        if not any(v in text for v in VERBS):
            continue
        # v1.2 规则①② + v1.4 规则⑤⑥：程序性句、名单句、主持人复述句、回溯疑问句
        # 在归属判定之前整句排除；这些句子有人名也有动词，但都不是新派活
        if (is_procedural(text, names) or is_rollcall(text, names)
                or is_recap(text, names) or is_lookback(text)):
            continue
        ctx = (sentences[idx - 1]["text"] if idx else "") + text
        people = persons_in(s, names)
        if not people:
            # v1.2 规则③：责任在机构时单列，不再整句丢弃
            org = org_subject(text, names, rows)
            if org:
                orgs.append(org)
            continue
        leaders = {nm for nm in names
                   if re.search(re.escape(nm) + LEADER_RE, text)}
        has_time = bool(TIME_RE.search(text))
        explicit = ("你" in strip_recipients(text)) or ("必须" in text) or ("之前" in text)

        for p in sorted(people):
            if "配合" in text and p in leaders:
                continue  # 牵头方视为管理角色，只核配合方
            if any(coverage(r, p, ctx, names) for r in rows):
                continue
            if has_time or explicit:
                conf = "高"
            elif any(v in text for v in ("确认", "补齐", "统一", "对", "写", "出", "发", "谈")):
                conf = "中"
            else:
                conf = "低"
            note = ""
            if SOFT_RE.search(text) and not explicit:
                conf = "低"
                note = "含软要求词，疑为讨论性表述，交 B 维度判断"
            item = {"人物": p, "句": text, "置信度": conf, "备注": note,
                    "时间": (TIME_RE.search(text).group(1) if has_time else "无")}
            (cands if conf in ("高", "中") else low).append(item)
    return cands, low, orgs


# ---------------------------------------------------------------- 内置示例表

DEMO_ROWS = [
    ("1", "拉取新用户引导漏斗数据并按渠道拆分", "王睿", "下周二前", "按渠道拆分，交付张岚",
     "王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。"),
    ("2", "修复支付回调重复通知（幂等）", "李思远", "本周五前", "先灰度 10%，无问题再全量",
     "李思远，本周五前修完，先灰度 10% 验证，没问题再全量。"),
    ("3", "改版落地页输出两版视觉", "陈晨", "下周三前", "沿用现有结构；内部先选一版",
     "陈晨你按现在的结构再出两版视觉，下周三之前给我，咱们内部先选一版。"),
    ("4", "获取星图渠道正式报价单", "赵敏", "本周内", "拿不到报价单则先要框架协议",
     "赵敏你本周内把报价单拿到，拿不到就先要个框架协议，别拖着。"),
    ("5", "输出改版常见问题客服话术", "何静", "周五前", "覆盖改版后用户常见问题",
     "对，客服那边要出一版话术，把这次改版的常见问题整理出来，周五前给我。何静你盯一下。"),
    ("6", "统一数据看板日活口径", "何静", "下个月 10 号前", "三个部门口径不一致，需统一",
     "还有个事，上次说的数据看板，下个月 10 号之前必须把日活口径统一了，不然周报没法看。"),
    ("7", "线下沙龙改期至 9 月并锁定场地", "赵敏", "9 月第二周", "原定 8 月，场地 8 月已排满",
     "那就把线下沙龙挪到 9 月，场地先锁 9 月第二周。赵敏你去谈。"),
    ("8", "与陈晨确认市场物料展架尺寸", "赵敏", "待确认", "与陈晨共同确认，避免返工",
     "市场物料的事我记一下，赵敏你回头跟陈晨确认下展架尺寸，别到时候又返工。"),
    ("9", "撰写 Q3 OKR 初稿并发群", "张岚", "下周一", "周三评审会过一遍",
     "Q3 的 OKR 初稿我来写，下周一发群里，大家提前看，周三评审会过一遍。"),
    ("10", "会前阅读两家竞品改版方案", "待确认", "评审会前", "未指定到人",
     "评审会前建议大家先看一下竞品这两家的改版方案，别到时候没准备。"),
    ("11", "发送会议纪要到项目群并抄送赵敏", "待确认", "待确认", "抄送赵敏",
     "今天的纪要发项目群，抄送赵敏。"),
]

DEMO_HEADER = ["编号", "任务", "负责人", "截止时间", "约束", "原文依据"]


def load_rows(path):
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    transcript = args[0]
    if "--demo" in args:
        rows = [dict(zip(DEMO_HEADER, r)) for r in DEMO_ROWS]
    else:
        rows = load_rows(args[args.index("--table") + 1])

    with open(transcript, encoding="utf-8") as f:
        raw = f.read()
    names, body = parse_transcript(transcript)
    sentences = build_sentences(body)

    print(f"## 输入｜{transcript}\n参会人 {len(names)} 人｜句子 {len(sentences)} 条｜表内 {len(rows)} 条\n")

    print("## D 通道：原文依据逐字校验")
    hits = check_quotes(rows, raw)
    bad = [h for h in hits if not h["hit"]]
    print(f"命中 {len(hits) - len(bad)}/{len(hits)}")
    for h in bad:
        print(f"- #{h['编号']} 依据不可追溯：{h['quote']}")
    print()

    print("## A 通道：按人切片候选（只出候选，不下结论）")
    cands, low, orgs = slice_scan(names, sentences, rows)
    print("| 序号 | 人物 | 时间线索 | 置信度 | 原文 | 备注 |")
    print("|---|---|---|---|---|---|")
    for i, c in enumerate(cands, 1):
        print(f"| {i} | {c['人物']} | {c['时间']} | {c['置信度']} | {c['句']} | {c['备注'] or '—'} |")
    print(f"\n候选 {len(cands)} 条；低置信池 {len(low)} 条（需人工过目，不进入候选表）")
    for c in low:
        print(f"- [低] {c['人物']}｜{c['句']}")
    print()

    print("## 机构主体清单（责任在机构而非个人，单列，不进入候选表、不计精确率）")
    print("| 序号 | 主体 | 时间线索 | 原文 |")
    print("|---|---|---|---|")
    for i, o in enumerate(orgs, 1):
        print(f"| {i} | {o['主体']} | {o['时间']} | {o['句']} |")
    print(f"\n机构主体 {len(orgs)} 条；仅作提醒，采纳权在用户")
    print()

    print("## 切片视图（按人重排，供人工复核）")
    by_person = {}
    for s in sentences:
        by_person.setdefault(s["sp"], []).append(s["text"])
    for nm in names:
        print(f"- {nm}（{len(by_person.get(nm, []))} 句）")


if __name__ == "__main__":
    main()