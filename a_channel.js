// A 通道（按人切片查遗漏）—— qc_tools.py v1.2 slice_scan 的等价 JS 实现
// 用途：供演示页内联使用（浏览器），也可被 node 直接加载做对拍验证。
// 原则：只输出“候选”，不下“遗漏”结论；机构主体单列清单，不进候选表、不计精确率。
// v1.2 与 Python 同步：规则①程序性动词句、规则②名单句、规则③机构主体。

const A_CHANNEL = (function(){
  const VERBS = ["修","做","出","拉","拿","发","对","谈","确认","整理","补齐","统一",
    "安排","写","跟进","联系","准备","提测","上线","锁","催","排","复盘",
    "评估","对齐","盯","查","挪","落实","推进","补","打","电话"];

  const TIME_RE = /(下周[一二三四五六日天]|本周[一二三四五六日天]|周[一二三四五六日天]前|下个月\s*\d+\s*[号日]?|\d+\s*月\s*第?[一二三四]?周|\d+\s*月\s*\d+\s*[日号]|今天|明天|后天|月底|月底前|下月初|评审会前|上线前|会前)/;
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

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function stripRecipients(text){
    let t = text.split("给我们").join("").split("给我").join("");
    t = t.replace(/(发|给|抄送|报给|通知|告诉|回复)(你|您)/g, "");
    t = t.replace(/抄送[\u4e00-\u9fa5]{2,3}/g, "");
    return t;
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
    const body = [];
    for (const line of lines){
      const m = line.trim().match(/^([\u4e00-\u9fa5]{2,4})[：:](.*)$/);
      if (!m || names.indexOf(m[1]) < 0) continue;
      const parts = m[2].trim().match(/[^。！？；]*[。！？；]|[^。！？；]+/g) || [];
      for (const p of parts) if (p.trim()) body.push([m[1], p.trim()]);
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
    const cleaned = stripRecipients(s.text);
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
    const dl = row["截止时间"] || "";
    if (dl && dl !== "待确认" && ctx.indexOf(dl) >= 0) return true;
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
    const tm = TIME_RE.exec(text);
    const org = {"人物": "机构（个人待确认）", "主体": m[1], "句": text, "时间": tm ? tm[1] : "无"};
    if (orgCovered(org, rows)) return null;
    return org;
  }

  function sliceScan(names, sentences, rows){
    const cands = [], low = [], orgs = [];
    sentences.forEach((s, idx) => {
      const text = s.text;
      if (!VERBS.some(v => text.indexOf(v) >= 0)) return;
      // 规则①②：程序性句与名单句在归属判定之前整句排除
      if (isProcedural(text, names) || isRollcall(text, names)) return;
      const ctx = (idx ? sentences[idx - 1].text : "") + text;
      const people = personsIn(s, names);
      if (people.size === 0){
        // 规则③：责任在机构时单列，不再整句丢弃
        const org = orgSubject(text, names, rows);
        if (org) orgs.push(org);
        return;
      }
      const leaders = new Set(names.filter(nm => new RegExp(escRe(nm) + LEADER_RE).test(text)));
      const tm = TIME_RE.exec(text);
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
    return {names: p.names, count: sentences.length, cands: res.cands, low: res.low, orgs: res.orgs};
  }

  return {scan, _sliceScan: sliceScan};
})();

if (typeof module !== "undefined" && module.exports){
  module.exports = {A_CHANNEL, scanTranscript: (raw, rows) => A_CHANNEL.scan(raw, rows)};
}