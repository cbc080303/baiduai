/* 语音识别入口：把「说话」变成记录里的文字行。
 *
 * 关于「自动区分说话人」必须先说清的能力边界：
 *   - 浏览器的 Web Speech API 只返回文字，**不返回说话人**，也没有声纹分离；
 *     网页里做可靠 diarization 需要预训练模型（几十 MB 起），单文件零外链做不到。
 *   - 因此本模块只负责「文字自动」：按停顿切段，落行时用当前说话人；
 *     谁在说由人一键切换（页面上的「换人」条），这是可靠做法，不假装自动。
 *     换人时调用 flushNow()，把还没到停顿的半句先按原说话人落下，避免记到新人名下。
 *   - 真正自动区分说话人的是会议平台转写（飞书妙记 / 腾讯会议 / Teams），
 *     它们的逐字稿带说话人，导出后贴回本页即可。
 *
 * 隐私：Web Speech 默认把音频发给浏览器厂商的识别服务（Chrome → Google）。
 * Chrome 139+ / Firefox 160+ 支持 `processLocally = true` 的端上识别，音频不出本机。
 *
 * 端上识别的实测边界（2026-11-26 内置浏览器实测，写在代码里免得下次又踩）：
 *   - 内置浏览器（Electron 43 / Chromium 150）里，`available({langs, processLocally:true})`
 *     与 `start()` 且 `processLocally=true` 都会让**渲染进程崩溃**（页面直接变 about:blank）；
 *     同一环境下 `available({langs})`（不带 processLocally）正常返回 "available"。
 *   - 也就是说「先探测端上、再用端上」这条路在这些环境里探测本身就是崩溃点，try/catch 拦不住。
 *     所以本模块不再调用带 processLocally 的 available()：认出这类环境就整段绕开端上，
 *     其余环境直接 start()（失败由 onerror 的 language-not-supported 兜底提示）。
 */
