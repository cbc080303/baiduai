// A 通道（按人切片查遗漏）—— qc_tools.py v1.4 slice_scan 的等价 JS 实现
// 用途：供演示页内联使用（浏览器），也可被 node 直接加载做对拍验证。
// 原则：只输出“候选”，不下“遗漏”结论；机构主体单列清单，不进候选表、不计精确率。
// v1.3 与 Python 同步：规则①程序性动词句、②名单句、③机构主体、④参会对象剥离；
//    姓名正则放宽到 1 字，支持“甲/乙/丙/丁”这类单字代称脱敏（此前会整条静默失效）。
// v1.4 新增：规则⑤主持人复述句、⑥回溯疑问句；覆盖判断加“动作否决”——
//    两边一个成果动词都不共享时不算覆盖，救回第 4 组被吞掉的那条真遗漏。

const A_CHANNEL = (function(){
  const VERBS = ["修","做","出","拉","拿","发","对","谈","确认","整理","补齐","统一",
    "安排","写","跟进","联系","准备","提测","上线","锁","催","排","复盘",
    "评估","对齐","盯","查","挪","落实","推进","补","打","电话"];

  // v1.4 动作否决用词表（与 qc_tools.py 的 ACTION_EXTRA 逐字一致）
  const ACTION_EXTRA = ["制作","公布","发布","起草","审核","审批","交付","设计","开发","测试",
    "汇报","通知","统计","归档","招聘","培训","采购","报销","签约","结算",
    "对账","投放","拍摄","剪辑","撰写","翻译","校对","排期","定价","盘点",
    "调研","走访","拜访","谈判","催收","回访","报名","登记","录入","导入",
    "备份","部署","巡检","排查","修复","核对","汇总","拆解","落地"];

  const TIME_RE = /(下周[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]前|下个月\s*\d+\s*[号日]?|\d+\s*月\s*第?[一二三四]?周|\d+\s*月\s*\d+\s*[日号]|今天|明天|后天|月底|月底前|下月初|评审会前|上线前|会前)/g;
  const TIME_RE1 = /(下周[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]前|下个月\s*\d+\s*[号日]?|\d+\s*月\s*第?[一二三四]?周|\d+\s*月\s*\d+\s*[日号]|今天|明天|后天|月底|月底前|下月初|评审会前|上线前|会前)/;
  const SOFT_RE = /(建议|可以考虑|可以|要不|最好|我觉得|要不要|是不是|如果|先不)/;
  const ACK_RE = /^(好|对|行|可以|明白|嗯|收到|没问题)/;
  const LEADER_RE = "[^，。；]{0,4}(牵头|负责|主导)";

  // v1.2 三条排除规则用到的词典（与 qc_tools.py 逐字对应）
  const PROCEDURAL_RE = /(邀请|出席|参加|介绍|回答|讲到|提到|感谢|欢迎|主持)/;
  const ROLLCALL_RE = /(还有|的有|出席|参加|邀请)[：:]/;
  const ASSIGN_AFTER_NAME = "[^，。；]{0,6}(做|出|写|发|整理|确认|准备|跟进|补齐|统一|落实|推进|完成)";
  const ORG_RE = /(财政部|我部|我们|有关部门|相关部门|各部门|各部委)/;
  const ORG_COMMIT_RE = /(必须|确保|务必|完成|落实|下达|出台|印发|建立|推动|加快|抓好|做好|研究|推进|发行|统一|扩大|完善)/;
  const PAST_RE = /(今年以来|近年来|近几年|去年|过去|此前|已经|曾经|早前|原来)/;
  // v1.4 规则⑥回溯词
  const RECAP_HINT_RE = /(之前|上次|那次|是不是|有没有|还记得|刚才说)/;

  // v1.3 规则④：参会对象（“把 X 和 Y 都叫上”“和 X 一起”）不是责任人
  const INVITEE_RE = /把[^。！？；]{0,30}?(?:都)?叫上|(?:和|与|跟)[\u4e00-\u9fa5]{1,4}一起/;

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 动作词：VERBS + ACTION_EXTRA，保序去重后按长度降序（与 Python _act_words 同算法）
  const ACT_RE = (function(){
    const seen = {}, out = [];
    VERBS.concat(ACTION_EXTRA).forEach(w => {
      if (!Object.prototype.hasOwnProperty.call(seen, w)){ seen[w] = 1; out.push(w); }
    });
    const ordered = out.map((w, i) => [w, i])
      .sort((a, b) => (b[0].length - a[0].length) || (a[1] - b[1]))
      .map(x => x[0]);
    return new RegExp(ordered.map(escRe).join("|"), "g");
  })();

  function actions(text){
    const t = String(text || "");
    const m = t.match(ACT_RE);
    return new Set(m || []);
  }

  function stripRecipients(text){
    let t = text.split("给我们").join("").split("给我").join("");
    t = t.replace(/(发|给|抄送|报给|通知|告诉|回复)(你|您)/g, "");
    t = t.replace(/抄送[\u4e00-\u9fa5]{2,3}/g, "");
    return t;
  }

  // v1.3 规则④：先剥离被召集的参会对象，再判责任人
  function stripInvitees(text){
    return text.replace(INVITEE_RE, "");
  }

  // ---- v1.5 录音识别（ASR）稿适配：与 qc_tools.py v1.6 同口径 ----
  const TS_RE = /^\s*[\[\(【]?(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?)[\]\)】]?\s*/;
  const PLACEHOLDER_RE = /[\[\(（【]\s*(听不清|听不见|无法识别|噪声|噪音|音乐|笑声|掌声|沉默|静音|重叠|unintelligible|inaudible|noise|music|laughter|silence|overlap)\s*[\]\)）】]/gi;
  const PUNCT_ALL_RE = /[。！？；，、：,.!?;:]/g;
  const ASR_ENUM_HEADS = ["说话人", "发言人", "嘉宾"];
  const FORM_CN = {"timestamp+speaker": "时间码+说话人", "speaker": "仅说话人标记",
                   "timestamp": "仅时间码", "plain": "纯文本", "empty": "空输入"};
  const VERDICT_CN = {"usable": "可检", "degraded": "降级可检", "unusable": "不可检"};

  function isEnumHead(tag){
    return ASR_ENUM_HEADS.some(h => tag.indexOf(h) === 0);
  }

  // 检测这段文字是不是录音识别稿，并给出可机械核对的指标
  function detectAsr(raw){
    const lines = String(raw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const total = lines.length;
    if (!total) return {form: "empty", is_asr: false, lines: 0, ts_lines: 0, speaker_lines: 0,
      placeholder: 0, punctless_long: 0, ts_ratio: 0, speaker_ratio: 0, punctless_ratio: 0,
      verdict: "unusable", notes: ["输入为空。"]};
    let tsLines = 0, spkLines = 0, punctless = 0;
    lines.forEach(line0 => {
      let line = line0;
      if (TS_RE.test(line)){ tsLines++; line = line.replace(TS_RE, ""); }
      const m = line.match(/^([^\s：:，。；]{1,12})[：:](.*)$/);
      if (m){ spkLines++; line = m[2]; }
      const body = line.trim();
      if (body.length >= 30 && !/[。！？；]/.test(body) && !/[，、]/.test(body)) punctless++;
    });
    const ph = (String(raw || "").match(PLACEHOLDER_RE) || []).length;
    const tsRatio = tsLines / total, spkRatio = spkLines / total, plRatio = punctless / total;
    const isAsr = !!(tsLines || ph || plRatio >= 0.3);
    const form = (tsLines && spkLines) ? "timestamp+speaker"
      : (spkLines ? "speaker" : (tsLines ? "timestamp" : "plain"));
    const notes = [];
    if (isAsr && !spkLines) notes.push("没有说话人标记：按人切片的遗漏检查无法执行，只能跑依据回查与字段核查。");
    if (isAsr && plRatio >= 0.3) notes.push("有 " + punctless + " 行是没有标点的长句：按标点切句会失效，需按时间码或长度切。");
    if (ph) notes.push("含 " + ph + " 处识别占位（“听不清”“笑声”等）：这些位置不能当依据原句。");
    if (!isAsr && !spkLines) notes.push("无时间码、无说话人标记、句子带标点：按人工整理稿处理。");
    const verdict = (isAsr && spkRatio >= 0.8) ? "usable"
      : (isAsr && spkRatio > 0) ? "degraded" : (isAsr ? "unusable" : "usable");
    return {form: form, is_asr: isAsr, lines: total, ts_lines: tsLines, speaker_lines: spkLines,
      placeholder: ph, punctless_long: punctless, ts_ratio: tsRatio, speaker_ratio: spkRatio,
      punctless_ratio: plRatio, verdict: verdict, notes: notes};
  }

  // v1.6 材料分拣：结构判断（表头+分列 → 待办表；说话人前缀占比 → 转录）
  const TODO_HEAD_KW = ["任务", "待办", "负责人", "责任人", "截止时间", "时限", "原文依据", "依据", "约束", "编号", "序号"];
  const SPEAKER_LINE_RE = /^[^\s：:，。；]{1,12}[：:]\s*\S/;

  function classifyMaterial(text){
    const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
    if (!lines.length) return {kind: "empty", todo_score: 0, transcript_score: 0,
      reasons: ["材料为空。"], head_hits: [], cols: 0, speaker_ratio: 0, asr: detectAsr(raw)};
    const head = lines[0];
    const headHits = TODO_HEAD_KW.filter(k => head.indexOf(k) >= 0);
    let delim = "";
    if (head.trim().indexOf("|") === 0) delim = "|";
    else if (head.indexOf("\t") >= 0) delim = "\t";
    else if ((head.match(/,/g) || []).length >= 2) delim = ",";
    else if ((head.match(/，/g) || []).length >= 2) delim = "，";
    const cols = delim ? head.split(delim).filter(c => c.trim()).length : 0;
    const reasons = [];
    let todoScore = 0;
    if (headHits.length >= 2 && cols >= 3){
      todoScore += 3;
      reasons.push("首行像表头（" + headHits.slice(0, 4).join("、") + "），分成 " + cols + " 列");
    } else if (headHits.length >= 2){
      todoScore += 1;
      reasons.push("首行有多个表头词，但没分成列");
    }
    if (lines.length >= 2 && cols >= 3) todoScore += 1;
    let spk = 0;
    lines.forEach(l => {
      let t = l;
      if (TS_RE.test(t)) t = t.replace(TS_RE, "");
      if (SPEAKER_LINE_RE.test(t)) spk++;
    });
    const spkRatio = spk / lines.length;
    let trScore = 0;
    // 只认「过半行是发言行」这一条硬证据：说明类文档里零星几行“XX：”不算转录，
    // 弱加分曾把组织视图、纪要正文误判成转录。
    // 另需至少 3 行发言行：单行材料（例如只有「参会人：张三、李四」）ratio 恒为 1，
// 不加这道下限会把一行名单判成整份转录。
    if (spkRatio >= 0.5 && spk >= 3){ trScore += 3; reasons.push(spk + "/" + lines.length + " 行是「姓名：内容」式发言"); }
    if (/参会人[：:]/.test(raw)){ trScore += 1; reasons.push("含「参会人：」行"); }
    const asr = detectAsr(raw);
    if (asr.is_asr){ trScore += 1; reasons.push("含时间码或识别占位，属录音转写稿"); }
    let kind;
    if (todoScore >= 3 && todoScore >= trScore) kind = "todo";
    else if (trScore >= 2 && trScore > todoScore) kind = "transcript";
    else if (todoScore >= 1 && !trScore) kind = "todo";
    else kind = "unknown";   // 证据不足就不猜：页面会把它放进空框并提示核对
    return {kind: kind, todo_score: todoScore, transcript_score: trScore, reasons: reasons,
            head_hits: headHits, cols: cols, speaker_ratio: spkRatio, asr: asr};
  }

  // 去格式噪声：时间码、说话人前缀、识别占位、标点；不动用词
  function asrNormalize(raw){
    return String(raw || "").split(/\r?\n/).map(line => {
      let s = line;
      if (TS_RE.test(s)) s = s.replace(TS_RE, "");
      const m = s.match(/^([^\s：:，。；]{1,12})[：:](.*)$/);
      if (m) s = m[2];
      return s.replace(PLACEHOLDER_RE, "").replace(PUNCT_ALL_RE, "");
    }).join("\n");
  }

  // 一轮发言切成句子：标点优先，其次时间码，再次逗号，最后按 40 字兜底
  function splitTurn(text, hasTs){
    const parts = text.match(/[^。！？；]*[。！？；]|[^。！？；]+/g) || [];
    if (parts.length > 1) return parts.map(p => p.trim()).filter(Boolean);
    if (hasTs) return [text];
    if (text.length <= 80) return [text];
    const out = [];
    text.split(/[，、；]/).forEach(seg => {
      let s = seg.trim();
      while (s.length > 40){ out.push(s.slice(0, 40)); s = s.slice(40); }
      if (s) out.push(s);
    });
    return out.length ? out : [text];
  }

  // 没有「参会人：」行时，从说话人标签反推真名（只认出现 ≥2 次的 1–4 字标签）
  function deriveNames(lines){
    const cnt = {};
    lines.forEach(raw => {
      let line = String(raw);
      if (TS_RE.test(line)) line = line.replace(TS_RE, "");
      const m = line.match(/^([^\s：:，。；]{1,12})[：:]/);
      if (!m) return;
      const tag = m[1];
      if (!/^[\u4e00-\u9fa5]{1,4}$/.test(tag) || isEnumHead(tag)) return;
      cnt[tag] = (cnt[tag] || 0) + 1;
    });
    return Object.keys(cnt).filter(t => cnt[t] >= 2)
      .sort((a, b) => (cnt[b] - cnt[a]) || (a < b ? -1 : 1));
  }

  // 解析：返回 { names, body:[[speaker, sentence], ...] }
  function parseTranscript(raw){
    const lines = String(raw || "").split(/\r?\n/);
    let names = [];
    for (const line of lines){
      const m = line.trim().match(/^参会人[：:](.+)$/);
      if (m){
        names = m[1].split("、").map(s => s.split("（")[0].trim()).filter(Boolean);
        break;
      }
    }
    if (!names.length) names = deriveNames(lines);
    const body = [];
    for (const line of lines){
      // v1.3 姓名 1–4 字兼容单字代称；v1.5 先剥行首时间码，姓名放宽到 12 字符以容纳英文名
      let text = String(line).trim();
      if (!text) continue;
      const hasTs = TS_RE.test(text);
      if (hasTs) text = text.replace(TS_RE, "");
      const m = text.match(/^([^\s：:，。；]{1,12})[：:](.*)$/);
      if (!m) continue;
      const sp = m[1], rest = m[2].trim();
      if (!rest) continue;
      if (names.length && names.indexOf(sp) < 0) continue;
      if (!names.length && isEnumHead(sp)) continue;
      splitTurn(rest, hasTs).forEach(p => { if (p) body.push([sp, p]); });
    }
    return {names, body};
  }

  // 合并寒暄式应答句，记录被指派的“你”与“我来做”的承接者
  function buildSentences(body){
    const out = [];
    for (const pair of body){
      const sp = pair[0], sent = pair[1];
      const prev = out.length ? out[out.length - 1] : null;
      const isAck = sent.length <= 14 && ACK_RE.test(sent);
      const hasSelf = sent.split("我们").join("").indexOf("我") >= 0;
      if (prev && isAck && hasSelf && sent.length <= 8){
        prev.text += sent;
        prev.selfOwner = sp;
        continue;
      }
      if (prev && isAck && !hasSelf){
        prev.text += sent;
        if (sent.indexOf("你") >= 0 && prev.youTarget == null) prev.youTarget = prev.sp;
        continue;
      }
      out.push({sp: sp, text: sent, prev: prev ? prev.sp : null, youTarget: null, selfOwner: null});
    }
    return out;
  }

  function personsIn(s, names){
    const found = new Set();
    const cleaned = stripInvitees(stripRecipients(s.text));
    for (const nm of names) if (cleaned.indexOf(nm) >= 0) found.add(nm);
    if (found.size === 0 && cleaned.indexOf("你") >= 0){
      const tgt = s.youTarget || s.prev;
      if (tgt) found.add(tgt);
    }
    if (s.selfOwner){
      found.add(s.selfOwner);
      found.delete(s.sp);
    }
    return found;
  }

  function bigrams(s){
    const t = String(s || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    return set;
  }

  function longCommon(a, b){
    let best = 0;
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++){
      const cur = new Array(b.length + 1).fill(0);
      for (let j = 1; j <= b.length; j++){
        if (a[i - 1] === b[j - 1]){
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) best = cur[j];
        }
      }
      prev = cur;
    }
    return best;
  }

  function ownersOf(row, names){
    const cell = row["负责人"] || "";
    if (cell.indexOf("待确认") >= 0) return [];
    return names.filter(n => cell.indexOf(n) >= 0);
  }

  function coverage(row, person, ctx, names){
    if ((row["负责人"] || "").indexOf("待确认") >= 0) return false;
    if (ownersOf(row, names).indexOf(person) < 0) return false;
    const task = (row["任务"] || "") + (row["约束"] || "");
    const taskOnly = row["任务"] || "";
    const dl = row["截止时间"] || "";
    if (dl && dl !== "待确认" && ctx.indexOf(dl) >= 0) return true;

    // v1.4 动作否决：任务列含成果动词、且与候选句一个都不共享 → 不是同一件事。
    // 第 4 组的真遗漏就是这样被吞掉的：第 9 条是“制作第二批素材”，
    // 漏掉的那句是“在群里公布日期”，二 gram 相似度却很高。
    const ta = actions(taskOnly), ca = actions(ctx);
    let hasExtra = false;
    ta.forEach(w => { if (ACTION_EXTRA.indexOf(w) >= 0) hasExtra = true; });
    if (hasExtra && ca.size){
      let common = false;
      ta.forEach(w => { if (ca.has(w)) common = true; });
      if (!common) return false;
    }

    const tb = bigrams(task), sb = bigrams(ctx);
    let inter = 0;
    tb.forEach(b => { if (sb.has(b)) inter++; });
    const ratio = tb.size ? inter / tb.size : 0;
    return longCommon(task, ctx) >= 4 || ratio >= 0.3;
  }

  // v1.2 规则①：程序性动词句（邀请介绍、回答提问、刚才讲到了）——有动词、没活
  function isProcedural(text, names){
    if (!PROCEDURAL_RE.test(text)) return false;
    if (stripRecipients(text).indexOf("你") >= 0) return false;
    for (const nm of names){
      if (new RegExp(escRe(nm) + ASSIGN_AFTER_NAME).test(text)) return false;
    }
    return true;
  }

  // v1.2 规则②：名单句（“出席今天发布会的还有：张三、李四”）——带指派则豁免
  function isRollcall(text, names){
    if (names.filter(nm => text.indexOf(nm) >= 0).length < 2) return false;
    for (const nm of names){
      if (new RegExp(escRe(nm) + ASSIGN_AFTER_NAME).test(text)) return false;
    }
    return ROLLCALL_RE.test(text);
  }

  // v1.4 规则⑤：主持人复述句（多人名 + 长句；动作词稀疏，靠形态判）
  function isRecap(text, names){
    const people = names.filter(nm => text.indexOf(nm) >= 0).length;
    if (people < 2) return false;
    if (people >= 3 && text.length >= 25) return true;
    if (actions(text).size < 3) return false;
    const t = text.match(TIME_RE);
    return (t ? t.length : 0) >= 2;
  }

  // v1.4 规则⑥：回溯疑问句（“乙你之前是不是整理过一个版本？”）——问过去，不派活
  function isLookback(text){
    if (!RECAP_HINT_RE.test(text)) return false;
    return !TIME_RE1.test(text);
  }

  // v1.2 规则③：机构句是否已被表内条目覆盖，避免与表重复计数
  function orgCovered(org, rows){
    const text = org["句"];
    for (const r of rows){
      const task = (r["任务"] || "") + (r["约束"] || "");
      const tb = bigrams(task);
      if (!tb.size) continue;
      let inter = 0;
      tb.forEach(b => { if (bigrams(text).has(b)) inter++; });
      if (longCommon(task, text) >= 4 || inter / tb.size >= 0.4) return true;
    }
    return false;
  }

  // v1.2 规则③：责任落在“财政部／我们／相关部门”时单列，不整句丢弃
  function orgSubject(text, names, rows){
    if (text.indexOf("你") >= 0 || names.some(nm => text.indexOf(nm) >= 0)) return null;
    if (PAST_RE.test(text.slice(0, 12))) return null;
    const m = ORG_RE.exec(text);
    if (!m || !ORG_COMMIT_RE.test(text)) return null;
    const tm = TIME_RE1.exec(text);
    const org = {"人物": "机构（个人待确认）", "主体": m[1], "句": text, "时间": tm ? tm[1] : "无"};
    if (orgCovered(org, rows)) return null;
    return org;
  }

  function sliceScan(names, sentences, rows){
    const cands = [], low = [], orgs = [];
    sentences.forEach((s, idx) => {
      const text = s.text;
      if (!VERBS.some(v => text.indexOf(v) >= 0)) return;
      // 规则①②⑤⑥：程序性句、名单句、复述句、回溯句在归属判定之前整句排除
      if (isProcedural(text, names) || isRollcall(text, names) ||
          isRecap(text, names) || isLookback(text)) return;
      const ctx = (idx ? sentences[idx - 1].text : "") + text;
      const people = personsIn(s, names);
      if (people.size === 0){
        // 规则③：责任在机构时单列，不再整句丢弃
        const org = orgSubject(text, names, rows);
        if (org) orgs.push(org);
        return;
      }
      const leaders = new Set(names.filter(nm => new RegExp(escRe(nm) + LEADER_RE).test(text)));
      const tm = TIME_RE1.exec(text);
      const hasTime = !!tm;
      const st = stripRecipients(text);
      const explicit = st.indexOf("你") >= 0 || text.indexOf("必须") >= 0 || text.indexOf("之前") >= 0;

      [...people].sort().forEach(p => {
        if (text.indexOf("配合") >= 0 && leaders.has(p)) return;   // 牵头方视为管理角色
        if (rows.some(r => coverage(r, p, ctx, names))) return;    // 已被表内条目覆盖
        let conf;
        if (hasTime || explicit) conf = "高";
        else if (["确认","补齐","统一","对","写","出","发","谈"].some(v => text.indexOf(v) >= 0)) conf = "中";
        else conf = "低";
        let note = "";
        if (SOFT_RE.test(text) && !explicit){ conf = "低"; note = "含软要求词，疑为讨论性表述，交 B 维度判断"; }
        const item = {"人物": p, "句": text, "置信度": conf, "备注": note, "时间": hasTime ? tm[1] : "无"};
        if (conf === "高" || conf === "中") cands.push(item); else low.push(item);
      });
    });
    return {cands, low, orgs};
  }

  // 一行入口：转录原文 + 表内条目（对象数组，含 负责人/任务/截止时间/约束）
  function scan(raw, rows){
    const p = parseTranscript(raw);
    const sentences = buildSentences(p.body);
    const res = sliceScan(p.names, sentences, rows || []);
    // v1.3：把“静默归零”变成可解释的提示。切句为 0 时最可能的原因是
    // 发言行格式不对或姓名与名单不一致（单字代称曾经整条失配且不报错）。
    const asr = detectAsr(raw);
    const hasRoster = /参会人[：:]/.test(String(raw || ""));
    let warn = null;
    if (!p.names.length){
      warn = "没读到「参会人：」行";
    } else if (!sentences.length){
      warn = "读到了名单（" + p.names.length + " 人），但一句发言都没切出来——请检查每行是否为「姓名：内容」，且姓名与「参会人：」行里的一致。单字代称（甲/乙/丙/丁）已支持。";
    } else if (asr.is_asr && !hasRoster){
      warn = "识别为录音转写稿：名单由说话人标签反推 " + p.names.length + " 人，建议核对是否漏人；依据比对已自动去掉时间码与识别占位。";
    }
    return {names: p.names, count: sentences.length, cands: res.cands, low: res.low, orgs: res.orgs, warn: warn, asr: asr};
  }

  return {scan, _sliceScan: sliceScan, detectAsr, asrNormalize, parseTranscript, classifyMaterial};
})();

if (typeof module !== "undefined" && module.exports){
  module.exports = {A_CHANNEL, scanTranscript: (raw, rows) => A_CHANNEL.scan(raw, rows)};
}