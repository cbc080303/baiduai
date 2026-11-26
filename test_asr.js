// test_asr.js —— 录音识别稿（ASR）在工作台与演示页里的行为断言
// 目标：① 形态能被认出并进入体检；② 归一化能把“格式噪声”与“依据问题”分开；
//       ③ 归一化不改变人工稿的任何数字；④ 反推名单能让 A 通道继续可用。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function el() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "",
    style: {}, files: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, appendChild() {}, remove() {}, click() {},
  };
}
function loadPage(file) {
  const html = fs.readFileSync(path.join(__dirname, file), "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const sandbox = {
    document: { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
                createElement: () => el(), addEventListener() {}, body: el() },
    window: {}, navigator: {}, console, setTimeout, clearTimeout,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    Blob: function () {}, FileReader: function () { this.readAsText = () => {}; },
  };
  vm.createContext(sandbox);
  blocks.forEach((b, i) => vm.runInContext(b, sandbox, { filename: file + "#" + i }));
  // script 顶层的 const 不会挂到 globalThis，需要显式中转（与 test_workbench.js 同做法）
  vm.runInContext("try{globalThis.QC = QC;}catch(e){}", sandbox);
  vm.runInContext("try{globalThis.A_CHANNEL = A_CHANNEL;}catch(e){}", sandbox);
  return sandbox;
}

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(`${name}: 条件不成立`); };

// 把人工稿改写成 ASR 形态：逐句一行 + 行首时间码 + 去句末标点 + 一处“听不清”
function toAsr(raw) {
  const out = [];
  let seq = 0;
  String(raw).split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (/^参会人[：:]/.test(t)) { out.push(t); return; }
    const m = t.match(/^([\u4e00-\u9fa5]{1,4})[：:](.*)$/);
    if (!m) return;
    (m[2].match(/[^。！？；]*[。！？；]|[^。！？；]+/g) || []).forEach((s) => {
      let sent = s.trim().replace(/[。！？；]+$/, "");
      if (!sent) return;
      const total = seq * 9 + 5;
      const hh = String(Math.floor(total / 3600)).padStart(2, "0");
      const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
      const ss = String(total % 60).padStart(2, "0");
      if (seq === 2) sent += " [听不清]";
      out.push(`[${hh}:${mm}:${ss}] ${m[1]}：${sent}`);
      seq++;
    });
  });
  return out.join("\n") + "\n";
}

const tr = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_转录.txt"), "utf8");
const todo = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_待办.csv"), "utf8");
const asrTr = toAsr(tr);
const noRoster = asrTr.split(/\r?\n/).filter((l) => !/^参会人[：:]/.test(l)).join("\n") + "\n";

// ---------- 工作台 ----------
const wb = loadPage("质检工作台.html");
const QC = wb.QC, AC = wb.A_CHANNEL;
ok("工作台 QC 与 A_CHANNEL 已加载", !!QC && !!AC);

const base = QC.run(tr, todo, {});
const asrCtx = QC.run(asrTr, todo, {});
const asrNoRoster = QC.run(noRoster, todo, {});
const strictCtx = QC.run(asrTr, todo, { ignoreSpace: false });

const d = AC.detectAsr(asrTr);
ok("形态判定：is_asr", d.is_asr === true);
eq("形态判定：form", d.form, "timestamp+speaker");
ok("形态判定：时间码覆盖 ≥0.9", d.ts_ratio >= 0.9);
ok("形态判定：识别占位 ≥1", d.placeholder >= 1);

const hasAsrIssue = (asrCtx.preflight.issues || []).some((x) => String(x.text).indexOf("录音转写稿") >= 0);
ok("体检出现「录音转写稿」条目", hasAsrIssue);
ok("体检条目标为信息级", (asrCtx.preflight.issues || []).some((x) => x.level === "info" && String(x.text).indexOf("录音转写稿") >= 0));

