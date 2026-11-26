// 语音识别接线：切段、错误码、端上/云端选择、换人条、文案诚实性，
// 以及本轮修的缺陷：西文粘连、停止兜底、重启限流、换人归属、会话时间码。
// 真实麦克风与端上语言包依赖浏览器，不在此列；页面另有降级与文案断言。
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

// ---------- 2 错误码转人话：不把 network 直接甩给用户
ok("network 提示端上不需要网络", A.errorText("network").includes("端上识别不需要网络"));
ok("麦克风被拒给做法", A.errorText("not-allowed").includes("允许"));
ok("语言包缺失给替代", A.errorText("language-not-supported").includes("语言包"));
ok("未知码兜底", A.errorText("xyz").includes("xyz"));

// ---------- 3 能力探测：没有 SpeechRecognition 时不假装支持
eq("无接口时 ctor 为 null", A.ctor({}), null);
ok("无接口时不支持", A.create({ win: {} }).supported() === false);
eq("默认语言", A.DEFAULT_LANG, "zh-CN");
eq("可选语言数", A.LANGS.length, 3);

// ---------- 4 端上优先：available 决定走端上还是让用户选
let askedInstall = false;
function FakeSR() {}
FakeSR.available = () => Promise.resolve("downloadable");
FakeSR.install = () => Promise.resolve(true);
const needInstall = A.create({
  win: { SpeechRecognition: FakeSR },
  onNeedInstall: () => { askedInstall = true; }
});
needInstall.open().then((r) => {
  eq("语言包可下载时不硬跑", r, "need-install");
  ok("并回调告知需要安装", askedInstall === true);
});

function FakeSR2() {}
FakeSR2.available = () => Promise.resolve("available");
FakeSR2.prototype.processLocally = false;   // 真实 Chrome 实例原型上有这个属性，桩要跟上，否则测不到端上分支
let started = null, segments = [], states = [];
FakeSR2.prototype.start = function () { started = this; };
FakeSR2.prototype.stop = function () {};
const live = A.create({
  win: { SpeechRecognition: FakeSR2 },
  lang: "zh-CN",
  idleMs: 60,
  onSegment: (s) => segments.push(s),
  onState: (s) => states.push(s)
});
live.open().then((r) => {
  eq("端上可用即开", r, "running");
  ok("识别器设了端上", started && started.processLocally === true);
  ok("开了连续与中间结果", started.continuous === true && started.interimResults === true);
  started.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "周会开始。" } }] });
  eq("端上状态", states[0], "listening-local");
  setTimeout(() => {
    eq("停顿后交付一段", segments.join("|"), "周会开始。");
    live.stop();
    eq("停止后状态", states[states.length - 1], "stopped");
    checkSpeech2().then(checkPage);
  }, 700);
});

