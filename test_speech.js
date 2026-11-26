// 语音识别接线：切段、错误码、端上/云端决策、换人条、文案诚实性、
// 缺陷回归（拼接/停表/限流/归属/时间码），以及内置浏览器实测后的两条硬约束：
//   1) 绝不调用 available({processLocally:true})——实测会让渲染进程崩溃；
//   2) Electron 壳整段绕开端上，并靠自动草稿兜住「整页崩了也不丢内容」。
const fs = require("fs");
const path = require("path");
const A = require("./asr.js");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 切段：按静默分段，不把整场压成一段
const seg = A.createSegmenter(1400);
seg.push("今天三件事。", 1000);
seg.push("先看漏斗。", 1100);
eq("未到停顿时不切", seg.idle(1500), null);
eq("停顿到点切一段", seg.idle(2600), "今天三件事。先看漏斗。");
seg.push("王睿：数据我拉。", 3000);
eq("flush 交出剩余", seg.flush(), "王睿：数据我拉。");
eq("flush 后清空", seg.flush(), null);
eq("默认停顿阈值", A.createSegmenter().gap, 1400);

// ---------- 2 错误码转人话
ok("network 提示端上不需要网络", A.errorText("network").includes("端上识别不需要网络"));
ok("麦克风被拒给做法", A.errorText("not-allowed").includes("允许"));
ok("识别包缺失给替代", A.errorText("language-not-supported").includes("平台转写"));
ok("未知码兜底", A.errorText("xyz").includes("xyz"));

// ---------- 3 能力探测：没有接口不假装支持；Electron 被认出
eq("无接口时 ctor 为 null", A.ctor({}), null);
ok("无接口时不支持", A.create({ win: {} }).supported() === false);
eq("默认语言", A.DEFAULT_LANG, "zh-CN");
eq("可选语言数", A.LANGS.length, 3);
eq("认出 Electron", A.riskyLocal({ navigator: { userAgent: "Mozilla/5.0 Chrome/150.0 Electron/43.1.1 Safari/537.36" } }), "electron");
eq("普通 Chrome 无风险", A.riskyLocal({ navigator: { userAgent: "Mozilla/5.0 Chrome/150.0 Safari/537.36" } }), "");
eq("版本号", A.VERSION, "1.2");

// ---------- 4 端上决策：不碰会崩的 processLocally，Electron 绕开端上
let lastInst = null, availableCalls = [];
function FakeSR() {}
FakeSR.available = (arg) => { availableCalls.push(arg); return Promise.resolve("unavailable"); };
FakeSR.install = () => Promise.resolve(true);
FakeSR.prototype.processLocally = false;
FakeSR.prototype.start = function () { lastInst = this; };
FakeSR.prototype.stop = function () {};

let askedChoice = false;
const bad = A.create({
  win: { SpeechRecognition: FakeSR, navigator: { userAgent: "Mozilla/5.0 Chrome/150.0 Safari/537.36" } },
  onNeedChoice: () => { askedChoice = true; }
});
const p4a = bad.open().then((r) => {
  eq("服务不可用时交回页面处理", r, "need-choice");
  ok("并回调告知", askedChoice === true);
  ok("探测不带 processLocally（该参数会崩渲染进程）",
    availableCalls.length > 0 && availableCalls.every((a) => !(a && a.processLocally === true)));
});

let blocked = null;
const elec = A.create({
  win: { SpeechRecognition: FakeSR, navigator: { userAgent: "Mozilla/5.0 Chrome/150.0 Electron/43.1.1 Safari/537.36" } },
  onLocalBlocked: (r) => { blocked = r; }
});
const p4b = elec.open().then((r) => {
  eq("Electron 下仍能启动（走浏览器默认）", r, "running");
  eq("并把环境名交回页面", blocked, "electron");
  ok("且没有强制端上", lastInst && lastInst.processLocally !== true);
  elec.stop();
});

