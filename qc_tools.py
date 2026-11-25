#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会议待办质检辅助工具 v1.2

设计原则：只做机器能给出硬证据的部分，不假装能判断语义。
三个通道，分别对应质检的 D / A / B 维度：

  1) check_quotes   D 维度：原文依据是否在转录中逐字存在（字符串匹配，硬结论）
  2) slice_scan     A 维度：按人切片 + 规则扫描，只输出“候选”，不下“遗漏”结论
  3) soft 标记      B 维度辅助：标出含软要求词的句子，供人工/模型判断

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


# ---------------------------------------------------------------- 解析


def parse_transcript(path):
    """返回 (参会人名单, [(说话人, 句子), ...])"""
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()

    names, body = [], []
    for line in lines:
        m = re.match(r"^参会人[：:](.+)$", line.strip())
        if m:
            for seg in re.split(r"[、]", m.group(1)):
                nm = seg.split("（")[0].strip()
                if nm:
                    names.append(nm)
            break
    for line in lines:
        m = re.match(r"^([\u4e00-\u9fa5]{2,4})[：:](.*)$", line.strip())
        if m and m.group(1) in names:
            for sent in re.split(r"(?<=[。！？；])", m.group(2).strip()):
                if sent.strip():
                    body.append((m.group(1), sent.strip()))
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


def persons_in(sent_obj, names):
    """抽取句子里的责任人：显式点名 + 被指派的“你”，排除接收方。"""
    text = sent_obj["text"]
    found = set()
    cleaned = strip_recipients(text)
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


def check_quotes(rows, transcript_text):
    results = []
    for r in rows:
        quote = (r.get("原文依据") or "").strip()
        parts = [p.strip() for p in re.split(r"[｜|＋+]", quote) if p.strip()]
        ok = bool(parts) and all(p.strip("“”\"") in transcript_text for p in parts)
        results.append({"编号": r.get("编号", "?"), "hit": ok, "quote": quote})
    return results


# ---------------------------------------------------------------- 通道 2：切片扫描


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
    dl = row.get("截止时间") or ""
    if dl and dl != "待确认" and dl in ctx:
        return True

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
        # v1.2 规则①②：程序性句与名单句在归属判定之前整句排除
        if is_procedural(text, names) or is_rollcall(text, names):
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