eq("工作台·人工稿命中", base.hit, 3);
eq("工作台·ASR 稿归一化后命中", asrCtx.hit, base.hit);
eq("工作台·ASR 稿可检条数", asrCtx.checkable, base.checkable);
eq("工作台·ASR 稿不匹配编号", asrCtx.quotes.filter((q) => q.checkable && !q.hit).map((q) => q["编号"]).join(","), "1,2,4");
// 严格模式的证据要用带句末标点的大样例：小样例里有几条依据末尾本来没有标点，
// 严格模式会残留命中，不能当反例。这里与 Python 端 asr_lab 的 0/14 同口径。
const trBig = fs.readFileSync(path.join(__dirname, "会议转录_产品运营周会_示例.txt"), "utf8");
const todoBig = fs.readFileSync(path.join(__dirname, "会议待办_修正版_v1.1.csv"), "utf8");
const asrBig = toAsr(trBig);
const bigHuman = QC.run(trBig, todoBig, {});
const bigAsr = QC.run(asrBig, todoBig, {});
const bigStrict = QC.run(asrBig, todoBig, { ignoreSpace: false });
eq("工作台·示例人工稿命中 14/14", bigHuman.hit + "/" + bigHuman.checkable, "14/14");
eq("工作台·示例ASR稿归一化命中 14/14", bigAsr.hit + "/" + bigAsr.checkable, "14/14");
eq("工作台·示例ASR稿严格命中 0/14", bigStrict.hit, 0);

// 反推只认出现 ≥2 次的说话人标签：样例里只发过一次言的人会被漏掉，这是保守设计的代价，
// 所以断言“至少 3 人 + 仍能出候选 + 有提示”，不假装等价于完整名单。
ok("工作台·无名单稿反推人数 ≥3", (asrNoRoster.names || []).length >= 3);
ok("工作台·无名单稿仍能出候选", asrNoRoster.a.cands.length >= 1);
ok("工作台·无名单稿给出反推提示", String(asrNoRoster.a.warn || "").indexOf("反推") >= 0);

// 报告里必须能看出输入形态，而不是把 ASR 稿当人工稿
const rep = QC.report ? QC.report(asrCtx) : "";
ok("报告标注录音转写稿", String(rep).indexOf("录音转写稿") >= 0);
ok("报告含转写形态指标行", String(rep).indexOf("转写形态") >= 0);
ok("报告体检三态（信息）", String(rep).indexOf("[信息]") >= 0);

// ---------- 演示页（直接加载 a_channel.js，避免整页渲染对 DOM stub 的依赖） ----------
const { A_CHANNEL: PA } = require("./a_channel.js");
ok("演示页 A 通道已加载", !!PA && typeof PA.detectAsr === "function");
const pd = PA.detectAsr(asrTr);
ok("演示页形态判定：is_asr", pd.is_asr === true);
eq("演示页形态判定：form", pd.form, "timestamp+speaker");
const scan = PA.scan(noRoster, [{ "编号": "1", "任务": "x", "负责人": "", "截止时间": "", "约束": "", "原文依据": "" }]);
ok("演示页·无名单稿反推人数 ≥3", (scan.names || []).length >= 3);
eq("演示页·无名单稿切句数", scan.count, 10);
ok("演示页·给出反推提示", String(scan.warn || "").indexOf("反推") >= 0);

// 归一化对照：同一份 ASR 稿，去噪前后应能看出差异
const normBefore = PA.asrNormalize(asrTr);
ok("归一化去掉时间码", normBefore.indexOf("[00:") < 0);
ok("归一化去掉占位", normBefore.indexOf("听不清") < 0);
ok("归一化去掉标点", !/[。！？；，、]/.test(normBefore));

// 页面侧接入：内联 A 通道 + 本地校验确实走了 asrNormalize
const pageHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
ok("演示页已内联 ASR 能力", pageHtml.indexOf("detectAsr") >= 0 && pageHtml.indexOf("asrNormalize") >= 0);
ok("演示页本地校验已接入 ASR 归一化", pageHtml.indexOf("A_CHANNEL.asrNormalize") >= 0);
ok("工作台已接入 ASR 归一化", fs.readFileSync(path.join(__dirname, "workbench.html"), "utf8").indexOf("A_CHANNEL.asrNormalize") >= 0);

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(2);
}
console.log("PASS 全部断言：工作台与演示页均能识别录音转写稿、归一化后命中不降、13 条大样例在严格模式整表失效、无名单稿能反推人名并继续出候选");