// 端上可用即开：available 返回 available 时直接 start，且实例设了 processLocally
function FakeSR2() {}
FakeSR2.available = () => Promise.resolve("available");
FakeSR2.prototype.processLocally = false;
FakeSR2.prototype.start = function () { started = this; };
FakeSR2.prototype.stop = function () {};
let started = null, segments = [], states = [];
const live = A.create({
  win: { SpeechRecognition: FakeSR2, navigator: { userAgent: "Mozilla/5.0 Chrome/150.0 Safari/537.36" } },
  lang: "zh-CN",
  idleMs: 60,
  onSegment: (s) => segments.push(s),
  onState: (s) => states.push(s)
});
const p4c = live.open().then((r) => {
  eq("端上可用即开", r, "running");
  ok("普通 Chrome 下仍走端上", started && started.processLocally === true);
  ok("开了连续与中间结果", started.continuous === true && started.interimResults === true);
  started.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "周会开始。" } }] });
  eq("端上状态", states[0], "listening-local");
  return new Promise((res) => setTimeout(() => {
    eq("停顿后交付一段", segments.join("|"), "周会开始。");
    live.stop();
    eq("停止后状态", states[states.length - 1], "stopped");
    res();
  }, 700));
});

// ---------- 5 缺陷回归
function checkSpeech2() {
  eq("西文跨段补空格", A.joinText("hello", "world"), "hello world");
  eq("数字与字母之间补空格", A.joinText("3", "items"), "3 items");
  eq("中文不加空格", A.joinText("今天三件事。", "先看漏斗。"), "今天三件事。先看漏斗。");
  eq("中文接西文不加空格", A.joinText("看完", "funnel"), "看完funnel");
  eq("全角标点后不加空格", A.joinText("好的，", "继续"), "好的，继续");
  const s2 = A.createSegmenter(60);
  s2.push("hello", 1000);
  s2.push("world", 1050);
  eq("切段后西文不粘连", s2.flush(), "hello world");

  const none = A.create({ win: {} });
  eq("无接口 flushNow 安全", none.flushNow(), null);
  ok("无接口 discard 安全", none.discard() === true);

  // 每例一个独立假接口：共用实例变量会被别的 start() 覆盖
  function makeFake() {
    const box = { inst: null, stopped: 0 };
    function C() {}
    C.available = () => Promise.resolve("available");
    C.prototype.processLocally = false;
    C.prototype.start = function () { box.inst = this; };
    C.prototype.stop = function () { box.stopped += 1; };
    return { C, box };
  }

  let lastState = "";
  const f1 = makeFake();
  const boom = A.create({
    win: { SpeechRecognition: f1.C },
    idleMs: 5000,
    onSegment: () => { throw new Error("回调炸了"); },
    onState: (s) => { lastState = s; }
  });
  const p1 = boom.start().then(() => {
    f1.box.inst.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "一句话" } }] });
    boom.stop();
    eq("回调抛错也要停麦", f1.box.stopped, 1);
    eq("并且状态落到 stopped", lastState, "stopped");
    ok("停完不再算运行", boom.isRunning() === false);
  });

  const errs = [];
  const f2 = makeFake();
  const flood = A.create({ win: { SpeechRecognition: f2.C }, onError: (m) => errs.push(m), onState: () => {} });
  const p2 = flood.start().then(() => {
    for (let i = 0; i < 9; i++) f2.box.inst.onend();
    ok("反复中断会停并说明原因", errs.some((m) => m.includes("反复中断")));
    ok("限流后不再运行", flood.isRunning() === false);
    flood.stop();
  });

  const got = [];
  const f3 = makeFake();
  const quick = A.create({ win: { SpeechRecognition: f3.C }, idleMs: 5000, onSegment: (s) => got.push(s) });
  const p3 = quick.start().then(() => {
    f3.box.inst.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "半句话" } }] });
    eq("flushNow 交出半句", quick.flushNow(), "半句话");
    ok("flushNow 不改变运行状态", quick.isRunning() === true);
    eq("交付给同一出口", got.join("|"), "半句话");
    f3.box.inst.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "不要这句" } }] });
    quick.discard();
    eq("discard 后没有残留", quick.current(), "");
    quick.stop();
  });

  return Promise.all([p1, p2, p3]).then(() => true);
}

