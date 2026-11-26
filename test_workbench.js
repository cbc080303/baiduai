// 质检工作台.html 的离线逻辑测试：不依赖浏览器，用 vm + DOM stub 跑样例与三组反例。
// 目标：① 与客户端 qc.py --demo 口径一致；② 输入不达标时给「不可检 / 体检提示」，而不是 0 分结论。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");

function el() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "",
    style: {}, files: null,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, appendChild() {}, remove() {}, click() {},
  };
}
const doc = {
  getElementById: () => el(), querySelector: () => el(), createElement: () => el(),
  addEventListener() {}, body: el(),
};
const sandbox = {
  document: doc, window: {}, navigator: {}, console, setTimeout, clearTimeout,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  Blob: function () {},
  FileReader: function () { this.readAsText = () => {}; },
};
vm.createContext(sandbox);

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length !== 2) {
  console.error("期望 2 个内联 script（A 通道 / 引擎+界面），实际", blocks.length);
  process.exit(2);
}
try {
  blocks.forEach((b, i) => vm.runInContext(b, sandbox, { filename: "block" + i + ".js" }));
} catch (e) {
  console.error("内联脚本执行失败：", e.message);
  process.exit(2);
}
vm.runInContext("globalThis.__qc = QC;", sandbox);
const QC = sandbox.__qc;

const tr = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_转录.txt"), "utf8");
const todo = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_待办.csv"), "utf8");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };

// ---------- 1 基准：与 qc.py --demo 对齐
const c = QC.run(tr, todo, {});
eq("依据条数", c.total, 6);
eq("可检条数", c.checkable, 6);
eq("不可检", c.uncheckable, 0);
eq("命中", c.hit, 3);
eq("不匹配编号", c.quotes.filter((q) => q.checkable && !q.hit).map((q) => q["编号"]).join(","), "1,2,4");
eq("待办条数", c.rows.length, 6);
eq("遗漏候选", c.a.cands.length, 1);
eq("候选人物", c.a.cands.length ? c.a.cands[0]["人物"] : "-", "李思远");
eq("可直接建单", c.readiness["可直接建单"], 3);
eq("需补字段", c.readiness["需补字段"], 0);
eq("待人工判断", c.readiness["待人工判断"], 3);
eq("#4 字段状态", c.fields[3]["字段状态"], "缺负责人+缺截止");
eq("#6 字段状态", c.fields[5]["字段状态"], "缺负责人");
eq("软要求候选", c.soft.length, 0);
eq("基准无体检阻断", c.preflight.issues.filter((x) => x.level === "block").length, 0);

const md = QC.report(c);
if (!md.includes("3/6 命中")) fails.push("报告缺少 3/6 命中");
if (!md.includes("## 四、边界与口径")) fails.push("报告缺少边界段");
if (!md.includes("输入体检：通过")) fails.push("报告缺少输入体检结论");
const csv = QC.csv(c);
eq("CSV 行数（含表头）", csv.trim().split("\r\n").length, 7);

// ---------- 2 反例 A：纪要正文当转录
const minutes = "本次会议围绕改版节奏展开。新用户引导漏斗数据需按渠道拆分，下周二前提交。支付回调重复通知本周五前修复，先灰度10%。落地页出两版视觉。";
const c2 = QC.run(minutes, todo, {});
eq("反例A 命中", c2.hit, 0);
eq("反例A 有阻断提示", c2.preflight.issues.filter((x) => x.level === "block").length >= 1, true);
if (!c2.a.warn) fails.push("反例A 应提示 A 通道不可用");
if (!QC.report(c2).includes("输入体检：**")) fails.push("反例A 报告应显示体检提示数");

// ---------- 3 反例 B：待办表缺依据列
const noQuote = "编号,任务,负责人,截止时间\n1,拉数据,王睿,下周二前\n2,修回调,李思远,本周五前";
const c3 = QC.run(tr, noQuote, {});
eq("反例B 可检", c3.checkable, 0);
eq("反例B 不可检", c3.uncheckable, 2);
eq("反例B 命中", c3.hit, 0);
eq("反例B 分档不因缺依据扣分", c3.readiness["可直接建单"], 2);
if (!QC.report(c3).includes("不可检")) fails.push("反例B 报告应写出不可检");
if (!QC.csv(c3).includes("不可检")) fails.push("反例B 标注 CSV 应写不可检");
if (!c3.preflight.issues.some((x) => x.text.includes("原文依据"))) fails.push("反例B 体检应点名缺依据列");

// ---------- 4 反例 C：全角空格（默认归一化应救回来）
const spaced = tr.replace(/：/g, "： ").replace(/，/g, "， ");
eq("反例C 默认归一化", QC.run(spaced, todo, {}).hit, 3);
eq("反例C 严格模式", QC.run(spaced, todo, { ignoreSpace: false }).hit, 0);

// ---------- 5 解析
eq("Markdown 表格解析", QC.parseRows("| 编号 | 任务 | 负责人 |\n|---|---|---|\n| 1 | 写周报 | 张三 |").length, 1);
eq("TSV 解析", QC.parseRows("编号\t任务\t负责人\n1\t写周报\t张三").length, 1);

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PASS 25 项：基准 3/6（可检 6）、候选 1 条、分档 3/0/3、#4 #6 字段、体检与报告结构；三组反例（纪要正文 / 缺依据列 / 全角空格）均按预期处理");
console.log("报告字数（含标点）:", md.length, "| CSV 字节:", Buffer.byteLength(csv, "utf8"));