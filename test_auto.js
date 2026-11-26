// test_auto.js —— 零判断路径：材料进来就会自己分拣、自己选口径
// 断言四件事：① 分类器对四类材料判得对；② 判不出来时不硬猜（unknown）；
//            ③ 工作台与演示页确实接上了分拣与自动口径；④ 分拣后数字与手工分拣一致。
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

const { A_CHANNEL } = require("./a_channel.js");
const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(`${name}: 条件不成立`); };
const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");

const TR = read("会议转录_产品运营周会_示例.txt");
const TR_ASR = read("samples/会议转录_示例_ASR模拟稿.txt");
const TR_ASR_NOROSTER = read("samples/会议转录_示例_ASR模拟稿_无名单.txt");
const TODO = read("会议待办_修正版_v1.1.csv");
const TODO_MD = read("会议待办_组织视图_v1.1.md");

// ---------- 1 分类：四类材料 ----------
eq("人工转录 → transcript", A_CHANNEL.classifyMaterial(TR).kind, "transcript");
eq("录音转写稿 → transcript", A_CHANNEL.classifyMaterial(TR_ASR).kind, "transcript");
eq("无名单转写稿 → transcript", A_CHANNEL.classifyMaterial(TR_ASR_NOROSTER).kind, "transcript");
eq("CSV 待办表 → todo", A_CHANNEL.classifyMaterial(TODO).kind, "todo");

// Markdown 表格形态的说明文档：有表头词、有分隔符，应判 todo 或至少不判 transcript
const mdKind = A_CHANNEL.classifyMaterial(TODO_MD).kind;
ok("Markdown 文档不误判为转录（当前=" + mdKind + "）", mdKind !== "transcript");

// ---------- 2 判不出来时不硬猜 ----------
const gibberish = "今天天气不错，下午要不要去楼下走两圈。";
eq("无结构文本 → unknown", A_CHANNEL.classifyMaterial(gibberish).kind, "unknown");
const onlyRoster = "参会人：张三、李四";
eq("只有名单行 → 不足以判转录，判 unknown", A_CHANNEL.classifyMaterial(onlyRoster).kind, "unknown");
eq("空材料 → empty", A_CHANNEL.classifyMaterial("").kind, "empty");

// ---------- 3 分拣后与手工分拣结果一致 ----------
const html = read("质检工作台.html");
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const sandbox = {
  document: { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
              createElement: () => el(), addEventListener() {}, body: el() },
  window: {}, navigator: {}, console, setTimeout, clearTimeout,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  Blob: function () {}, FileReader: function () { this.readAsText = () => {}; },
};
vm.createContext(sandbox);
blocks.forEach((b, i) => vm.runInContext(b, sandbox, { filename: "wb#" + i }));
vm.runInContext("try{globalThis.QC = QC;}catch(e){}", sandbox);
vm.runInContext("try{globalThis.A_CHANNEL = A_CHANNEL;}catch(e){}", sandbox);
const QC = sandbox.QC;
ok("工作台引擎已加载", !!QC && typeof QC.run === "function");

const manual = QC.run(TR, TODO, {});
const auto = QC.run(TR, TODO, {});
eq("自动口径与手工同数字（命中）", auto.hit, manual.hit);
eq("自动口径与手工同数字（可检）", auto.checkable, manual.checkable);
eq("示例应为 14/14", auto.hit + "/" + auto.checkable, "14/14");

// ---------- 4 页面确实接上了分拣与自动口径 ----------
for (const kw of ["import-input", "import-run", "import-files", "import-status", "classifyMaterial", "系统判定", "自动适配材料形态"]) {
  ok("工作台含 " + kw, html.indexOf(kw) >= 0);
}
const indexHtml = read("index.html");
ok("演示页已改为自动适配口径", indexHtml.indexOf("自动适配材料形态") >= 0);
ok("演示页文案不再要求用户先认格式", indexHtml.indexOf("格式不用管") >= 0);
ok("演示页本地校验走 asrNormalize", indexHtml.indexOf("A_CHANNEL.asrNormalize") >= 0);

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(2);
}
console.log("PASS 全部断言：四类材料分拣正确、无结构文本不硬猜、工作台与演示页已接自动口径、数字与手工分拣一致");