// ---------- 6 页面与源码接线
function checkPage() {
  const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");
  const recSrc = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  eq("内联脚本块数", blocks.length, 7);
  ok("ASR 模块已内联", blocks.some((b) => b.includes("var ASR")) || html.includes("ASR.create"));
  ok("有识别开关", html.includes('id="rec-asr"'));
  ok("有语言选择", html.includes('id="rec-asr-lang"'));
  ok("有识别方式", html.includes('id="rec-asr-mode"'));
  ok("有识别状态", html.includes('id="rec-asr-state"'));
  ok("有换人条", html.includes('id="rec-switch"'));
  ok("默认端上（第一个 option 是 local）", /<select id="rec-asr-mode"[\s\S]{0,200}?<option value="local"/.test(html));
  ok("云端选项写明音频外发", html.includes("音频发给浏览器厂商"));
  ok("明写识别不区分说话人", html.includes("不区分谁在说"));
  ok("明写浏览器端没有声纹分离", html.includes("没有声纹分离"));
  ok("明写换人前先按旧名落半句", html.includes("还没到停顿的半句"));
  ok("明写不录音也有时间码", html.includes("不录音也有会话时间码"));
  ok("明写识别与录音可同时开", html.includes("同时开") && html.includes("audio-capture"));
  ok("明写内置浏览器端上会崩", html.includes("Electron 壳实测会让整页崩"));
  ok("明写有自动草稿可找回", html.includes("记录有自动草稿"));
  ok("录像卡不冒充能识别录像", html.includes("不处理已上传的录像文件"));
  ok("页面零外链", !/src="http|href="http|@import url\(http/.test(html));

  ok("记录器接了识别", recSrc.includes("ASR.create"));
  ok("换人前先把半句落给旧人", recSrc.includes("function flushTo") && recSrc.includes("pendingWho"));
  ok("换环境被拦住时如实说明", recSrc.includes("onLocalBlocked") && recSrc.includes("已实测"));
  ok("改语言会重开而不是静默无效", recSrc.includes("换了识别语言，正按"));
  ok("识别中离开会拦", recSrc.includes("asrHot"));
  ok("清空/换记录时丢弃识别残留", recSrc.includes("asrCtl.discard()"));
  ok("meta 记真实识别信息", /asr:\s*\(rec\.asr && rec\.asr\.used\)/.test(recSrc));
  ok("只识别不录音也有会话时间码", recSrc.includes("function sessionElapsed") && recSrc.includes("Math.max(byRec, sessionElapsed())"));

  // 7 崩溃兜底：自动草稿
  ok("有草稿键", recSrc.includes('"mtr_draft_v2"'));
  ok("落行即存草稿", recSrc.includes("function saveDraft") && (recSrc.match(/saveDraft\(\);/g) || []).length >= 2);
  ok("重开能读回草稿", recSrc.includes("function readDraft"));
  ok("清空会删草稿", recSrc.includes("function dropDraft") && recSrc.includes("dropDraft();"));
  ok("写不进草稿也不中断记录", recSrc.includes("draftOff = true"));
  ok("崩后找回有提示文案", recSrc.includes("已自动找回上次没保存的记录"));

  if (fails.length) {
    console.error("FAIL " + fails.length + " 项：");
    fails.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("PASS 语音识别：" +
    "切段不压成一段、西文不粘连、错误码转人话、" +
    "不调用 available({processLocally})（内置浏览器实测会崩渲染进程）、Electron 绕开端上并如实说明、" +
    "普通 Chrome 仍走端上、回调抛错也停麦、反复中断会停、flushNow/discard、" +
    "换人前把半句落给旧名、改语言重开、识别中离开会拦、meta 记识别、只识别也有会话时间码、" +
    "自动草稿可找回（整页崩了也不丢）、页面 7 块内联与控件齐备、明写不区分说话人与无说话人分离、零外链");
  process.exit(0);
}

Promise.all([p4a, p4b, p4c]).then(() => checkSpeech2()).then(checkPage);