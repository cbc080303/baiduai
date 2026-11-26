/* 字幕文件解析：把视频会议（腾讯会议 / 飞书妙记 / Zoom / Teams / 录屏工具）导出的
 * .vtt / .srt 变成质检能直接吃的转录。
 *
 * 为什么单独一个模块：视频会议真正能在浏览器里“提取出内容”的载体就是字幕文件——
 * 视频音轨浏览器解不出文字（本页不做语音识别），字幕却是原原本本的会议内容。
 *
 * 只做格式转换，不改一字词：时间码统一成 [HH:MM:SS]，说话人保留原标签，
 * 滚动字幕（说话中反复重发的同一句）按前缀重叠去重，同人连续 cue 合并成一轮发言。
 *
 * 纯函数、零依赖，可在 node 里直接 require 测。
 */
var SUBTITLE = (function () {
  "use strict";

  var VERSION = "1.0";

  // SRT 与 VTT 的时间码写法不同：00:00:01,000 / 00:00:01.000 / 00:01.000（VTT 允许省小时）
  var TIME_RE = /(\d{1,2}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?/g;
  var ARROW_RE = /-->/;

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function clock(sec) {
    var s = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return pad2(h) + ":" + pad2(m) + ":" + pad2(ss);
  }

  // "01:02:03.400" / "1:02,4" / "02:03.000" → 秒
  function toSeconds(stamp) {
    var t = String(stamp || "").trim();
    if (!t) return 0;
    var parts = t.replace(",", ".").split(":");
    var sec = 0, i;
    for (i = 0; i < parts.length; i++) {
      sec = sec * 60 + (parseFloat(parts[i]) || 0);
    }
    return Math.round(sec * 1000) / 1000;
  }

  function cleanInline(s) {
    var t = String(s == null ? "" : s);
    t = t.replace(/\r/g, "");
    // VTT 的 cue 设置（align:start position:10% line:0）与卡拉OK 时间标签
    t = t.replace(/<(\d[\d:.,]*)\>/g, "");
    t = t.replace(/<[^>]+>/g, "");          // <c>、<i>、<b>、<u>、<v 名字> 等样式与说话人标签另行提取
    t = t.replace(/\{[^}]*\}/g, "");
    t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    return t.trim();
  }

  // 说话人在 <v 张三> 里
  function speakerFromTag(line) {
    var m = String(line).match(/<v(?:\.[^\s>]*)?\s+([^>]+)>/i);
    return m ? cleanInline(m[1]).replace(/^["“]|["”]$/g, "") : "";
  }

  // 说话人在正文前缀里：张三： / 张三: / 张三 - / [张三] 都见过
  function speakerFromPrefix(text) {
    var t = String(text || "").trim();
    var m = t.match(/^([^\s：:，。；\-\[\]]{1,12})\s*[：:]\s*(.+)$/);
    if (m && m[2] && !/^\d/.test(m[1])) return { speaker: m[1], text: m[2].trim() };
    var b = t.match(/^\[([^\]]{1,12})\]\s*(.+)$/);
    if (b && b[2]) return { speaker: b[1], text: b[2].trim() };
    return null;
  }

  function isCjk(ch) {
    var c = String(ch || "").charCodeAt(0);
    return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
  }

  // cue 内多行：中文直接接，西文补空格，避免 “今天 讨论” 这种断词
  function joinLines(lines) {
    var out = "";
    (lines || []).forEach(function (line) {
      var t = cleanInline(line);
      if (!t) return;
      if (!out) { out = t; return; }
      var prev = out.charAt(out.length - 1);
      out += (isCjk(prev) || isCjk(t.charAt(0))) ? t : " " + t;
    });
    return out;
  }

  // 解析成 cue 列表：[{at, end, speaker, text}]
  function cues(raw) {
    var text = String(raw == null ? "" : raw).replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
    var blocks = text.split(/\n{2,}/);
    var out = [];
    var idx = 0;
    blocks.forEach(function (block) {
      var lines = block.split("\n").filter(function (l) { return l.trim().length; });
      if (!lines.length) return;
      var head = lines[0].trim();
      if (/^WEBVTT/i.test(head) || /^NOTE\b/i.test(head) || /^STYLE\b/i.test(head) || /^REGION\b/i.test(head)) {
        // 头块里可能紧跟着第一条 cue，取到箭头行再继续
        if (!ARROW_RE.test(block)) return;
      }
      // 找到时间码行（SRT 的序号行会被跳过）
      var at = -1, i;
      for (i = 0; i < lines.length; i++) if (ARROW_RE.test(lines[i])) { at = i; break; }
      if (at < 0) return;
      var stamps = lines[at].match(TIME_RE) || [];
      if (!stamps.length) return;
      var start = toSeconds(stamps[0]);
      var end = stamps.length > 1 ? toSeconds(stamps[1]) : start;
      var body = lines.slice(at + 1);
      var sp = "";
      body.forEach(function (l) {
        if (!sp) sp = speakerFromTag(l);
      });
      var txt = joinLines(body);
      if (!txt) return;
      if (!sp) {
        var p = speakerFromPrefix(txt);
        if (p) { sp = p.speaker; txt = p.text; }
      }
      idx += 1;
      out.push({ index: idx, at: start, end: end, speaker: sp || "", text: txt });
    });
    return out;
  }

  // 滚动字幕去重：新 cue 把上一句整段包含进来（实时字幕的常见输出）时，替换而不是叠加
  function mergeRolling(list) {
    var out = [], dropped = 0;
    (list || []).forEach(function (cue) {
      var prev = out[out.length - 1];
      if (!prev) { out.push(cue); return; }
      var a = prev.text, b = cue.text;
      // 实时字幕常有一侧不带说话人标签（样式块里只有 <c>）：一侧为空时视为同一人，
      // 否则同一句话会被拆成两个“人”，还会把重复文本喂进依据回查。
      var compatible = !prev.speaker || !cue.speaker || prev.speaker === cue.speaker;
      if (a === b && compatible) {
        if (!prev.speaker) prev.speaker = cue.speaker;
        prev.end = cue.end;
        dropped += 1;
        return;                                                     // 完全重复
      }
      if (b.length > a.length && b.indexOf(a) === 0 && compatible) {
        prev.text = b;                                              // 同一句越滚越长
        prev.end = cue.end;
        if (!prev.speaker) prev.speaker = cue.speaker;
        dropped += 1;
        return;
      }
      if (a.length > b.length && a.indexOf(b) === 0 && compatible) { dropped += 1; return; }  // 短的回声
      out.push(cue);
    });
    return { cues: out, dropped: dropped };
  }

  // 同人连续的 cue 合成一段发言（质检按“轮”看，碎句会让切句与人物归属更难判）
  function mergeSpeakerRuns(list) {
    var out = [];
    (list || []).forEach(function (cue) {
      var prev = out[out.length - 1];
      var sp = cue.speaker || "";
      if (prev && (prev.speaker || "") === sp && cue.at - prev.end <= 3) {
        prev.text = joinLines([prev.text, cue.text]);
        prev.end = cue.end;
        prev.merged = (prev.merged || 1) + 1;
        return;
      }
      out.push({ at: cue.at, end: cue.end, speaker: sp, text: cue.text });
    });
    return out;
  }

  function namesOf(turns) {
    var seen = {}, out = [];
    (turns || []).forEach(function (t) {
      var n = String(t.speaker || "").trim();
      if (!n || seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    return out;
  }

  // 主入口：字幕文本 → {turns, transcript, names, ...}
  function parse(raw) {
    var list = cues(raw);
    if (!list.length) {
      return { ok: false, turns: [], transcript: "", names: [], cues: 0, dropped: 0,
        reason: "没读到字幕块：VTT/SRT 需要有「时间码 --> 时间码」的行。" };
    }
    var rolled = mergeRolling(list);
    var turns = mergeSpeakerRuns(rolled.cues);
    var names = namesOf(turns);
    var unlabeled = turns.filter(function (t) { return !t.speaker; }).length;
    // 没有说话人标签时统一落到「说话人1」：qc_tools 的名单反推会忽略这类枚举标签，
    // 不会把一个占位名当成真实负责人。
    turns = turns.map(function (t) {
      return { at: t.at, speaker: t.speaker || "说话人1", text: t.text };
    });
    var all = namesOf(turns);
    var body = turns.map(function (t) {
      return "[" + clock(t.at) + "] " + t.speaker + "：" + t.text;
    }).join("\n");
    var head = "参会人：" + (all.length ? all.join("、") : "说话人1");
    var transcript = head + "\n\n" + body;
    return {
      ok: true,
      turns: turns,
      transcript: transcript,
      names: all,
      cues: list.length,
      merged: rolled.cues.length,
      dropped: rolled.dropped,
      unlabeled: unlabeled,
      chars: transcript.replace(/\s/g, "").length,
      duration: turns.length ? turns[turns.length - 1].at : 0
    };
  }

  // 内容嗅探：不靠扩展名，只看结构
  function detect(raw) {
    var t = String(raw == null ? "" : raw).replace(/^\ufeff/, "");
    if (!t.trim()) return { is_subtitle: false, format: "", cues: 0 };
    var hasArrow = /\d{1,2}:\d{2}(?::\d{2})?\s*[,.]?\d{0,3}\s*-->\s*\d{1,2}:\d{2}/.test(t);
    var format = /^\s*WEBVTT/.test(t) ? "vtt" : (hasArrow ? "srt" : "");
    var n = (t.match(/-->/g) || []).length;
    return { is_subtitle: !!format, format: format, cues: n };
  }

  return {
    VERSION: VERSION,
    clock: clock,
    toSeconds: toSeconds,
    cues: cues,
    parse: parse,
    detect: detect,
    mergeRolling: mergeRolling,
    mergeSpeakerRuns: mergeSpeakerRuns
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = SUBTITLE;