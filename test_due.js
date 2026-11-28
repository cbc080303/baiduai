// v3.2 新增的两项归一能力：截止时间写法归一（dueKey）与负责人主责归一（ownerMainKey）。
// 出处声明：时间归一的做法参考 Time-NLP 系列（Java 原版 shinyke/Time-NLP；Python3 移植 PyPI ChineseDateTimeNLP 标 MIT Licence），
// 本实现未复制源码，只移植「同义时间写法映射到同一结构键」这一子集，且不做未来倾向推断。
// 主责归一为本地设计，无外部来源。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");
function el() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "",
    style: {}, files: null, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute: () => "false",
    appendChild() {}, remove() {}, click() {}, querySelectorAll: () => [],
  };
}
const doc = { getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [], createElement: () => el(), addEventListener() {}, body: el() };
const sandbox = { document: doc, window: {}, navigator: {}, console, setTimeout, clearTimeout,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, Blob: function () {}, FileReader: function () { this.readAsText = () => {}; } };
vm.createContext(sandbox);
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  .forEach((b, i) => { if ([0, 1, 2, 3, 4, 6].includes(i)) vm.runInContext(b, sandbox, { filename: "b" + i }); });
vm.runInContext("globalThis.__qc = QC;", sandbox);
const QC = sandbox.__qc;

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.log("FAIL", name); } };
const eq = (name, got, want) => ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`, got === want);
const ne = (name, got, not) => ok(`${name}（得到 ${JSON.stringify(got)}，不应等于 ${JSON.stringify(not)}）`, got !== not);

// ---------- dueKey：同一时点的不同写法必须归到同一个键
const k = (s) => QC.dueKey(s);
eq("本周五 键", k("本周五"), "周+0|5");
eq("这周五 与 本周五 同键", k("这周五"), k("本周五"));
eq("周五前 与 本周五 同键", k("周五前"), k("本周五"));
eq("这周五之前 与 本周五 同键", k("这周五之前"), k("本周五"));
eq("星期五 = 周五", k("星期五"), k("周五"));
eq("礼拜五 = 周五", k("礼拜五"), k("周五"));
ne("下周五 ≠ 本周五", k("下周五"), k("本周五"));
eq("下周三之前 与 下周三 同键", k("下周三之前"), k("下周三"));
ne("下周三 ≠ 本周三", k("下周三"), k("本周三"));
eq("下个月10号前 = 下月10日", k("下个月10号前"), k("下月10日"));
eq("下个月10号 键", k("下个月10号前"), "月+1|10");
eq("9月30日 = 9月30号", k("9月30日"), k("9月30号"));
eq("9月30日 键", k("9月30日"), "月日|9|30");
ne("月底 ≠ 月初", k("月底"), k("月初"));
eq("今天/明日/后天 三天各不同", new Set([k("今天"), k("明天"), k("后天")]).size, 3);
eq("3天内 键", k("3天内"), "天+3");
eq("不可解析（评审会前）返回空", k("评审会前"), "");
eq("占位符（待确认）返回空", k("待确认"), "");
ok("同一写法的键稳定（幂等）", k("本周五") === k("本周五"));

// ---------- ownerMainKey：复合负责人与单人必须等价，但集合不同的不能合并
const om = (s) => QC.ownerMainKey(s);
eq("赵敏（主）／陈晨（配合）= 赵敏", om("赵敏（主）／陈晨（配合）"), om("赵敏"));
eq("赵敏（主）／陈晨（配合） 键", om("赵敏（主）／陈晨（配合）"), "赵敏");
ne("王睿、张岚 ≠ 王睿（不放松成交集非空）", om("王睿、张岚"), om("王睿"));
eq("甲、乙 与 乙、甲 同键", om("甲、乙"), om("乙、甲"));
eq("待确认 返回空", om("待确认"), "");
eq("纯配合方无主责时退回原串", om("陈晨（配合）"), "陈晨（配合）");
eq("带括号角色不影响主责", om("赵敏（主责）"), "赵敏");

// ---------- 集成：截止冲突按写法归并
const TR = "参会人：赵敏、陈晨、王睿、张岚\n" +
  "赵敏：下周三之前把改版落地页文案输出。\n" +
  "赵敏：这周五前把展架尺寸确认了。\n";
const head = "编号,任务,负责人,截止时间,约束,原文依据\n";
const q = "赵敏：这周五前把展架尺寸确认了";

// 同一依据句、两种写法、同一时点 → 不应报截止冲突
const r1 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,赵敏,本周五,,${q}\n` +
  `2,确认展架尺寸,赵敏,这周五之前,,${q}\n`, {});
