/* 视频会议材料入口：判断拖进来的是什么，把能提取的先提取，把不能提取的说清楚。
 *
 * 浏览器能做的与不能做的分界：
 *   - 能：读字幕文件（.vtt/.srt）→ 转录；读录像的时长/分辨率/有无音轨 → 素材卡。
 *   - 不能：把视频音轨变成文字（本页不做语音识别，也没有密钥）。
 * 所以录像走「素材卡 + 转写路径」，绝不假装能出纪要。
 *
 * 纯函数部分（kindOf / formatDuration / videoCard）可在 node 里测；
 * probeVideo 需要真实 DOM，只在页面里用。
 */
var MEDIA = (function () {
  "use strict";

  var VERSION = "1.0";

  var SUB_EXT = ["vtt", "srt", "sbv", "ass", "ssa"];
  var VIDEO_EXT = ["mp4", "mov", "mkv", "webm", "m4v", "avi", "flv", "ts", "mpg", "mpeg", "wmv"];
  var AUDIO_EXT = ["m4a", "mp3", "wav", "aac", "ogg", "oga", "flac", "opus", "amr", "wma"];

  function extOf(name) {
    var n = String(name || "").toLowerCase().replace(/[?#].*$/, "");
    var i = n.lastIndexOf(".");
    return i < 0 ? "" : n.slice(i + 1);
  }

  // 页面里 SUBTITLE 与 MEDIA 同处一个脚本作用域；node 里 MEDIA 单独 require 时按需取
  function subtitleMod() {
    if (typeof SUBTITLE !== "undefined" && SUBTITLE && SUBTITLE.detect) return SUBTITLE;
    try {
      if (typeof require === "function") return require("./subtitle.js");
    } catch (e) {}
    return null;
  }

  // 扩展名 + 内容双判：扩展名认错（把 vtt 存成 txt）时，内容说了算
  function kindOf(name, text) {
    var ext = extOf(name);
    var t = String(text == null ? "" : text);
    var sub = subtitleMod();
    if (sub) {
      var d = sub.detect(t);
      if (d.is_subtitle) return { kind: "subtitle", ext: ext, format: d.format, cues: d.cues, by: "content" };
    }
    if (SUB_EXT.indexOf(ext) >= 0) return { kind: "subtitle", ext: ext, format: ext, cues: 0, by: "ext" };
    if (VIDEO_EXT.indexOf(ext) >= 0) return { kind: "video", ext: ext, by: "ext" };
    if (AUDIO_EXT.indexOf(ext) >= 0) return { kind: "audio", ext: ext, by: "ext" };
    return { kind: "text", ext: ext, by: "ext" };
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function formatDuration(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h ? (h + ":" + pad2(m) + ":" + pad2(ss)) : (pad2(m) + ":" + pad2(ss));
  }

  function formatBytes(n) {
    var v = Number(n) || 0;
    if (v >= 1024 * 1024 * 1024) return (v / 1073741824).toFixed(2) + " GB";
    if (v >= 1024 * 1024) return (v / 1048576).toFixed(1) + " MB";
    if (v >= 1024) return Math.round(v / 1024) + " KB";
    return v + " B";
  }

  // 录像素材卡：能读出什么就写什么，读不出的写「未探测」，不留空白让人猜
  function videoCard(meta) {
    var m = meta || {};
    var lines = [];
    lines.push("素材：" + (m.name || "未命名"));
    lines.push("类型：视频（" + (m.ext || "未知容器") + "）" + (m.size ? " · " + formatBytes(m.size) : ""));
    lines.push("时长：" + (m.duration ? formatDuration(m.duration) : "未读出"));
    lines.push("分辨率：" + (m.width && m.height ? (m.width + "×" + m.height) : "未读出"));
    lines.push("音轨：" + (m.hasAudio === true ? "有" : (m.hasAudio === false ? "未检测到" : "未探测")));
    lines.push("本页能做的：读出上面这些信息，不把音轨转成文字（浏览器里没有语音识别）。");
    lines.push("转文字的两条路：");
    lines.push("  1) 会议平台自带转写：腾讯会议 / 飞书妙记 / Zoom / Teams 里把这场会的「转写」「字幕」导出为 .vtt 或 .srt，再拖回本页，自动变成可质检的转录。");
    lines.push("  2) 录屏文件：用本机工具抽出音轨（本仓库的 mediakit 能力可做 mp4 → m4a），交给平台或会议 MCP 转写，把转写原文存成 .txt 再拖回本页。");
    lines.push("提示：有字幕就别转音频——字幕的时间码和说话人比转写更准，也不用等。");
    return lines.join("\n");
  }

  // 音频素材卡（录音文件同理：本页不识别，只读元信息）
  function audioCard(meta) {
    var m = meta || {};
    return [
      "素材：" + (m.name || "未命名"),
      "类型：音频（" + (m.ext || "未知容器") + "）" + (m.size ? " · " + formatBytes(m.size) : ""),
      "时长：" + (m.duration ? formatDuration(m.duration) : "未读出"),
      "本页不做语音识别。转文字请走会议平台（腾讯会议 / 飞书妙记）或会议 MCP，拿到转写原文 .txt 后拖回本页。"
    ].join("\n");
  }

  /* ---------------- DOM：读元信息（只在页面里调用） ---------------- */

  function probe(file, opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var kind = o.kind || (VIDEO_EXT.indexOf(extOf(file && file.name)) >= 0 ? "video" : "audio");
      var url = URL.createObjectURL(file);
      var el = document.createElement(kind === "video" ? "video" : "audio");
      var done = false;
      function finish(meta) {
        if (done) return;
        done = true;
        try { URL.revokeObjectURL(url); } catch (e) {}
        resolve(meta);
      }
      var timer = setTimeout(function () {
        // 读不出元信息（容器不支持、编码奇怪）时不要卡住：如实写“未读出”
        finish({ name: file.name, ext: extOf(file.name), size: file.size, duration: 0, width: 0, height: 0, hasAudio: null });
      }, o.timeout || 6000);
      el.preload = "metadata";
      el.muted = true;
      el.onloadedmetadata = function () {
        clearTimeout(timer);
        var meta = {
          name: file.name,
          ext: extOf(file.name),
          size: file.size,
          duration: el.duration && isFinite(el.duration) ? el.duration : 0,
          width: el.videoWidth || 0,
          height: el.videoHeight || 0,
          hasAudio: null
        };
        // 有音轨判定是尽力而为：各浏览器暴露的字段不同，读不到就保持 null（页面写“未探测”）
        if (kind === "video") {
          if (typeof el.mozHasAudio === "boolean") meta.hasAudio = el.mozHasAudio;
          else if (typeof el.webkitAudioDecodedByteCount === "number" && el.webkitAudioDecodedByteCount > 0) meta.hasAudio = true;
        } else {
          meta.hasAudio = true;
        }
        finish(meta);
      };
      el.onerror = function () {
        clearTimeout(timer);
        finish({ name: file.name, ext: extOf(file.name), size: file.size, duration: 0, width: 0, height: 0, hasAudio: null });
      };
      el.src = url;
    });
  }

  return {
    VERSION: VERSION,
    extOf: extOf,
    kindOf: kindOf,
    formatDuration: formatDuration,
    formatBytes: formatBytes,
    videoCard: videoCard,
    audioCard: audioCard,
    probe: probe
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = MEDIA;