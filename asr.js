/* 语音识别入口：把「说话」变成记录里的文字行。
 *
 * 关于「自动区分说话人」必须先说清的能力边界：
 *   - 浏览器的 Web Speech API 只返回文字，**不返回说话人**，也没有声纹分离；
 *     网页里做可靠 diarization 需要预训练模型（几十 MB 起），单文件零外链做不到。
 *   - 因此本模块只负责「文字自动」：按停顿切段，落行时用当前说话人；
 *     谁在说由人一键切换（页面上的「换人」条），这是可靠做法，不假装自动。
 *   - 真正自动区分说话人的是会议平台转写（飞书妙记 / 腾讯会议 / Teams），
 *     它们的逐字稿带说话人，导出后贴回本页即可。
 *
 * 隐私：Web Speech 默认把音频发给浏览器厂商的识别服务（Chrome → Google）。
 * Chrome 139+ / Firefox 160+ 支持 `processLocally = true` 的端上识别，音频不出本机。
 * 本模块默认**只走端上**；端上不可用时把选择权交给用户，不偷偷联网。
 */
var ASR = (function () {
  "use strict";

  var VERSION = "1.0";
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

  // 端上识别是否可用：'available' | 'downloadable' | 'unavailable' | 'unknown'
  function localStatus(win, lang) {
    var C = ctor(win);
    if (!C || typeof C.available !== "function") return Promise.resolve("unknown");
    try {
      var r = C.available({ langs: [lang || DEFAULT_LANG], processLocally: true });
      if (r && typeof r.then === "function") {
        return r.then(function (s) { return String(s || "unknown"); }, function () { return "unknown"; });
      }
      return Promise.resolve(String(r || "unknown"));
    } catch (e) {
      return Promise.resolve("unknown");
    }
  }

  // 安装端上语言包：必须在用户手势里调用，否则浏览器会拒
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
      "language-not-supported": "这个语言没有端上语言包：可先安装，或改用云端识别",
      "phrases-not-supported": "浏览器不支持自定义短语"
    };
    return map[code] || ("识别出错：" + (code || "未知"));
  }

  /* ---------------- 切段：按停顿把连续文字分成一轮一轮 ---------------- */

  // 浏览器只回文字流。按「静默 idleMs 毫秒」切段，段与段之间就是换人的地方。
  function createSegmenter(idleMs) {
    var gap = idleMs || 1400;
    var buf = "", lastAt = 0;
    function norm(t) {
      var s = String(t == null ? "" : t).trim();
      if (!s) return "";
      // 中文之间不加空格，西文之间补一个
      return s;
    }
    return {
      push: function (text, now) {
        var t = norm(text);
        if (!t) return null;
        buf = buf ? buf + t : t;
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

  function create(opts) {
    opts = opts || {};
    var win = opts.win || (typeof window !== "undefined" ? window : null);
    var C = ctor(win);
    var lang = opts.lang || DEFAULT_LANG;
    var local = opts.local !== false;          // 默认端上
    var seg = createSegmenter(opts.idleMs);
    var rec = null, running = false, restarts = 0, stoppedByUser = false, timer = null;

    function hooks(name, arg) {
      if (typeof opts[name] === "function") { try { opts[name](arg); } catch (e) {} }
    }

    function supported() { return !!C; }

    // 端上不可用时由调用方决定：opts.onNeedChoice
    function open() {
      if (!C) return Promise.resolve("unsupported");
      if (!local) return Promise.resolve(start());
      return localStatus(win, lang).then(function (st) {
        if (st === "available") return start();
        if (st === "downloadable") {
          if (typeof opts.onNeedInstall === "function") opts.onNeedInstall(lang);
          return "need-install";
        }
        if (st === "unknown") {
          // 老浏览器没有 available()：仍尝试 processLocally，失败再报错
          return start();
        }
        if (typeof opts.onNeedChoice === "function") opts.onNeedChoice(lang);
        return "need-choice";
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
          if (res.isFinal) finals += text; else interim += text;
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
        if (code === "not-allowed" || code === "service-not-allowed") {
          stoppedByUser = true;
          running = false;
        }
      };
      rec.onend = function () {
        // 连续识别会被浏览器在静默后自动结束：只要用户没停，就接着起
        if (!running || stoppedByUser) { hooks("onState", "stopped"); return; }
        if (restarts >= 30) { running = false; hooks("onError", "识别反复中断，已停下；可点「识别」重开"); hooks("onState", "stopped"); return; }
        restarts += 1;
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
      restarts = 0;
      hooks("onState", local ? "listening-local" : "listening-remote");
      // 自己盯着停顿：浏览器不告诉我们“这句停了”，只能按时间判
      if (timer) clearInterval(timer);
      timer = setInterval(function () {
        var s = seg.idle(Date.now());
        if (s) hooks("onSegment", s);
      }, 400);
      return Promise.resolve("running");
    }

    function stop() {
      stoppedByUser = true;
      running = false;
      if (timer) { clearInterval(timer); timer = null; }
      var last = seg.flush();
      if (last && typeof opts.onSegment === "function") opts.onSegment(last);
      if (rec) { try { rec.stop(); } catch (e) {} }
      rec = null;
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
      setLang: setLang,
      setLocal: setLocal,
      isRunning: isRunning,
      current: current,
      localStatus: function () { return localStatus(win, lang); },
      installLocal: function () { return installLocal(win, lang); }
    };
  }

  return {
    VERSION: VERSION,
    DEFAULT_LANG: DEFAULT_LANG,
    LANGS: LANGS,
    ctor: ctor,
    localStatus: localStatus,
    installLocal: installLocal,
    errorText: errorText,
    createSegmenter: createSegmenter,
    create: create
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = ASR;