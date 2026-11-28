/* 会议记录器 · recorder.js  v1.0
 *
 * 定位：给质检工作台补一段“采集”。开会时边录边记，散会后录音与文字原稿都在本机，
 * 文字成稿一键进入质检功能区，不用手工转格式。
 *
 * 三条硬边界（写死在这里，页面文案与测试都要对得上）：
 *   1. 录音本身不做语音识别；识别是**可选项**（asr.js）：默认只走 `processLocally`
 *      端上识别，音频不出本机；只有用户显式把「识别方式」改成云端时才联网。
 *      识别不区分说话人——浏览器端没有声纹分离，换人由人点一下。
 *   2. 质检、存档、打包不联网：录音、文字、存档与本页 zip 都在本机完成。
 *   3. 只改格式，不改内容。时间码与说话人前缀取自录入时的真实时刻与人名，
 *      识别结果照录，不补词、不纠错。
 *
 * 与质检端的契约：成稿第一行是「参会人：A、B」，其后每行「[mm:ss] 说话人：内容」。
 * 这正好是 qc_tools.parse_transcript 与 a_channel.scan 都能消费的形态（人工稿）；
 * 打点行不进成稿，只进原稿备份，避免把备注当成发言切句。
 */

var RECORDER = (function () {
  "use strict";

  var VERSION = "1.2";
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
  function lineOf(turn) {
    if (!turn) return "";
    if (turn.mark) {
      var note = String(turn.mark).trim();
      return stamp(turn.at) + " " + MARK_PREFIX + (note ? " " + note : "");
    }
    var sp = String(turn.speaker == null ? "" : turn.speaker).trim() || DEFAULT_SPEAKER;
    return stamp(turn.at) + " " + sp + "：" + clean(turn.text).replace(/\n+/g, " ").trim();
  }

  // 成稿开头固定是「参会人：…」一行；取正文时先剥掉它，避免追加时重复
  function stripNames(text) {
    var rest = clean(text);
    var nameRe = /^参会人[：:].*(\n|$)/;
    if (nameRe.test(rest)) rest = rest.replace(nameRe, "").replace(/^\n+/, "");
    return rest.replace(/\s+$/, "");
  }

  // 预览追加：先同步参会人行，再把新行接到末尾。保留用户手动改过的正文。
  function appendLine(previewText, turns, turn) {
    var head = namesLine(collectNames(turns));
    var body = stripNames(previewText);
    var line = lineOf(turn);
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

  // 会议名可能带斜杠、冒号、星号、问号、引号、尖括号、竖线或换行：
  // 直接拼进文件名会让浏览器下载失败，拼进备份头会毁掉结构。这里按字符码过滤，避免转义歧义。
  var BAD_NAME_CODES = [47, 92, 58, 42, 63, 34, 60, 62, 124];
  function plainFileName(name) {
    var t = String(name == null ? "" : name), out = "", i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charCodeAt(i);
      out += (BAD_NAME_CODES.indexOf(c) >= 0 || c < 32) ? "_" : t.charAt(i);
    }
    return out || "download";
  }
  function safeName(s, fallback) {
    var t = String(s == null ? "" : s), out = "", i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charCodeAt(i);
      if (c === 10 || c === 13 || c === 9) { out += " "; continue; }
      out += (BAD_NAME_CODES.indexOf(c) >= 0) ? "_" : t.charAt(i);
    }
    out = out.split(" ").filter(function (x) { return x.length; }).join(" ").trim();
    while (out.charAt(0) === ".") out = out.slice(1);
    return out ? out.slice(0, 60) : (fallback || "未命名会议");
  }

  // 原稿备份 = 元信息头 + 完整正文（含打点）。元信息行不带「姓名：」结构，
  // 解析端会跳过，因此这份文件既能给人看，也能直接再送进质检。
  function buildBackup(rec) {
    rec = rec || {};
    var turns = rec.turns || [];
    var names = collectNames(turns, rec.names);
    var head = [
      "# 会议记录：" + safeName(rec.title, "未命名会议"),
      "# 记录时间：" + dateText(rec.createdAt),
      "# 时长：" + clock(rec.duration || 0),
      "# 说话人：" + (names.length ? names.join("、") : DEFAULT_SPEAKER),
      "# 记录方式：" + (rec.audio ? "录音 + 速记（录音随包留档）" : "纯文字录入") +
        (rec.asr && rec.asr.used ? "；其中含语音识别转写（" + (rec.asr.mode === "remote" ? "云端识别" : "端上识别") +
          (rec.asr.lang ? "，" + rec.asr.lang : "") + "；识别只出文字，说话人由录入时手动切换）" : ""),
      "# 说明：本文件是原稿备份，时间码与说话人前缀照录入原样保留；识别结果照录，不补词、不改字。"
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
      title: safeName(rec.title, "未命名会议"),
      createdAt: rec.createdAt || Date.now(),
      createdAtText: dateText(rec.createdAt),
      durationSec: Math.floor(rec.duration || 0),
      speakerCount: names.length,
      speakers: names,
      turns: (rec.turns || []).length,
      marks: (rec.turns || []).filter(function (t) { return t && t.mark; }).length,
      hasAudio: !!rec.audio,
      audioType: rec.audioType || "",
      // 记录里是否真的用过识别：溯源要用，不能像以前那样写死 false
      asr: (rec.asr && rec.asr.used)
        ? { used: true, mode: rec.asr.mode === "remote" ? "remote" : "local",
            lang: rec.asr.lang || "", engine: rec.asr.engine || "" }
        : false
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
    var stream = null, mr = null, chunks = [], startedAt = 0, pausedMs = 0, pauseAt = 0, starting = false;
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
      starting = false;
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
      if (mr || starting) return Promise.resolve(false);
      starting = true;
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
        stream = s;
        var mime = pickMime();
        try {
          mr = mime ? new window.MediaRecorder(s, { mimeType: mime }) : new window.MediaRecorder(s);
        } catch (e) {
          // 构造失败必须把麦克风还回去，否则标签页一直亮着录音图标
          cleanup();
          throw new Error("浏览器没能开始录音：" + (e && e.message ? e.message : "MediaRecorder 初始化失败"));
        }
        chunks = [];
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mr.start(1000);
        startedAt = now(); pausedMs = 0; pauseAt = 0;
        if (timer) clearInterval(timer);
        timer = setInterval(function () { if (hooks.onTick) hooks.onTick(elapsed()); }, 200);
        startMeter(s);
        if (hooks.onState) hooks.onState("recording");
        starting = false;
        return true;
      }, function (err) {
        starting = false;
        cleanup();
        throw err;
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
        var done = false, guard = null;
        function finish(out) {
          if (done) return;
          done = true;
          if (guard) clearTimeout(guard);
          resolve(out);
        }
        // 个别 WebView 在 stop() 后不派发 onstop：留 1.5s 兜底，否则按键会永远停在「结束」上
        guard = setTimeout(function () {
          cleanup();
          if (hooks.onState) hooks.onState("stopped");
          finish(null);
        }, 1500);
        mr.onstop = function () {
          var type = (finished.mimeType || mime || "audio/webm").split(";")[0];
          var blob = chunks.length ? new Blob(chunks, { type: type }) : null;
          cleanup();
          if (hooks.onState) hooks.onState("stopped");
          if (hooks.onTick) hooks.onTick(duration);
          finish(blob ? { blob: blob, type: type, duration: duration } : null);
        };
        try { finished.stop(); } catch (e) { cleanup(); finish(null); }
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
      clear: $("rec-clear"), clearAll: $("rec-clear-all"), floatBtn: $("rec-float"), unsupported: $("rec-unsupported"),
      asrBtn: $("rec-asr"), asrLang: $("rec-asr-lang"), asrMode: $("rec-asr-mode"),
      asrState: $("rec-asr-state"), switchBox: $("rec-switch"),
      live: $("rec-live"), liveBody: $("rec-live-body"), liveMeta: $("rec-live-meta"),
      liveEmpty: $("rec-live-empty"), liveGo: $("rec-live-go")
    };
    if (!el.preview) return null;      // 页面没这块就安静退出，不影响其它功能

    // 电平条按需生成，页面里只留容器，避免手写一堆空节点
    if (el.meter && !el.meter.children.length) {
      var segs = "", n = 0;
      for (n = 0; n < 20; n++) segs += "<i></i>";
      el.meter.innerHTML = segs;
    }

    var store = null, persists = true;
    try { store = createStore(idbAdapter("mtr_records", "recs")); } catch (e) {
      // 隐私模式或禁用了本地库：只能退到内存，刷新即失。这点必须让用户看见，不能假装存好了
      store = createStore(createMemoryAdapter());
      persists = false;
    }

    var state = { id: newId(), title: "", createdAt: Date.now(), turns: [], duration: 0, audio: null, audioType: "" };
    var recordingStarted = false;
    var lastWritten = null;   // 上次由代码写入预览的全文，用来判断用户是否手改过
    var dirty = false;        // 有还没落档的内容（存档或下载都算落档）

    var rec = makeRecorder({
      onTick: function (secs) {
        if (el.time) el.time.textContent = clock(secs);
        refreshFloat();
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
      renderSwitch();
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

    function writePreview(text, toBottom) {
      if (!el.preview) return;
      el.preview.value = text;
      lastWritten = text;
      if (toBottom) el.preview.scrollTop = el.preview.scrollHeight;
    }

    function append(turn) {
      if (!turn) return;
      state.turns.push(turn);
      dirty = true;
      if (el.preview) {
        // 用户没动过正文时只追加一行：两小时会议几百条也不会每次都重建整段、不会把滚动条弹回顶部。
        // 一旦检测到手改，就走完整重建，保证手改内容不被覆盖。
        var untouched = lastWritten !== null && el.preview.value === lastWritten;
        if (untouched) {
          var body = stripNames(el.preview.value);
          var line = lineOf(turn);
          writePreview(namesLine(collectNames(state.turns)) + "\n\n" + (body ? body + "\n" + line : line), true);
        } else {
          writePreview(appendLine(el.preview.value, state.turns, turn), el.preview.value === "");
        }
      }
      refreshSpeakers();
      refreshFloat();
      renderLive(null);      // 手动「记一条」与识别定稿都走 append，面板始终与成稿同源
    }

    // 会话计时：只识别、不录音的时候也必须有递增的时间码，
    // 否则整篇都会是 [00:00:00]，看不出先后顺序。
    // 录音中取录音时长；暂停时会话计时同样冻结（累计扣掉暂停段），否则「暂停 5 分钟再继续」
    // 会让时间码凭空跳过 5 分钟，而音频里根本没有这段——时间码与录音对不上。
    var sessionAt = 0;
    var sessPausedMs = 0, sessPauseAt = 0;
    function sessionElapsed() {
      if (!sessionAt) return 0;
      var end = sessPauseAt ? sessPauseAt : Date.now();
      return Math.max(0, (end - sessionAt - sessPausedMs) / 1000);
    }
    function pauseSession() { if (!sessPauseAt) sessPauseAt = Date.now(); }
    function resumeSession() {
      if (sessPauseAt) { sessPausedMs += Date.now() - sessPauseAt; sessPauseAt = 0; }
    }

    function currentAt() {
      if (recordingStarted) {
        var byRec = rec.elapsed();
        if (!sessionAt) sessionAt = Date.now() - byRec * 1000;
        return Math.max(byRec, sessionElapsed());
      }
      if (!sessionAt) sessionAt = Date.now();
      return sessionElapsed();
    }

    function submitLine() {
      if (!el.line) return;
      var text = oneLine(el.line.value);
      if (!text) { el.line.focus(); return; }
      submitText(text, speaker());
      el.line.value = "";
      el.line.focus();
    }

    // 整页崩塌（内置浏览器上端点识别会崩，已实测）或误关时，唯一能救回内容的是草稿：
    // 每落一行就往 localStorage 存一份，重开页面自动找回。写不进去也不打断记录。
    var DRAFT_KEY = "mtr_draft_v2";
    var draftTimer = null, draftOff = false;

    function saveDraft() {
      if (draftOff) return;
      if (draftTimer) return;
      draftTimer = setTimeout(function () {
        draftTimer = null;
        try {
          if (!state.turns.length) { localStorage.removeItem(DRAFT_KEY); return; }
          localStorage.setItem(DRAFT_KEY, JSON.stringify({
            at: Date.now(), title: title(), createdAt: state.createdAt,
            duration: currentAt() || 0, turns: state.turns
          }));
        } catch (e) { draftOff = true; }   // 隐私模式或配额满：草稿失效，但记录照常
      }, 600);
    }

    function readDraft() {
      try {
        var raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (!d || !d.turns || !d.turns.length) return null;
        return d;
      } catch (e) { return null; }
    }

    function dropDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
    }

    // 页面与浮窗共用同一条写入路径：浮窗里记的一条，和页面里记的完全等价
    // v2.0 碎片合并：识别常把一句话切成几段（「好」「嗯」「对」各自成行）。同一个人、
    // 上一行 ≤6 字、间隔 ≤4 s、本段 ≤20 字时并进上一行（用「、」连），只改文字不动时间码。
    // 这是「减少碎片」，不是「猜说话人」——不同人、间隔长的照旧另起一行。
    function submitText(text, who) {
      var t = oneLine(text || "");
      if (!t) return false;
      var at = currentAt();
      var atv = at == null ? state.duration : at;
      var last = state.turns[state.turns.length - 1];
      if (last && !last.mark && last.speaker === who && String(last.text || "").length <= 6 &&
          t.length <= 20 && last.at != null && atv != null && atv >= last.at && (atv - last.at) <= 4) {
        last.text = (String(last.text || "") + "、" + t).replace(/、+/g, "、");
        last.merged = (last.merged || 0) + 1;
        saveDraft();
        // 合并是「改已有的那一行」，不是「再追加一行」：必须整段重建，
        // 否则预览里会同时留着旧行和合并后的新行（实测确实会重复）。
        if (el.preview) {
          writePreview(namesLine(collectNames(state.turns)) + "\n\n" +
            state.turns.map(function (x) { return lineOf(x); }).join("\n"), false);
        }
        renderLive(null);
        setStatus("并入上一句（共 " + state.turns.filter(function (x) { return !x.mark; }).length + " 条）");
        return true;
      }
      append({ at: atv, speaker: who, text: t });
      saveDraft();
      setStatus("记下 1 条（共 " + state.turns.filter(function (x) { return !x.mark; }).length + " 条）");
      return true;
    }

    function markNow(note) {
      var at = currentAt();
      append({ at: at == null ? state.duration : at, mark: note || "打点" });
      saveDraft();
      setStatus("已打点" + (note ? "：" + note : ""));
    }

    if (el.start) el.start.addEventListener("click", function () {
      el.start.disabled = true;
      rec.start().then(function () {
        recordingStarted = true;
        if (!state.title) state.title = title();
        setStatus("录音中——录音只在本机，结束后点「保存原稿」才会落档");
        liveMeta();
      }).catch(function (err) {
        el.start.disabled = false;
        setStatus("无法开始录音：" + (err && err.message ? err.message : "浏览器未授权麦克风") +
          "。可以只用下面的文字录入，功能不受影响。");
      });
    });

    if (el.pause) el.pause.addEventListener("click", function () {
      if (rec.isPaused()) { rec.resume(); resumeSession(); }
      else { rec.pause(); pauseSession(); }
    });

    if (el.stop) el.stop.addEventListener("click", function () {
      rec.stop().then(function (out) {
        if (!out) return;
        state.duration = out.duration || state.duration;
        state.audio = out.blob;
        state.audioType = out.type;
        setStatus("录音结束：" + clock(state.duration) + "，音频已就绪（点「下载录音」或「保存原稿」留档）");
        liveMeta();
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
      markNow(note);
      if (el.markNote) el.markNote.value = "";
    });

    /* ---------------- 浮窗：会议软件全屏时也能记 ---------------- */

    // 置顶小窗（Document Picture-in-Picture）里没有宿主页面的 CSS，样式必须自带一份内联文本，
    // 这样仍是零外链；不支持 PiP 的浏览器退化成“记录卡吸顶”，不是假装成功。
    var FLOAT_CSS = [
      "html,body{margin:0;height:100%}",
      "body{font:13px/1.6 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#14181f;background:#fff}",
      ".rec-float-panel{padding:12px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px}",
      ".rf-head{display:flex;align-items:center;gap:10px}",
      ".rf-head b{font:600 20px/1 ui-monospace,Consolas,monospace;font-variant-numeric:tabular-nums}",
      ".rf-head span{font-size:12px;color:#5b6572;margin-right:auto}",
      ".rf-head button{width:auto;padding:6px 10px;border:1px solid #cfd6e2;border-radius:6px;background:#f6f8fb;font:inherit;cursor:pointer}",
      ".rec-float-panel input,.rec-float-panel textarea{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:8px 10px;border:1px solid #cfd6e2;border-radius:8px;background:#fff;color:inherit}",
      ".rec-float-panel textarea{min-height:88px;resize:vertical}",
      ".rf-row{display:flex;gap:8px}",
      ".rf-row button{flex:1;min-height:44px;border:1px solid #cfd6e2;border-radius:8px;background:#f6f8fb;font:inherit;font-weight:600;cursor:pointer}",
      ".rf-row button#rf-say{background:#14548c;border-color:#14548c;color:#fff}",
      "#rf-tip{margin:0;font-size:12px;color:#5b6572}"
    ].join("");

    var floatCtl = createFloat();

    function createFloat() {
      var pipWin = null, panel = null;
      function supported() {
        return typeof window !== "undefined" && window.documentPictureInPicture &&
          typeof window.documentPictureInPicture.requestWindow === "function";
      }
      function q(sel) { return panel ? panel.querySelector(sel) : null; }
      function build() {
        if (panel) return panel;
        panel = document.createElement("div");
        panel.className = "rec-float-panel";
        panel.innerHTML = '<div class="rf-head"><b id="rf-clock">00:00</b><span id="rf-count">0 条</span>' +
          '<button type="button" id="rf-close">收起</button></div>' +
          '<input id="rf-speaker" type="text" placeholder="当前说话人（可空）">' +
          '<textarea id="rf-line" placeholder="记一条，回车提交；Shift+回车换行"></textarea>' +
          '<div class="rf-row"><button type="button" id="rf-say">记一条</button>' +
          '<button type="button" id="rf-mark">打点</button></div>' +
          '<p id="rf-tip">录音和文字只在本机；云端识别时音频会发给浏览器厂商。成稿仍在上面的页面里</p>';
        var say = q("#rf-say"), line = q("#rf-line"), mk = q("#rf-mark"), close = q("#rf-close");
        if (say) say.addEventListener("click", function () { sayFromPanel(); });
        if (mk) mk.addEventListener("click", function () { markNow(""); });
        if (line) line.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sayFromPanel(); }
        });
        if (close) close.addEventListener("click", function () {
          if (pipWin) pipWin.close();
          else document.body.classList.remove("rec-float-on");
          setStatus("浮窗已收起，记录仍在页面里");
        });
        return panel;
      }
      function sayFromPanel() {
        var line = q("#rf-line"), sp = q("#rf-speaker");
        var text = line ? line.value : "";
        var who = (sp && sp.value.trim()) ? sp.value.trim().replace(/[：:]/g, "") : speaker();
        if (submitText(text, who) && line) { line.value = ""; line.focus(); }
      }
      function sync() {
        if (!panel) return;
        var c = q("#rf-clock"), n = q("#rf-count"), sp = q("#rf-speaker");
        if (c) c.textContent = clock(rec.elapsed ? rec.elapsed() : 0);
        if (n) n.textContent = state.turns.filter(function (t) { return !t.mark; }).length + " 条";
        if (sp) sp.placeholder = "当前说话人" + (speaker() ? "（" + speaker() + "）" : "（可空）");
      }
      function stickyOn() {
        document.body.classList.add("rec-float-on");
        if (el.floatBtn) el.floatBtn.textContent = "取消吸附";
      }
      function open() {
        if (!supported()) {
          stickyOn();
          setStatus("这个浏览器不支持置顶浮窗（Chrome / Edge 116+ 才有）；已把记录卡吸在页面顶部，滚到哪儿都能记。");
          return Promise.resolve("sticky");
        }
        if (pipWin) { pipWin.close(); return Promise.resolve("closed"); }
        return window.documentPictureInPicture.requestWindow({ width: 340, height: 380 }).then(function (win) {
          pipWin = win;
          var style = win.document.createElement("style");
          style.textContent = FLOAT_CSS;
          win.document.head.appendChild(style);
          build();
          win.document.body.appendChild(panel);
          sync();
          win.addEventListener("pagehide", function () {
            if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
            pipWin = null;
            if (el.floatBtn) el.floatBtn.textContent = "浮窗";
            setStatus("浮窗已关闭，记录仍在页面里");
          });
          if (el.floatBtn) el.floatBtn.textContent = "关闭浮窗";
          setStatus("浮窗已打开：会议软件全屏时也能记；录音与成稿仍在页面里");
          return "pip";
        }).catch(function (err) {
          stickyOn();
          setStatus("浮窗打开失败（" + (err && err.message ? err.message : "浏览器拒绝") + "），已把记录卡吸在页面顶部。");
          return "failed";
        });
      }
      return { supported: supported, open: open, sync: sync };
    }

    function refreshFloat() { if (floatCtl) floatCtl.sync(); }

    if (el.floatBtn) el.floatBtn.addEventListener("click", function () {
      if (document.body.classList.contains("rec-float-on")) {
        document.body.classList.remove("rec-float-on");
        el.floatBtn.textContent = "浮窗";
        setStatus("已取消吸附");
        return;
      }
      floatCtl.open();
    });

    /* ---------------- 语音识别：文字自动，换人一键 ---------------- */

    // 浏览器只出文字，不区分说话人（没有声纹分离）；换人由人点一下，之后落行归到新名字。
    var asrCtl = null, asrOn = false;
    var asrUsed = false;                              // 这段记录里是否真落过识别行（meta 溯源用）
    var pendingWho = null;                            // 换人瞬间：还没落段的那半句归旧人
    var prevSpeaker = "";

    function asrSay(text) { if (el.asrState) el.asrState.textContent = text || ""; }

    // ---------- 实时转写面板：录音进行中就能看见的文档流 ----------
    // 定稿句直接读 state.turns（与成稿同一份数据，不另存一份）；半句只在这里显示，永不写进成稿。
    var liveInterim = "";
    var LIVE_MAX = 40;                     // 只渲染最近 40 句：两小时会议不会把 DOM 撑大

    function liveEmpty(text) { if (el.liveEmpty && text) el.liveEmpty.textContent = text; }

    function liveMeta() {
      if (!el.liveMeta) return;
      var n = 0, i;
      for (i = 0; i < state.turns.length; i++) if (!state.turns[i].mark) n++;
      var bits = ["已定稿 " + n + " 句"];
      if (recordingStarted) {
        var at = currentAt();
        bits.push("录音 " + clock(at == null ? state.duration : at));
      }
      bits.push(asrOn
        ? ("识别中（" + (asrMode() === "local" ? "端上：音频不出本机" : "云端：音频会发给浏览器厂商") + "）")
        : "识别未开");
      el.liveMeta.textContent = bits.join(" · ");
    }

    function renderLive(interim) {
      if (!el.liveBody) return;
      if (interim != null) liveInterim = interim;
      var lines = [], i, t, start = Math.max(0, state.turns.length - LIVE_MAX);
      for (i = start; i < state.turns.length; i++) {
        t = state.turns[i];
        lines.push('<p class="rec-live-line' + (t.mark ? " mark" : "") + '">' +
          '<span class="t">' + esc(clock(t.at || 0)) + "</span>" +
          (t.mark
            ? '<span class="txt">［打点］' + esc(t.mark) + "</span>"
            : '<span class="who">' + esc(t.speaker || DEFAULT_SPEAKER) + "</span>" +
              '<span class="txt">' + esc(t.text || "") + "</span>") +
          "</p>");
      }
      if (liveInterim) {
        lines.push('<p class="rec-live-int"><span class="dot" aria-hidden="true"></span>' + esc(liveInterim) + "</p>");
      }
      if (lines.length) {
        el.liveBody.innerHTML = lines.join("");
        el.liveBody.scrollTop = el.liveBody.scrollHeight;
      } else if (el.liveEmpty && el.liveEmpty.parentNode !== el.liveBody) {
        el.liveBody.innerHTML = "";
        el.liveBody.appendChild(el.liveEmpty);
      }
      liveMeta();
    }

    if (el.liveGo && el.asrBtn) el.liveGo.addEventListener("click", function () { el.asrBtn.click(); });

    function asrLabel(on) {
      if (el.asrBtn) {
        el.asrBtn.textContent = on ? "停止识别" : "语音识别";
        el.asrBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      // 面板里那颗按钮是同一个开关的第二个入口：文案必须跟着状态走。
      // 否则识别已经开着、按钮还写「开实时转写」，点下去会把它停掉——语义正好反了。
      if (el.liveGo) el.liveGo.textContent = on ? "停止识别" : "开实时转写";
    }

    function asrMode() { return (el.asrMode && el.asrMode.value === "remote") ? "remote" : "local"; }
    function asrLang() { return (el.asrLang && el.asrLang.value) || (typeof ASR !== "undefined" ? ASR.DEFAULT_LANG : ""); }

    function langLabel() {
      var code = asrLang(), i, L = (typeof ASR !== "undefined" && ASR.LANGS) || [];
      for (i = 0; i < L.length; i++) if (L[i].code === code) return L[i].label;
      return code || "默认语言";
    }

    function renderSwitch() {
      if (!el.switchBox) return;
      var cur = speaker();
      var names = collectNames(state.turns).filter(function (n) { return n && n !== DEFAULT_SPEAKER; });
      var html = names.slice(0, 8).map(function (n) {
        return '<button type="button" data-name="' + esc(n) + '"' + (n === cur ? ' class="on"' : "") + ">" + esc(n) + "</button>";
      }).join("");
      html += '<button type="button" data-name=""' + (cur ? "" : ' class="on"') + ">未标注</button>";
      el.switchBox.innerHTML = html;
    }

    // 换人前把「已经说了但还没到停顿」的半句按旧说话人落下。
    // 不这么做，那半句会跟着新名字进成稿——这是最容易出的错人。
    function flushTo(who) {
      if (!asrCtl) return;
      pendingWho = who;
      try { asrCtl.flushNow(); } finally { pendingWho = null; }
    }

    function switchTo(name) {
      var before = speaker();
      if (el.speaker) el.speaker.value = name;
      if (asrOn && before !== name) flushTo(before);
      prevSpeaker = name;
      renderSwitch();
      asrSay(name ? ("已换成 " + name + "：接下来识别到的话记到他名下") : "已换成「未标注」");
    }

    if (el.switchBox) el.switchBox.addEventListener("click", function (e) {
      var node = e.target, b = null;
      while (node && node !== el.switchBox) {
        if (node.getAttribute && node.getAttribute("data-name") !== null) { b = node; break; }
        node = node.parentNode;
      }
      if (!b) return;
      switchTo(b.getAttribute("data-name") || "");
    });

    // 直接在输入框里改名也算换人：高亮跟着走，识别中同样先把半句落给旧名
    if (el.speaker) el.speaker.addEventListener("input", renderSwitch);
    if (el.speaker) el.speaker.addEventListener("change", function () {
      var now = speaker();
      if (asrOn && prevSpeaker !== now) flushTo(prevSpeaker);
      prevSpeaker = now;
      renderSwitch();
    });

    function ensureAsr() {
      if (asrCtl || typeof ASR === "undefined") return asrCtl;
      asrCtl = ASR.create({
        lang: asrLang(),
        local: asrMode() !== "remote",
        idleMs: 1400,
        onText: function (r) {
          // 半句只进面板：说过没停顿的半句还不算定稿，不能进成稿，否则改口就留下两遍
          if (r && r.interim != null) renderLive(r.interim);
        },
        onSegment: function (text) {
          var who = pendingWho != null ? pendingWho : (speaker() || DEFAULT_SPEAKER);
          if (submitText(text, who)) {
            asrUsed = true;
            renderLive("");      // 定稿句已进 state.turns，append 会重渲染；这里清掉半句
            asrSay("落一行（" + who + "），共 " + state.turns.filter(function (t) { return !t.mark; }).length + " 条");
          }
        },
        onError: function (msg) { asrSay(msg); },
        // 内置浏览器（Electron 壳）实测碰端上识别会整页崩：这类环境不进端上，
        // 直接按浏览器默认（云端）走，并把「音频会外发」这句说清楚，不偷偷改口径。
        onLocalBlocked: function (risk) {
          asrSay("当前浏览器（" + (risk === "electron" ? "Electron 内核" : "内置浏览器") +
            "）在端上识别上会让整页崩（已实测），已改用浏览器默认方式——音频会发给浏览器厂商；" +
            "要音频不出本机，请用 Chrome / Edge 打开本页");
        },
        onState: function (s) {
          asrOn = (s === "listening-local" || s === "listening-remote");
          asrLabel(asrOn);
          if (s === "listening-local") asrSay("识别中（端上：音频不出本机）");
          else if (s === "listening-remote") asrSay("识别中（云端：音频会发给浏览器厂商）");
          else if (s === "stopped") asrSay("识别已停");
          liveMeta();
        }
      });
      return asrCtl;
    }

    // 记录里是否用过识别：写进原稿备份与 meta，避免把识别结果记成人工录入
    function asrState() {
      if (!asrUsed) return null;
      return { used: true, mode: asrMode(), lang: asrLang(), engine: typeof ASR !== "undefined" ? "Web Speech API " + ASR.VERSION : "Web Speech API" };
    }

    // 端上语言包要不要装，只能由用户显式点一次（install 需要用户手势）；
    // 自动流程里不再先探「语言包可不可下载」——那个探测在部分浏览器会崩渲染进程。
    function startAsr(a) {
      a.setLang(asrLang());
      a.setLocal(asrMode() !== "remote");
      a.open().then(function (r) {
        if (r === "running") return;
        if (r === "need-choice") {
          asrSay("这个浏览器说识别服务不可用（多半是网络或服务区域限制）。可先用「记一条」手敲，或直接用会议平台转写导出后贴回来。");
          return;
        }
        asrSay("识别没能启动：" + r + "；文字录入不受影响。识别包缺失会在这行提示，按提示改云端或换 Chrome。");
      });
    }

    if (el.asrBtn) el.asrBtn.addEventListener("click", function () {
      if (typeof ASR === "undefined") { asrSay("识别模块没加载"); return; }
      var a = ensureAsr();
      if (!a) return;
      if (!a.supported()) {
        asrSay("这个浏览器没有语音识别接口（Chrome / Edge 可用；Safari 与 Chrome 安卓版没有）。文字录入不受影响。");
        liveEmpty("这个浏览器没有实时转写接口（Chrome / Edge 可用；Safari 与 Chrome 安卓版没有）。用「记一条」手敲，或把会议平台转写导出后贴回来，质检功能不受影响。");
        return;
      }
      if (asrOn) { a.stop(); return; }
      prevSpeaker = speaker();
      startAsr(a);
    });

    // 识别中改语言：先停（顺带把半句按当前人落下），再按新语言重开，不能静默无效
    if (el.asrLang) el.asrLang.addEventListener("change", function () {
      var name = langLabel();
      if (!asrOn) { asrSay("语言已选：" + name + "，点「语音识别」开始"); return; }
      var a = ensureAsr();
      if (!a) return;
      a.stop();
      asrSay("换了识别语言，正按「" + name + "」重开识别；已经识别的内容不受影响");
      setTimeout(function () { if (!asrOn) startAsr(a); }, 400);
    });

    if (el.asrMode) el.asrMode.addEventListener("change", function () {
      if (asrOn) asrSay("切换识别方式要先把识别停掉再开");
    });

    renderSwitch();

    function download(name, data, mime) {
      var blob = data instanceof Blob ? data : new Blob([data], { type: mime || "text/plain;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = plainFileName(name);
      document.body.appendChild(a);
      a.click();
      // 立刻 revoke 会让部分浏览器（Safari / 旧 WebView）拿不到下载内容
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
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
        asr: asrState(),                          // null = 这段记录没用过识别
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
      var todo = $("todo-input");
      if (!todo || !todo.value.trim()) {
        setStatus("已把成稿填进「会议转录」。还差待办表：质检要两份材料，粘上待办表会自动跑；没有待办表可以先让智能体提一版。");
        return;
      }
      var run = $("run");
      if (run) run.click();
      setStatus("已送入「会议转录」并跑了质检；录音与文字原稿点「保存原稿」可留档");
    });

    if (el.save) el.save.addEventListener("click", function () {
      var s = snapshot();
      state.title = s.title;
      var note = "";
      store.get(s.id).then(function (existing) {
        // 载入存档后再点保存，若沿用原 id 会把原件覆盖掉；这里改成另存新份
        var id = existing ? newId() : s.id;
        if (existing) note = "（原存档保留，这是新的一份）";
        state.id = id;
        return store.save({
          id: id, title: s.title, createdAt: s.createdAt, savedAt: Date.now(),
          duration: s.duration, turns: s.turns, text: s.text,
          audio: s.audio, audioType: s.audioType
        });
      }).then(function () {
        dirty = false;
        setStatus("原稿已存到本机" + note + "（" + (s.audio ? "文字 + 录音" : "仅文字") + "），可在下方列表载入" +
          (persists ? "" : "；注意：本浏览器禁用了本地库，这份存档刷新后即失，建议同时「导出备份包 .zip」"));
        return refreshList();
      }).catch(function (err) {
        setStatus("存档失败：" + (err && err.message ? err.message : "浏览器拒绝写入") +
          "。可以改用「导出备份包 .zip」带走，不依赖本机存档。");
      });
    });

    if (el.dlTxt) el.dlTxt.addEventListener("click", function () {
      download("原稿_" + safeName(title(), "会议") + "_" + fileStamp(state.createdAt) + ".txt", buildBackup(snapshot()), "text/plain;charset=utf-8");
      dirty = false;
      setStatus("原稿已下载（.txt）——文件在浏览器的下载目录里");
    });

    if (el.dlAudio) el.dlAudio.addEventListener("click", function () {
      if (!state.audio) { setStatus("还没有录音可下载——先点「开始录音」"); return; }
      var ext = state.audioType.indexOf("mp4") >= 0 ? "m4a" : "webm";
      download("录音_" + safeName(title(), "会议") + "_" + fileStamp(state.createdAt) + "." + ext, state.audio, state.audioType);
    });

    if (el.dlZip) el.dlZip.addEventListener("click", function () {
      var s = snapshot();
      var files = [
        { name: "原稿.txt", data: buildBackup(s) },
        { name: "meta.json", data: buildMeta(s) }
      ];
      if (s.audio) files.push({ name: "录音." + (s.audioType.indexOf("mp4") >= 0 ? "m4a" : "webm"), data: s.audio });
      var bytes = zip(files, s.createdAt);
      download("会议原稿_" + safeName(s.title, "会议") + "_" + fileStamp(s.createdAt) + ".zip", bytes, "application/zip");
      dirty = false;
      setStatus("备份包已生成：" + files.length + " 个文件（原稿.txt + meta.json" + (s.audio ? " + 录音" : "") + "）");
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
        if (el.clearAll) el.clearAll.disabled = !rows.length;
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
        if (el.preview) { el.preview.value = r.text || buildScript(state.turns); lastWritten = el.preview.value; }
        dirty = false;
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

    function resetState() {
      // 清空/载入别的记录时，把识别里还没落段的半句丢掉：
      // 留着它，下一段话会把上一场会议的话带进新记录。
      if (asrCtl) asrCtl.discard();
      state = { id: newId(), title: "", createdAt: Date.now(), turns: [], duration: 0, audio: null, audioType: "" };
      recordingStarted = false;
      sessionAt = 0;
      asrUsed = false;
      prevSpeaker = "";
      dropDraft();          // 主动清空就不该再被「找回草稿」弹回来
      if (el.title) el.title.value = "";
      if (el.time) el.time.textContent = "00:00";
      if (el.line) el.line.value = "";
      if (el.speaker) el.speaker.value = "";
      if (el.markNote) el.markNote.value = "";
      if (el.preview) { el.preview.value = ""; lastWritten = ""; }
      dirty = false;
      refreshSpeakers();
    }

    if (el.clear) el.clear.addEventListener("click", function () {
      // 录音中清空会让旧音频落进新记录：先停录再清，并明确告诉用户这段音频没保存
      if (rec.isRecording() || rec.isPaused()) {
        rec.stop().then(function () {
          resetState();
          paintLevel(0);
          setStatus("已停止录音并清空当前记录（这段音频没有保存）");
        });
        return;
      }
      resetState();
      setStatus("已清空当前记录");
    });

    if (el.clearAll) el.clearAll.addEventListener("click", function () {
      store.list().then(function (rows) {
        if (!rows.length) { setStatus("本机没有可清除的存档"); return; }
        if (typeof confirm === "function" &&
            !confirm("清除本机全部 " + rows.length + " 份原稿存档？录音一并删除，不可撤销。")) return;
        return Promise.all(rows.map(function (r) { return store.remove(r.id); })).then(function () {
          setStatus("已清除本机全部存档（" + rows.length + " 份）");
          return refreshList();
        });
      }).catch(function (err) {
        setStatus("清除失败：" + (err && err.message ? err.message : "浏览器拒绝"));
      });
    });

    // 录音中或录了内容还没落档就关页面，等于把这场会直接扔掉：拦一次并说清原因。
    // 已存档 / 已下载过就放行，不要变成骚扰。
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("beforeunload", function (e) {
        var recHot = rec.isRecording() || rec.isPaused();
        // 识别中关页面同样会丢掉「已经说了、还没到停顿」的那半句，属于要拦的情况
        var asrHot = !!(asrCtl && asrCtl.isRunning());
        if (!recHot && !asrHot && !dirty) return undefined;
        var msg = recHot ? "还在录音：关闭页面会丢掉这段音频"
          : (asrHot ? "还在识别：关闭页面会丢掉还没落段的那句话" : "这段会议记录还没保存：关闭页面会丢掉");
        e.preventDefault();
        e.returnValue = msg;
        return msg;
      });
    }

    // 首次进来：给一个占位会议名，并把存档列表拉出来
    if (el.title && !el.title.value) el.title.placeholder = defaultTitle();

    // 上次没落档就崩了/被关了：把草稿捡回来，别让一场会白丢。
    // 只在当前是空记录时恢复，避免把刚开的会盖掉。
    (function restoreDraft() {
      var d = readDraft();
      if (!d || !d.turns || !d.turns.length) return;
      state.createdAt = d.createdAt || Date.now();
      state.turns = d.turns.slice();
      if (d.title && el.title) el.title.value = d.title;
      writePreview(buildScript(state.turns), true);
      refreshSpeakers();
      dirty = true;
      var n = state.turns.filter(function (t) { return !t.mark; }).length;
      setStatus("已自动找回上次没保存的记录（" + n + " 条）——整页崩了或误关都还在，点「保存原稿」落档");
    })();

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
    lineOf: lineOf,
    stripNames: stripNames,
    buildBackup: buildBackup,
    buildMeta: buildMeta,
    safeName: safeName,
    plainFileName: plainFileName,
    crc32: crc32,
    zip: zip,
    createMemoryAdapter: createMemoryAdapter,
    createStore: createStore,
    newId: newId,
    mount: mount
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = RECORDER;