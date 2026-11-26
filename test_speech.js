// 语音识别接线：切段、错误码、端上/云端选择、换人条、文案诚实性。
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
    checkPage();
  }, 700);
});

// ---------- 5 页面接线与文案诚实性
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
  ok("浮窗提示提到云端外发", fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8").includes("云端识别时音频会发给浏览器厂商"));
  ok("页面零外链", !/src="http|href="http|@import url\(http/.test(html));

  const recSrc = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");
  ok("记录器接了识别", recSrc.includes("ASR.create"));
  ok("识别与手工走同一写入路径", recSrc.includes("onSegment") && recSrc.includes("submitText"));
  ok("换人条可渲染与点击", recSrc.includes("function renderSwitch") && recSrc.includes('data-name='));
  ok("识别状态可开关", recSrc.includes("asrOn") && recSrc.includes("asrLabel"));
  ok("语言包缺失有安装路径", recSrc.includes("installLocal"));
  ok("不支持时如实说明", recSrc.includes("这个浏览器没有语音识别接口"));

  if (fails.length) {
    console.error("FAIL " + fails.length + " 项：");
    fails.forEach((f) => console.error("  - " + f));
    process.exit(1);
  }
  console.log("PASS 语音识别：停顿切段（不压成一段）、错误码转人话、端上优先（需装包则先装）、端上可用才开并设 processLocally、页面 7 块内联与控件齐备、默认端上、明写不区分说话人与无说话人分离、隐私口径加限定、零外链");
}