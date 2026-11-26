/* 会议记录器 · recorder.js  v1.0
 *
 * 定位：给质检工作台补一段“采集”。开会时边录边记，散会后录音与文字原稿都在本机，
 * 文字成稿一键进入质检功能区，不用手工转格式。
 *
 * 三条硬边界（写死在这里，页面文案与测试都要对得上）：
 *   1. 不做语音识别。浏览器拿不到文字，录音只作原稿留档；文字由人边听边记，
 *      或由平台侧（会议 MCP）转写后再贴进来。
 *   2. 不联网。录音、存档、打包全在本机内存与 IndexedDB 内完成，无任何请求。
 *   3. 只改格式，不改内容。生成的时间码与说话人前缀取自录入时的真实时刻与人名，
 *      不补词、不纠错。
 *
 * 与质检端的契约：成稿第一行是「参会人：A、B」，其后每行「[mm:ss] 说话人：内容」。
 * 这正好是 qc_tools.parse_transcript 与 a_channel.scan 都能消费的形态（人工稿）；
 * 打点行不进成稿，只进原稿备份，避免把备注当成发言切句。
 */

var RECORDER = (function () {
  "use strict";

  var VERSION = "1.0";
  var DEFAULT_SPEAKER = "未标注";
  var MARK_PREFIX = "※";

  /* ---------------- 时间与文本 ---------------- */

  function pad2(n) {
    n = Math.floor(Math.abs(n));
    return (n < 10 ? "0" : "") + n;
  }

  // 秒 -> [HH:MM:SS]（清单要能一眼对上录音进度，所以带小时位）
  function stamp(secs) {
    var s = Math.max(0, Math.floor(Number(secs) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return "[" + pad2(h) + ":" + pad2(m) + ":" + pad2(s % 60) + "]";
  }

  // 秒 -> MM:SS（计时器与列表用短格式）
  function clock(secs) {
    var s = Math.max(0, Math.floor(Number(secs) || 0));
    return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
  }

  function clean(s) {
    return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\t ]+$/gm, "");
  }

  // 说话人去重，保留首次出现顺序；空说话人落到「未标注」
  function collectNames(turns, extra) {
    var seen = {};
    var out = [];
    function push(raw) {
      var nm = String(raw == null ? "" : raw).trim().replace(/[：:、，,]/g, "");
      if (!nm) return;
      if (seen[nm]) return;
      seen[nm] = 1;
      out.push(nm);
    }
    (extra || []).forEach(push);
    (turns || []).forEach(function (t) {
      if (t && t.speaker) push(t.speaker);
      else if (t && t.text) push(DEFAULT_SPEAKER);
    });
    return out;
  }

  function namesLine(names) {
    return "参会人：" + (names.length ? names.join("、") : DEFAULT_SPEAKER);
  }

  // 成稿：参会人行 + 逐条发言；打点行与空行不进成稿
  function buildScript(turns, extraNames) {
    var names = collectNames(turns, extraNames);
    var body = [];
    (turns || []).forEach(function (t) {
      if (!t || t.mark) return;
      var text = clean(t.text).replace(/\n+/g, " ").trim();
      if (!text) return;
      var sp = String(t.speaker == null ? "" : t.speaker).trim() || DEFAULT_SPEAKER;
      body.push(stamp(t.at) + " " + sp + "：" + text);
    });
    return namesLine(names) + "\n\n" + body.join("\n");
  }

  // 换行提交的单条文本也要能被质检切句：多行压成一句，句间补句号
  function oneLine(text) {
    return clean(text).split(/\n+/).map(function (s) {
      return s.trim();
    }).filter(Boolean).join("。").replace(/。{2,}/g, "。");
  }

  // 预览追加：先同步参会人行，再把新行接到末尾。保留用户手动改过的正文。
  function appendLine(previewText, turns, turn) {
    var names = collectNames(turns);
    var head = namesLine(names);
    var rest = clean(previewText);
    var nameRe = /^参会人[：:].*(\n|$)/;
    if (nameRe.test(rest)) rest = rest.replace(nameRe, "").replace(/^\n+/, "");
    var line;
    if (turn && turn.mark) {
      var note = String(turn.mark).trim();
      line = stamp(turn.at) + " " + MARK_PREFIX + (note ? " " + note : "");
    } else if (turn) {
      var sp = String(turn.speaker == null ? "" : turn.speaker).trim() || DEFAULT_SPEAKER;
      line = stamp(turn.at) + " " + sp + "：" + clean(turn.text).replace(/\n+/g, " ").trim();
    } else {
      line = "";
    }
    var body = rest.replace(/\s+$/, "");
    return head + "\n\n" + (line ? (body ? body + "\n" + line : line) : body);
  }

  /* ---------------- 原稿备份文本 ---------------- */

  function two(n) {
    return pad2(n);
  }

  function dateText(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) +
      " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  function fileStamp(ts) {
    var d = new Date(ts || Date.now());
    return "" + d.getFullYear() + two(d.getMonth() + 1) + two(d.getDate()) + "-" + two(d.getHours()) + two(d.getMinutes());
  }

  // 原稿备份 = 元信息头 + 完整正文（含打点）。元信息行不带「姓名：」结构，
  // 解析端会跳过，因此这份文件既能给人看，也能直接再送进质检。
  function buildBackup(rec) {
    rec = rec || {};
    var turns = rec.turns || [];
    var names = collectNames(turns, rec.names);
    var head = [
      "# 会议记录：" + (rec.title || "未命名会议"),
      "# 记录时间：" + dateText(rec.createdAt),
      "# 时长：" + clock(rec.duration || 0),
      "# 说话人：" + (names.length ? names.join("、") : DEFAULT_SPEAKER),
      "# 记录方式：" + (rec.audio ? "录音 + 速记（录音随包留档）" : "纯文字录入"),
      "# 说明：本文件是原稿备份，时间码与说话人前缀照录入原样保留；不做语音识别，不补词不改字。"
    ];
    var body = [];
    turns.forEach(function (t) {
      if (!t) return;
      if (t.mark) {
        var note = String(t.mark).trim();
        body.push(stamp(t.at) + " " + MARK_PREFIX + (note ? " " + note : ""));
        return;
      }
      var text = clean(t.text).replace(/\n+/g, " ").trim();
      if (!text) return;
      var sp = String(t.speaker == null ? "" : t.speaker).trim() || DEFAULT_SPEAKER;
      body.push(stamp(t.at) + " " + sp + "：" + text);
    });
    return head.join("\n") + "\n\n" + namesLine(names) + "\n\n" + body.join("\n") + "\n";
  }

  function buildMeta(rec) {
    rec = rec || {};
    var names = collectNames(rec.turns, rec.names);
    return JSON.stringify({
      app: "会议待办质检器 · 会议记录器",
      version: VERSION,
      title: rec.title || "未命名会议",
      createdAt: rec.createdAt || Date.now(),
      createdAtText: dateText(rec.createdAt),
      durationSec: Math.floor(rec.duration || 0),
      speakerCount: names.length,
      speakers: names,
      turns: (rec.turns || []).length,
      marks: (rec.turns || []).filter(function (t) { return t && t.mark; }).length,
      hasAudio: !!rec.audio,
      audioType: rec.audioType || "",
      asr: false
    }, null, 2);
  }

  /* ---------------- ZIP（store，无压缩） ---------------- */

  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(str));
    var s = unescape(encodeURIComponent(String(str)));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }

  function dosTime(ts) {
    var d = new Date(ts || 0);
    var y = d.getFullYear();
    if (!(y >= 1980)) return { time: 0, date: 33 }; // 1980-01-01 00:00
    return {
      time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
      date: (((y - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
    };
  }

  function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
  function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

  // files: [{name, data}]，data 可以是字符串或 Uint8Array。返回 Uint8Array。
  function zip(files, mtime) {
    var dt = dosTime(mtime);
    var chunks = [];
    var central = [];
    var offset = 0;
    (files || []).forEach(function (f) {
      var nameBytes = utf8(f.name);
      var data = typeof f.data === "string" ? utf8(f.data) : (f.data || new Uint8Array(0));
      var crc = crc32(data);
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0)
      );
      var localBytes = new Uint8Array(local.length + nameBytes.length);
      localBytes.set(local, 0);
      localBytes.set(nameBytes, local.length);
      chunks.push(localBytes, data);
      var cen = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset)
      );
      var cenBytes = new Uint8Array(cen.length + nameBytes.length);
      cenBytes.set(cen, 0);
      cenBytes.set(nameBytes, cen.length);
      central.push(cenBytes);
      offset += localBytes.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new Uint8Array([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cdSize), u32(offset), u16(0)
    ));
    var total = offset + cdSize + end.length;
    var out = new Uint8Array(total);
    var p = 0;
    chunks.concat(central, [end]).forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  /* ---------------- 本地存档（IndexedDB / 内存） ---------------- */

  function createMemoryAdapter() {
    var rows = [];
    return {
      put: function (rec) {
        var i = rows.findIndex(function (r) { return r.id === rec.id; });
        if (i >= 0) rows[i] = rec; else rows.push(rec);
        return Promise.resolve(rec.id);
      },
      all: function () { return Promise.resolve(rows.slice()); },
      get: function (id) { return Promise.resolve(rows.filter(function (r) { return r.id === id; })[0] || null); },
      del: function (id) {
        rows = rows.filter(function (r) { return r.id !== id; });
        return Promise.resolve(true);
      }
    };
  }

  function idbAdapter(name, storeName) {
    var dbp = null;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (resolve, reject) {
        var req = indexedDB.open(name, 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "id" });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      return dbp;
    }
    function run(mode, fn) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(storeName, mode);
          var st = tx.objectStore(storeName);
          var req = fn(st);
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error); };
        });
      });
    }
    return {
      put: function (rec) { return run("readwrite", function (st) { return st.put(rec); }); },
      all: function () { return run("readonly", function (st) { return st.getAll(); }); },
      get: function (id) { return run("readonly", function (st) { return st.get(id); }); },
      del: function (id) { return run("readwrite", function (st) { return st["delete"](id); }); }
    };
  }

  function createStore(adapter) {
    function sortDesc(rows) {
      return rows.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    }
    return {
      save: function (rec) {
        rec.savedAt = Date.now();
        return adapter.put(rec);
      },
      list: function () { return adapter.all().then(sortDesc); },
      get: function (id) { return adapter.get(id); },
      remove: function (id) { return adapter.del(id); }
    };
  }

  function newId() {
    return "rec-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- 录音机（浏览器） ---------------- */

  function makeRecorder(hooks) {
    hooks = hooks || {};
    var supported = typeof navigator !== "undefined" &&
      navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window !== "undefined" && typeof window.MediaRecorder !== "undefined";
    var stream = null, mr = null, chunks = [], startedAt = 0, pausedMs = 0, pauseAt = 0;
    var timer = null, meterTimer = null, audioCtx = null, analyser = null, raf = null;

    function now() { return Date.now(); }

    function elapsed() {
      if (!startedAt) return 0;
      var end = pausedMs ? pauseAt : now();
      return Math.max(0, Math.floor((end - startedAt - pausedMs) / 1000));
    }

    function stopMeter() {
      if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf);
      raf = null;
      if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
      if (audioCtx && audioCtx.close) audioCtx.close().catch(function () {});
      audioCtx = null; analyser = null;
    }

    function cleanup() {
      if (timer) { clearInterval(timer); timer = null; }
      stopMeter();
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      mr = null;
    }

    function startMeter(s) {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audioCtx = new Ctx();
        var src = audioCtx.createMediaStreamSource(s);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        var buf = new Uint8Array(analyser.frequencyBinCount);
        var tick = function () {
          if (!analyser) return;
          analyser.getByteTimeDomainData(buf);
          var sum = 0;
          for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
          var level = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
          if (hooks.onLevel) hooks.onLevel(level);
          raf = window.requestAnimationFrame(tick);
        };
        tick();
      } catch (e) { /* 电平表只是附加，失败不影响录音 */ }
    }

    function pickMime() {
      var list = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      for (var i = 0; i < list.length; i++) {
        if (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(list[i])) return list[i];
      }
      return "";
    }

    function start() {
      if (!supported) return Promise.reject(new Error("当前浏览器不支持录音"));
      if (mr) return Promise.resolve(false);
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        var mime = pickMime();
        mr = mime ? new window.MediaRecorder(s, { mimeType: mime }) : new window.MediaRecorder(s);
        chunks = [];
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mr.start(1000);
        startedAt = now(); pausedMs = 0; pauseAt = 0;
        if (timer) clearInterval(timer);
        timer = setInterval(function () { if (hooks.onTick) hooks.onTick(elapsed()); }, 200);
        startMeter(s);
        if (hooks.onState) hooks.onState("recording");
        return true;
      });
    }

    function pause() {
      if (!mr || mr.state !== "recording") return false;
      mr.pause();
      pauseAt = now();
      if (hooks.onState) hooks.onState("paused");
      return true;
    }

    function resume() {
      if (!mr || mr.state !== "paused") return false;
      mr.resume();
      pausedMs += now() - pauseAt;
      pauseAt = 0;
      if (hooks.onState) hooks.onState("recording");
      return true;
    }

    function stop() {
      return new Promise(function (resolve) {
        if (!mr) return resolve(null);
        var duration = elapsed();
        var mime = mr.mimeType || "";
        var finished = mr;
        mr.onstop = function () {
          var type = (finished.mimeType || mime || "audio/webm").split(";")[0];
          var blob = chunks.length ? new Blob(chunks, { type: type }) : null;
          cleanup();
          if (hooks.onState) hooks.onState("stopped");
          if (hooks.onTick) hooks.onTick(duration);
          resolve(blob ? { blob: blob, type: type, duration: duration } : null);
        };
        try { finished.stop(); } catch (e) { cleanup(); resolve(null); }
      });
    }

    return {
      supported: supported,
      start: start,
      pause: pause,
      resume: resume,
      stop: stop,
      elapsed: elapsed,
      isRecording: function () { return !!mr && mr.state === "recording"; },
      isPaused: function () { return !!mr && mr.state === "paused"; }
    };
  }

  /* ---------------- 页面挂载 ---------------- */

  function mount(opts) {
    opts = opts || {};
    var $ = function (id) { return document.getElementById(id); };
    var el = {
      title: $("rec-title"), start: $("rec-start"), pause: $("rec-pause"), stop: $("rec-stop"),
      time: $("rec-time"), meter: $("rec-meter"), note: $("rec-note"),
      speaker: $("rec-speaker"), line: $("rec-line"), say: $("rec-say"),
      mark: $("rec-mark"), markNote: $("rec-mark-note"),
      preview: $("rec-preview"), status: $("rec-status"),
      send: $("rec-send"), save: $("rec-save"), dlTxt: $("rec-dl-txt"), dlAudio: $("rec-dl-audio"),
      dlZip: $("rec-dl-zip"), list: $("rec-list"), load: $("rec-load"), del: $("rec-del"),
      clear: $("rec-clear"), unsupported: $("rec-unsupported")
    };
    if (!el.preview) return null;      // 页面没这块就安静退出，不影响其它功能

    // 电平条按需生成，页面里只留容器，避免手写一堆空节点
    if (el.meter && !el.meter.children.length) {
      var segs = "", n = 0;
      for (n = 0; n < 20; n++) segs += "<i></i>";
      el.meter.innerHTML = segs;
    }

    var store = null;
    try { store = createStore(idbAdapter("mtr_records", "recs")); } catch (e) { store = createStore(createMemoryAdapter()); }

    var state = { id: newId(), title: "", createdAt: Date.now(), turns: [], duration: 0, audio: null, audioType: "" };
    var recordingStarted = false;

    var rec = makeRecorder({
      onTick: function (secs) {
        if (el.time) el.time.textContent = clock(secs);
      },
      onLevel: function (lvl) { paintLevel(lvl); },
      onState: function (s) {
        var map = { recording: "录音中", paused: "已暂停", stopped: "已结束" };
        setStatus(map[s] || "");
        if (el.start) el.start.disabled = (s === "recording" || s === "paused");
        if (el.pause) {
          el.pause.disabled = (s === "stopped");
          el.pause.textContent = (s === "paused") ? "继续" : "暂停";
        }
        if (el.stop) el.stop.disabled = (s === "stopped");
        document.body.classList.toggle("rec-on", s === "recording");
        if (s === "stopped") paintLevel(0);
      }
    });

    if (!rec.supported) {
      if (el.unsupported) el.unsupported.hidden = false;
      if (el.start) el.start.disabled = true;
      if (el.pause) el.pause.disabled = true;
      if (el.stop) el.stop.disabled = true;
    }

    function setStatus(text) {
      if (el.status) el.status.textContent = text || "";
    }

    function paintLevel(lvl) {
      if (!el.meter) return;
      var segs = el.meter.children;
      var on = Math.round((lvl || 0) * segs.length);
      for (var i = 0; i < segs.length; i++) {
        segs[i].className = (i < on) ? (i > segs.length - 4 ? "hi" : "on") : "";
      }
    }

    function defaultTitle() {
      var d = new Date();
      return "会议记录 " + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + two(d.getMinutes());
    }

    function title() {
      var t = el.title && el.title.value.trim();
      return t || defaultTitle();
    }

    function speaker() {
      var s = el.speaker && el.speaker.value.trim();
      return s ? s.replace(/[：:]/g, "") : "";
    }

    function refreshSpeakers() {
      var names = collectNames(state.turns);
      if (!el.speaker) return;
      var dl = $("rec-speakers");
      if (dl) {
        dl.innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '"></option>'; }).join("");
      }
    }

    function esc(s) {
      return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }

    function append(turn) {
      if (!turn) return;
      state.turns.push(turn);
      if (el.preview) el.preview.value = appendLine(el.preview.value, state.turns, turn);
      refreshSpeakers();
    }

    function currentAt() {
      return recordingStarted ? rec.elapsed() : null;
    }

    function submitLine() {
      if (!el.line) return;
      var text = oneLine(el.line.value);
      if (!text) { el.line.focus(); return; }
      var at = currentAt();
      append({ at: at == null ? state.duration : at, speaker: speaker(), text: text });
      el.line.value = "";
      el.line.focus();
      setStatus("记下 1 条（共 " + state.turns.filter(function (t) { return !t.mark; }).length + " 条）");
    }

    if (el.start) el.start.addEventListener("click", function () {
      el.start.disabled = true;
      rec.start().then(function () {
        recordingStarted = true;
        if (!state.title) state.title = title();
        setStatus("录音中——录音只在本机，结束后点「保存原稿」才会落档");
      }).catch(function (err) {
        el.start.disabled = false;
        setStatus("无法开始录音：" + (err && err.message ? err.message : "浏览器未授权麦克风") +
          "。可以只用下面的文字录入，功能不受影响。");
      });
    });

    if (el.pause) el.pause.addEventListener("click", function () {
      if (rec.isPaused()) rec.resume(); else rec.pause();
    });

    if (el.stop) el.stop.addEventListener("click", function () {
      rec.stop().then(function (out) {
        if (!out) return;
        state.duration = out.duration || state.duration;
        state.audio = out.blob;
        state.audioType = out.type;
        setStatus("录音结束：" + clock(state.duration) + "，音频已就绪（点「下载录音」或「保存原稿」留档）");
      });
    });

    if (el.say) el.say.addEventListener("click", submitLine);
    if (el.line) el.line.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        submitLine();
      }
    });
    if (el.speaker) el.speaker.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); if (el.line) el.line.focus(); }
    });

    if (el.mark) el.mark.addEventListener("click", function () {
      var note = el.markNote ? el.markNote.value.trim() : "";
      var at = currentAt();
      append({ at: at == null ? state.duration : at, mark: note || "打点" });
      if (el.markNote) el.markNote.value = "";
      setStatus("已打点" + (note ? "：" + note : ""));
    });

    function download(name, data, mime) {
      var blob = data instanceof Blob ? data : new Blob([data], { type: mime || "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    function snapshot() {
      return {
        id: state.id,
        title: title(),
        createdAt: state.createdAt,
        duration: state.duration,
        turns: state.turns.slice(),
        audio: state.audio,
        audioType: state.audioType,
        text: el.preview ? el.preview.value : buildScript(state.turns)
      };
    }

    if (el.send) el.send.addEventListener("click", function () {
      var text = el.preview ? el.preview.value : buildScript(state.turns);
      if (!text.trim()) { setStatus("还没有内容可送"); return; }
      var tr = opts.transcriptEl || $("tr-input");
      if (tr) {
        tr.value = text;
        tr.dispatchEvent(new Event("input", { bubbles: true }));
      }
      var run = $("run");
      if (run) run.click();
      setStatus("已送入「会议转录」并跑了质检；录音与文字原稿点「保存原稿」可留档");
    });

    if (el.save) el.save.addEventListener("click", function () {
      var s = snapshot();
      state.title = s.title;
      store.save({
        id: s.id, title: s.title, createdAt: s.createdAt, savedAt: Date.now(),
        duration: s.duration, turns: s.turns, text: s.text,
        audio: s.audio, audioType: s.audioType
      }).then(function () {
        setStatus("原稿已存到本机（" + (s.audio ? "文字 + 录音" : "仅文字") + "），可在下方列表载入");
        return refreshList();
      }).catch(function (err) {
        setStatus("存档失败：" + (err && err.message ? err.message : "浏览器拒绝写入"));
      });
    });

    if (el.dlTxt) el.dlTxt.addEventListener("click", function () {
      download("原稿_" + fileStamp(state.createdAt) + ".txt", buildBackup(snapshot()), "text/plain;charset=utf-8");
    });

    if (el.dlAudio) el.dlAudio.addEventListener("click", function () {
      if (!state.audio) { setStatus("还没有录音可下载——先点「开始录音」"); return; }
      var ext = state.audioType.indexOf("mp4") >= 0 ? "m4a" : "webm";
      download("录音_" + fileStamp(state.createdAt) + "." + ext, state.audio, state.audioType);
    });

    if (el.dlZip) el.dlZip.addEventListener("click", function () {
      var s = snapshot();
      var files = [
        { name: "原稿.txt", data: buildBackup(s) },
        { name: "meta.json", data: buildMeta(s) }
      ];
      if (s.audio) files.push({ name: "录音." + (s.audioType.indexOf("mp4") >= 0 ? "m4a" : "webm"), data: s.audio });
      var bytes = zip(files, s.createdAt);
      download("会议原稿_" + fileStamp(s.createdAt) + ".zip", bytes, "application/zip");
      setStatus("备份包已生成：" + files.length + " 个文件");
    });

    function refreshList() {
      if (!el.list) return;
      return store.list().then(function (rows) {
        el.list.innerHTML = rows.length
          ? rows.map(function (r) {
            return '<option value="' + esc(r.id) + '">' + esc(r.title || "未命名") + " · " +
              esc(dateText(r.createdAt)) + " · " + clock(r.duration || 0) +
              (r.audio ? " · 含录音" : "") + "</option>";
          }).join("")
          : '<option value="">本机还没有存档</option>';
        if (el.del) el.del.disabled = !rows.length;
        if (el.load) el.load.disabled = !rows.length;
        return rows;
      }).catch(function () { return []; });
    }

    if (el.load) el.load.addEventListener("click", function () {
      var id = el.list && el.list.value;
      if (!id) { setStatus("先在上面选一份存档"); return; }
      store.get(id).then(function (r) {
        if (!r) { setStatus("这份存档读不出来"); return; }
        state.id = r.id || newId();
        state.title = r.title || "";
        state.createdAt = r.createdAt || Date.now();
        state.duration = r.duration || 0;
        state.turns = (r.turns || []).slice();
        state.audio = r.audio || null;
        state.audioType = r.audioType || "";
        if (el.title) el.title.value = state.title;
        if (el.time) el.time.textContent = clock(state.duration);
        if (el.preview) el.preview.value = r.text || buildScript(state.turns);
        refreshSpeakers();
        setStatus("已载入存档：" + (r.title || "未命名") + (state.audio ? "（含录音，可下载）" : ""));
      });
    });

    if (el.del) el.del.addEventListener("click", function () {
      var id = el.list && el.list.value;
      if (!id) { setStatus("先在上面选一份存档"); return; }
      store.remove(id).then(function () {
        setStatus("已删除这份存档（只删本机副本）");
        return refreshList();
      });
    });

    if (el.clear) el.clear.addEventListener("click", function () {
      state = { id: newId(), title: "", createdAt: Date.now(), turns: [], duration: 0, audio: null, audioType: "" };
      recordingStarted = false;
      if (el.title) el.title.value = "";
      if (el.time) el.time.textContent = "00:00";
      if (el.line) el.line.value = "";
      if (el.speaker) el.speaker.value = "";
      if (el.markNote) el.markNote.value = "";
      if (el.preview) el.preview.value = "";
      setStatus("已清空当前记录");
      refreshSpeakers();
    });

    // 首次进来：给一个占位会议名，并把存档列表拉出来
    if (el.title && !el.title.value) el.title.placeholder = defaultTitle();
    refreshList();
    paintLevel(0);

    return {
      state: function () { return state; },
      append: append,
      submitLine: submitLine,
      script: function () { return buildScript(state.turns); }
    };
  }

  return {
    VERSION: VERSION,
    stamp: stamp,
    clock: clock,
    oneLine: oneLine,
    collectNames: collectNames,
    namesLine: namesLine,
    buildScript: buildScript,
    appendLine: appendLine,
    buildBackup: buildBackup,
    buildMeta: buildMeta,
    crc32: crc32,
    zip: zip,
    createMemoryAdapter: createMemoryAdapter,
    createStore: createStore,
    newId: newId,
    mount: mount
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = RECORDER;