const f1 = QC.findings(r1.rows, QC.splitLines(TR), r1.quotes);
ok("同句两种写法（本周五/这周五之前）不报截止冲突", !f1.some((x) => x.type === "截止冲突"));
ok("同句两条仍报「同句多条」", f1.some((x) => x.type === "同句多条"));

// 同一依据句、确实不同时点 → 必须报截止冲突
const r2 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,赵敏,本周五,,${q}\n` +
  `2,确认展架尺寸,赵敏,下周五,,${q}\n`, {});
ok("同句 本周五 vs 下周五 报截止冲突", QC.findings(r2.rows, QC.splitLines(TR), r2.quotes).some((x) => x.type === "截止冲突"));

// 不可解析的两个截止 → 退回原串比较，仍报冲突
const r3 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,赵敏,评审会前,,${q}\n` +
  `2,确认展架尺寸,赵敏,上线前,,${q}\n`, {});
ok("不可解析的两个截止仍报冲突（原串兜底）", QC.findings(r3.rows, QC.splitLines(TR), r3.quotes).some((x) => x.type === "截止冲突"));

// ---------- 集成：负责人冲突与疑似重复按主责比较
const r4 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,赵敏（主）／陈晨（配合）,本周五,,${q}\n` +
  `2,确认展架尺寸,赵敏,本周五,,${q}\n`, {});
const f4 = QC.findings(r4.rows, QC.splitLines(TR), r4.quotes);
ok("主责相同的复合负责人不报负责人冲突", !f4.some((x) => x.type === "负责人冲突"));
ok("复合负责人与单人主责判为疑似重复", f4.some((x) => x.type === "疑似重复"));

// 集合不同 → 不能判重复（否则判据被放松）
const r5 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,王睿,本周五,,${q}\n` +
  `2,确认展架尺寸,王睿、张岚,本周五,,${q}\n`, {});
ok("王睿 vs 王睿、张岚 不判疑似重复", !QC.findings(r5.rows, QC.splitLines(TR), r5.quotes).some((x) => x.type === "疑似重复"));

// 原行为不能丢：不同负责人、待确认都不判重复
const r6 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,王睿,本周五,,${q}\n` +
  `2,确认展架尺寸,张岚,本周五,,${q}\n`, {});
ok("不同负责人不判疑似重复", !QC.findings(r6.rows, QC.splitLines(TR), r6.quotes).some((x) => x.type === "疑似重复"));
const r7 = QC.run(TR, head +
  `1,确认市场物料展架尺寸,待确认,本周五,,${q}\n` +
  `2,确认展架尺寸,待确认,本周五,,${q}\n`, {});
ok("负责人待确认不判疑似重复", !QC.findings(r7.rows, QC.splitLines(TR), r7.quotes).some((x) => x.type === "疑似重复"));

// ---------- 回执兼容性：新增字段不破 schema 与指纹
ok("回执 schema 未变（receipt@1）", html.indexOf("meeting-todo-qc/receipt@1") >= 0);
ok("tool 版本已升 v3.3", html.indexOf("会议待办质检器 v3.3") >= 0);
ok("页面无新增外链", !/https?:\/\/(?!www\.w3\.org)/.test(html.replace(/<!--[\s\S]*?-->/g, "")));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} 时间与负责人归一 ${pass + fail} 项：截止写法归并（周/月/日/天数/不可解析兜底）+ 主责集合等价 + 判据未放松的反例（王睿 vs 王睿、张岚）+ 回执 schema 与指纹口径未变`);
if (fail) process.exit(1);