// ---------- 5 本轮修的缺陷
function checkSpeech2() {
  // 5.1 西文跨段不粘连（以前 "hello"+"world" 会变成 helloworld）
  eq("西文跨段补空格", A.joinText("hello", "world"), "hello world");
  eq("数字与字母之间补空格", A.joinText("3", "items"), "3 items");
  eq("中文不加空格", A.joinText("今天三件事。", "先看漏斗。"), "今天三件事。先看漏斗。");
  eq("中文接西文不加空格", A.joinText("看完", "funnel"), "看完funnel");
  eq("全角标点后不加空格", A.joinText("好的，", "继续"), "好的，继续");
  const s2 = A.createSegmenter(60);
  s2.push("hello", 1000);
  s2.push("world", 1050);
  eq("切段后西文不粘连", s2.flush(), "hello world");

  // 5.2 没有识别接口时，新接口不能炸
  const none = A.create({ win: {} });
  eq("无接口 flushNow 安全", none.flushNow(), null);
  ok("无接口 discard 安全", none.discard() === true);

  // 每例一个独立假接口：共用同一个实例变量会被其它用例的 start() 覆盖，
  // 断言就会打到别人的识别器上（上一轮就踩过这个坑）。
  function makeFake() {
    const box = { inst: null, stopped: 0 };
    function C() {}
    C.available = () => Promise.resolve("available");
    C.prototype.processLocally = false;
    C.prototype.start = function () { box.inst = this; };
    C.prototype.stop = function () { box.stopped += 1; };
    return { C, box };
  }

  // 5.3 stop 时回调抛错也必须把识别器停掉，否则麦克风不释放
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

  // 5.4 一分钟内反复中断要停并说明，而不是无限重启
  const errs = [];
  const f2 = makeFake();
  const flood = A.create({
    win: { SpeechRecognition: f2.C },
    onError: (m) => errs.push(m),
    onState: () => {}
  });
  const p2 = flood.start().then(() => {
    for (let i = 0; i < 9; i++) f2.box.inst.onend();
    ok("反复中断会停并说明原因", errs.some((m) => m.includes("反复中断")));
    ok("限流后不再运行", flood.isRunning() === false);
    flood.stop();     // 限流已让它停了，这里再收一次定时器，别让测试进程挂着不退
  });

  // 5.5 flushNow 立即交付半句、且不影响运行状态；discard 丢掉没落段的半句
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

// ---------- 6 页面接线与文案诚实性
function checkPage() {
  const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");
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
  ok("页面明写识别不区分说话人", html.includes("不区分谁在说"));
  ok("页面明写浏览器端没有声纹分离", html.includes("没有声纹分离"));
  ok("识别说明在记录卡内可见", html.includes('id="rec-asr-note"'));
  ok("隐私口径加了限定（质检本机 / 识别可选）", html.includes("语音识别是可选项"));
  ok("录像卡不冒充能识别录像", html.includes("不处理已上传的录像文件"));
  ok("页面写明换人前先按旧名落半句", html.includes("还没到停顿的半句"));
  ok("页面写明不录音也有时间码", html.includes("不录音也有会话时间码"));
  ok("页面写明识别与录音可同时开", html.includes("同时开") && html.includes("audio-capture"));
  ok("浮窗提示提到云端外发", fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8").includes("云端识别时音频会发给浏览器厂商"));
  ok("页面零外链", !/src="http|href="http|@import url\(http/.test(html));

  const recSrc = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");
  ok("记录器接了识别", recSrc.includes("ASR.create"));
  ok("识别与手工走同一写入路径", recSrc.includes("onSegment") && recSrc.includes("submitText"));
  ok("换人条可渲染与点击", recSrc.includes("function renderSwitch") && recSrc.includes('data-name='));
  ok("识别状态可开关", recSrc.includes("asrOn") && recSrc.includes("asrLabel"));
  ok("语言包缺失有安装路径", recSrc.includes("installLocal"));
  ok("不支持时如实说明", recSrc.includes("这个浏览器没有语音识别接口"));
  ok("换人前先把半句落给旧人", recSrc.includes("function flushTo") && recSrc.includes("pendingWho"));
  ok("手改说话人也同步换人条", recSrc.includes('el.speaker.addEventListener("input", renderSwitch)'));
  ok("识别中改语言会重开而不是静默无效", recSrc.includes("换了识别语言，正按"));
  ok("识别中离开页面会拦", recSrc.includes("asrHot"));
  ok("清空/换记录时丢弃识别残留", recSrc.includes("asrCtl.discard()"));
  ok("meta 记真实识别信息（不再写死 false）", /asr:\s*\(rec\.asr && rec\.asr\.used\)/.test(recSrc));
  ok("只识别不录音也有会话时间码", recSrc.includes("function sessionElapsed") && recSrc.includes("Math.max(byRec, sessionElapsed())"));

  if (fails.length) {
    console.error("FAIL " + fails.length + " 项：");
    fails.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("PASS 语音识别：停顿切段（不压成一段、西文不粘连）、错误码转人话、端上优先（需装包则先装）、端上可用才开并设 processLocally、" +
    "回调抛错也停麦、一分钟内反复中断会停、flushNow/discard、换人前把半句落给旧名、改语言重开、识别中离开会拦、meta 记识别、" +
    "只识别也有会话时间码、页面 7 块内联与控件齐备、默认端上、明写不区分说话人与无说话人分离、零外链");
  process.exit(0);   // 断言里有假的识别实例，退出前收干净，避免定时器把进程吊着不退
}