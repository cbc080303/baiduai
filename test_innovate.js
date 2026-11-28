// v3.0 新增能力的离线断言：字段来源分级 / 依据定位与指纹 / 重复与冲突 / 回执与回执校验。
// 目的：把「创新点」压成机器可判定的项，答辩时不是靠一句「我们做了」。
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");
const indexHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function el() {
  return {
    value: "", checked: false, textContent: "", innerHTML: "", className: "",
    style: {}, files: null, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, setAttribute() {}, getAttribute: () => "false",
    appendChild() {}, remove() {}, click() {}, querySelectorAll: () => [],
  };
}
const doc = {
  getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
  createElement: () => el(), addEventListener() {}, body: el(),
};
const sandbox = {
  document: doc, window: {}, navigator: {}, console, setTimeout, clearTimeout,
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  Blob: function () {}, FileReader: function () { this.readAsText = () => {}; },
};
vm.createContext(sandbox);

const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
[0, 1, 2, 3, 4, 6].forEach((i) => vm.runInContext(blocks[i], sandbox, { filename: "block" + i + ".js" }));
vm.runInContext("globalThis.__qc = QC;", sandbox);
const QC = sandbox.__qc;

const tr = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_转录.txt"), "utf8");
const todo = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_待办.csv"), "utf8");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 依据定位与指纹
const ls = QC.splitLines(tr);
eq("切句数", ls.length, 11);
eq("说话人解析", ls[1].speaker, "张岚");
const loc1 = QC.locate(ls, "王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。");
const loc2 = QC.locate(ls, "王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。");
ok("定位可复现", loc1 && loc2 && loc1.line === loc2.line && loc1.fp === loc2.fp);
ok("指纹是 8 位十六进制", /^[0-9a-f]{8}$/.test(loc1.fp));
ok("定位落在有说话人的句上", loc1.line >= 1 && !!loc1.speaker);
eq("定位到第 3 句", loc1.line, 3);

// ---------- 2 字段来源分级
const ctx = QC.run(tr, todo, {});
const G = QC.graded(ctx);
eq("分级覆盖全部条目", G.length, ctx.rows.length);
eq("本人认领", G.filter((g) => g.来源码 === "self").length, 1);
eq("他人指派", G.filter((g) => g.来源码 === "assigned").length, 3);
eq("无依据（字段空）", G.filter((g) => g.来源码 === "none").length, 2);
eq("#1 来源", G[0].来源码, "self");
eq("#2 来源", G[1].来源码, "assigned");
G.forEach((g) => { ok("#" + g.编号 + " 有定位或明标未定位", !!g.定位); });

// ---------- 3 同句多条 / 疑似重复
const dupTodo = [
  "编号,任务,负责人,截止时间,约束,原文依据",
  "1,拉取新用户引导漏斗数据,王睿,下周二前,按渠道拆分,王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。",
  "2,拉取新用户引导漏斗数据,王睿,下周三前,同一件事登两次,王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。",
].join("\n");
const ctx2 = QC.run(tr, dupTodo, {});
const f2 = QC.findings(ctx2.rows, ls, ctx2.quotes);
ok("同句多条被标出", f2.some((f) => f.type === "同句多条"));
ok("疑似重复被标出", f2.some((f) => f.type === "疑似重复"));
ok("截止冲突被标出", f2.some((f) => f.type === "截止冲突"));
eq("同一样例无结构问题", QC.findings(ctx.rows, ls, ctx.quotes).length, 0);

// ---------- 4 回执
const R = QC.receipt(ctx);
eq("回执 schema", R.schema, "meeting-todo-qc/receipt@1");
eq("回执条数", R.items.length, 6);
ok("转录指纹 8 位", /^[0-9a-f]{8}$/.test(R.transcript.fp));
ok("每条都带依据定位", R.items.every((it) => it.evidence && it.evidence.line > 0 && /^[0-9a-f]{8}$/.test(it.evidence.fp)));
ok("每条都带来源分级", R.items.every((it) => !!it.owner_grade));

// ---------- 5 回执校验：同文通过、改文失败、改回执失败
const v1 = QC.verifyReceipt(R, tr);
eq("同文校验一致条数", v1.ok, 6);
eq("同文校验问题条数", v1.bad.length, 0);
eq("同文转录指纹一致", v1.transcript_ok, true);
const tampered = tr.replace("下周二之前给你", "下周三之前给你");
const v2 = QC.verifyReceipt(R, tampered);
eq("改文后转录指纹不一致", v2.transcript_ok, false);
ok("改文后被改动的条目被抓出", v2.bad.length >= 1);
const R2 = JSON.parse(JSON.stringify(R));
R2.items[0].evidence.fp = "deadbeef";
const v3 = QC.verifyReceipt(R2, tr);
ok("回执被篡改时指纹对不上", v3.bad.length >= 1);

// ---------- 6 演示页同口径
["ownerSource", "locateLine", "fnv1a", "btn-receipt-demo", "__DEMO_RECEIPT"].forEach((k) => {
  ok("演示页含 " + k, indexHtml.includes(k));
});
ok("演示页仍零外链", !/https?:\/\/(?!cbc080303\.github\.io)[^"' )]+\.(js|css|woff2?)/i.test(indexHtml));

console.log("测试项：26");
if (fails.length) {
  console.log("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("PASS 创新点回归 26 项：依据定位可复现 + 指纹格式 + 来源三态分级 + 同句多条/疑似重复/截止冲突 + 回执字段齐备 + 同文通过改文与篡改均被抓 + 演示页同口径且零外链");