var ASR = (function () {
  "use strict";

  var VERSION = "1.2";
  var DEFAULT_LANG = "zh-CN";
  var LANGS = [
    { code: "zh-CN", label: "中文普通话" },
    { code: "en-US", label: "英语" },
    { code: "ja-JP", label: "日语" }
  ];

  function ctor(win) {
    var w = win || (typeof window !== "undefined" ? window : null);
    if (!w) return null;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  // 哪些环境碰端上识别会崩：内置浏览器（Electron/桌面客户端壳）已实测必崩。
  // 返回 "" 表示没有已知风险，可用端上。
  function riskyLocal(win) {
    var w = win || (typeof window !== "undefined" ? window : null);
    var ua = (w && w.navigator && w.navigator.userAgent) || "";
    if (/Electron/i.test(ua)) return "electron";
    if (/DuMate|qianfan-desk|qianfan_desk/i.test(ua)) return "embedded";
    return "";
  }

  // 语言是否可识别（安全探测：**不带** processLocally，那个参数会崩渲染进程）
  function serviceStatus(win, lang) {
    var C = ctor(win);
    if (!C || typeof C.available !== "function") return Promise.resolve("unknown");
    try {
      var r = C.available({ langs: [lang || DEFAULT_LANG] });
      if (r && typeof r.then === "function") {
        return r.then(function (s) { return String(s || "unknown"); }, function () { return "unknown"; });
      }
      return Promise.resolve(String(r || "unknown"));
    } catch (e) {
      return Promise.resolve("unknown");
    }
  }

  // 兼容旧调用名：不带 processLocally 的安全探测
  function localStatus(win, lang) { return serviceStatus(win, lang); }

  // 安装端上语言包：必须在用户手势里调用，否则浏览器会拒。
  // 注意：要不要装、能不能装，只能由用户显式点一次，不在自动流程里调。
  function installLocal(win, lang) {
    var C = ctor(win);
    if (!C || typeof C.install !== "function") return Promise.resolve(false);
    try {
      return C.install({ langs: [lang || DEFAULT_LANG] }).then(function (ok) { return !!ok; },
        function () { return false; });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  // 错误码 → 人话。这几个是实际会遇到的，别把 "network" 直接甩给用户
  function errorText(code) {
    var map = {
      "not-allowed": "麦克风没被允许：点地址栏的麦克风图标允许后重试",
      "service-not-allowed": "浏览器不允许这个页面用识别服务",
      "audio-capture": "没拿到麦克风（被别的程序占用，或设备不可用）",
      "network": "识别服务连不上：端上识别不需要网络，云端识别需要",
      "no-speech": "这段没听到说话",
      "aborted": "识别被中止",
      "language-not-supported": "这个语言没有可用的识别包：换成中文普通话、改云端识别，或直接用平台转写",
      "phrases-not-supported": "浏览器不支持自定义短语"
    };
    return map[code] || ("识别出错：" + (code || "未知"));
  }

  /* ---------------- 切段：按停顿把连续文字分成一轮一轮 ---------------- */

  var CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

  // 拼接两段识别文字：中文直接相连，西文在词边界补一个空格。
  // 不做这件事，浏览器把 "hello" / "world" 两次交给我们就粘成 "helloworld"。
  function joinText(a, b) {
    if (!a) return b || "";
    if (!b) return a;
    var left = a.charAt(a.length - 1), right = b.charAt(0);
    if (CJK.test(left) || CJK.test(right)) return a + b;
    if (/[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right)) return a + " " + b;
    return a + b;
  }

  // 浏览器只回文字流。按「静默 idleMs 毫秒」切段，段与段之间就是换人的地方。
  function createSegmenter(idleMs) {
    var gap = idleMs || 1400;
    var buf = "", lastAt = 0;
    return {
      push: function (text, now) {
        var t = String(text == null ? "" : text).trim();
        if (!t) return null;
        buf = joinText(buf, t);
        lastAt = Number(now) || 0;
        return null;
      },
      peek: function () { return buf; },
      // 停顿够久就交付一段
      idle: function (now) {
        if (!buf) return null;
        if ((Number(now) || 0) - lastAt < gap) return null;
        return this.flush();
      },
      flush: function () {
        var s = buf.trim();
        buf = "";
        lastAt = 0;
        return s || null;
      },
      gap: gap
    };
  }

  /* ---------------- 识别器：一层薄封装，便于注入假对象做测试 ---------------- */

  // 一分钟内允许的自动重启次数：Chrome 的连续识别静默后会 onend，
  // 一场两小时的会重启上百次是正常的，所以按「近期频率」判异常，不设累计上限。
  var RESTART_WINDOW_MS = 60000;
  var RESTART_LIMIT = 8;

  function create(opts) {
    opts = opts || {};
    var win = opts.win || (typeof window !== "undefined" ? window : null);
    var C = ctor(win);
    var lang = opts.lang || DEFAULT_LANG;
    var local = opts.local !== false;          // 默认端上
    var seg = createSegmenter(opts.idleMs);
    var rec = null, running = false, stoppedByUser = false, timer = null;
    var restartAt = [];                        // 近一分钟的重启时间戳

    function hooks(name, arg) {
      if (typeof opts[name] === "function") { try { opts[name](arg); } catch (e) {} }
    }

    function supported() { return !!C; }

    // 打开：先认环境，再决定能不能碰端上。
    // 关键：这里**不调用** available({processLocally:true})——它在部分内嵌浏览器里直接崩渲染进程。
    function open() {
      if (!C) return Promise.resolve("unsupported");
      var risk = riskyLocal(win);
      if (risk) {
        // 这类环境连探测都会崩：直接按浏览器默认（云端）走，并把原因交回页面
        local = false;
        hooks("onLocalBlocked", risk);
        return Promise.resolve(start());
      }
      if (!local) return Promise.resolve(start());
      return serviceStatus(win, lang).then(function (st) {
        if (st === "unavailable") {
          local = false;
          hooks("onNeedChoice", lang);
          return "need-choice";
        }
        return start();      // 端上用「直接开」，失败由 onerror 兜底，不做会崩的预检
      });
    }

    function start() {
      if (rec) return Promise.resolve("running");
      try {
        rec = new C();
      } catch (e) {
        return Promise.resolve("failed");
      }
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      if (local && "processLocally" in rec) {
        try { rec.processLocally = true; } catch (e) {}
      }
      rec.onresult = function (e) {
        var interim = "", finals = "";
        var i, res;
        for (i = e.resultIndex; i < e.results.length; i++) {
          res = e.results[i];
          var text = (res[0] && res[0].transcript) || "";
          if (res.isFinal) finals = joinText(finals, text); else interim = joinText(interim, text);
        }
        if (finals) {
          seg.push(finals, Date.now());
          hooks("onText", { final: finals, interim: "" });
        } else if (interim) {
          hooks("onText", { final: "", interim: interim });
        }
      };
      rec.onerror = function (e) {
        var code = (e && e.error) || "unknown";
        // no-speech 是常态，不当错误刷屏
        if (code !== "no-speech") hooks("onError", errorText(code));
        if (code === "language-not-supported" && local) {
          // 端上模型缺失就是这条：直接告诉用户换云端，不让他反复点
          hooks("onError", "这个浏览器没有「" + lang + "」的端上识别包：改用云端识别（音频会发给浏览器厂商），或直接用平台转写");
        }
        if (code === "not-allowed" || code === "service-not-allowed") {
          stoppedByUser = true;
          running = false;
        }
      };
      rec.onend = function () {
        // 连续识别会被浏览器在静默后自动结束：只要用户没停，就接着起
        if (!running || stoppedByUser) { hooks("onState", "stopped"); return; }
        var now = Date.now();
        restartAt = restartAt.filter(function (x) { return now - x < RESTART_WINDOW_MS; });
        restartAt.push(now);
        if (restartAt.length > RESTART_LIMIT) {
          running = false;
          hooks("onError", "识别反复中断（一分钟内重启 " + restartAt.length + " 次），已停下；多半是麦克风被别的程序抢走或识别服务不稳，点「语音识别」可重开");
          hooks("onState", "stopped");
          return;
        }
        setTimeout(function () {
          if (!running) return;
          try { rec.start(); } catch (e) { running = false; hooks("onState", "stopped"); }
        }, 250);
      };
      try {
        rec.start();
      } catch (e) {
        rec = null;
        return Promise.resolve("failed");
      }
      running = true;
      stoppedByUser = false;
      restartAt = [];
      hooks("onState", local ? "listening-local" : "listening-remote");
      // 自己盯着停顿：浏览器不告诉我们“这句停了”，只能按时间判
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        var s = seg.idle(Date.now());
        if (s) hooks("onSegment", s);
      }, 400);
      return Promise.resolve("running");
    }

    // 把当前累积的半句立刻交付（换人、手动落行前调用）。失败也不能让识别停不下来。
    function flushNow() {
      var s = seg.flush();
      if (s) hooks("onSegment", s);
      return s;
    }

    // 丢弃当前累积的半句，不交付（清空记录、载入别的存档时用）
    function discard() {
      seg.flush();
      return true;
    }

    function stop() {
      stoppedByUser = true;
      running = false;
      if (timer) { clearInterval(timer); timer = null; }
      flushNow();                       // 停下时把最后一句话交付，不吞掉
      var r = rec;
      rec = null;
      if (r) { try { r.stop(); } catch (e) {} }   // 无论回调是否抛错，麦克风一定要放掉
      hooks("onState", "stopped");
      return Promise.resolve(true);
    }

    function setLang(l) { lang = l || DEFAULT_LANG; }
    function setLocal(v) { local = !!v; }
    function isRunning() { return running; }
    function current() { return seg.peek(); }

    return {
      supported: supported,
      open: open,
      start: function () { stoppedByUser = false; return start(); },
      stop: stop,
      flushNow: flushNow,
      discard: discard,
      setLang: setLang,
      setLocal: setLocal,
      isRunning: isRunning,
      current: current,
      localStatus: function () { return serviceStatus(win, lang); },
      installLocal: function () { return installLocal(win, lang); }
    };
  }

  return {
    VERSION: VERSION,
    DEFAULT_LANG: DEFAULT_LANG,
    LANGS: LANGS,
    ctor: ctor,
    riskyLocal: riskyLocal,
    serviceStatus: serviceStatus,
    localStatus: localStatus,
    installLocal: installLocal,
    errorText: errorText,
    joinText: joinText,
    createSegmenter: createSegmenter,
    create: create
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ASR;