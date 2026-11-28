// v3.1 新增的两项算法能力的离线断言：归一化编辑相似度（levRatio）与字符级差异（charDiff）。
// 引用出处：归一化 Levenshtein 口径同 RapidFuzz（MIT）；字符级对齐思路同 jsdiff 的 Myers 差分（BSD-3-Clause）。
// 本文件只验证「移植进单文件后的行为」，不改动任何既有口径。
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

const tr = fs.readFileSync(path.join(__dirname, "samples", "样例_转录.txt"), "utf8");
const todo = fs.readFileSync(path.join(__dirname, "samples", "样例_待办.csv"), "utf8");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}：得到 ${got}，期望 ${want}`); };
const near = (name, got, want, tol) => { if (Math.abs(got - want) > tol) fails.push(`${name}：得到 ${got}，期望≈${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 归一化编辑相似度：性质与对拍
ok("导出 levRatio 与 charDiff", typeof QC.levRatio === "function" && typeof QC.charDiff === "function");
eq("相同串相似度=1", QC.levRatio("新用户引导漏斗", "新用户引导漏斗"), 1);
eq("空对空=1", QC.levRatio("", ""), 1);
eq("空对非空=0", QC.levRatio("", "abc"), 0);
// 6 字里改 1 字：编辑距离 1，max=6 → 1 - 1/6
near("改一字相似度=5/6", QC.levRatio("abcdef", "abcxef"), 1 - 1 / 6, 1e-9);
// 4 字里插 1 字：编辑距离 1，max=5 → 1 - 1/5
near("插一字相似度=4/5", QC.levRatio("abcd", "abcdX"), 1 - 1 / 5, 1e-9);
// 对称性：交换参数结果不变（归一化分母取较长者）
near("对称性", QC.levRatio("支付回调重复通知", "支付回调重复"), QC.levRatio("支付回调重复", "支付回调重复通知"), 1e-9);
ok("单调：越像越高", QC.levRatio("压测环境周四准备好", "压测环境周四准备好") > QC.levRatio("压测环境周四准备好", "压测环境周四"));

// ---------- 2 字符级差异：方向与容量
eq("相同串无差异", QC.charDiff("同样的句子", "同样的句子").length, 0);
const d1 = QC.charDiff("压测环境周四准备好", "压测环境周五准备好");
ok("改一字给出一段差异", d1.length >= 1);
ok("「缺」= 原文有而依据没有", d1.some((d) => d.op === "缺" && d.text.includes("四")));
ok("「多」= 依据有而原文没有", d1.some((d) => d.op === "多" && d.text.includes("五")));
const d2 = QC.charDiff("拿到报价单", "拿到报价单并归档，同时发项目群，抄送财务与法务，本周内完成");
ok("依据多出内容 → 「多」", d2.some((d) => d.op === "多"));
ok("差异最多两段", d2.length <= 2);
ok("每段最多 12 字", d2.every((d) => d.text.length <= 12));

// ---------- 3 接入既有链路：locate / graded / receipt 都带上新字段
const ls = QC.splitLines(tr);
const loc = QC.locate(ls, "王睿，你把新用户引导的漏斗数据拉出来，按渠道拆一下，下周二之前给我。");
ok("改写句落位正确", loc && loc.line === 3);
near("改写句相似度约 0.667", loc.lev, 0.667, 0.02);
ok("改写句差异反映方向", loc.diff.some((d) => d.op === "缺") && loc.diff.some((d) => d.op === "多"));
const locExact = QC.locate(ls, "新用户引导的漏斗数据我拉一下，按渠道拆，下周二之前给你。");
eq("逐字句相似度=1", Math.round(locExact.lev * 1000) / 1000, 1);
ok("逐字句无差异", locExact.diff.length === 0);
ok("locate 带 diff 数组", loc && Array.isArray(loc.diff));

const ctx = QC.run(tr, todo, {});
const G = QC.graded(ctx);
ok("graded 有条目", G.length > 0);
ok("graded 每行有相似度", G.every((g) => typeof g.相似度 === "number"));
ok("graded 每行有差异数组", G.every((g) => Array.isArray(g.差异)));
// 样例 6 条：逐字引用应恰好 1.00，改写应明显低于 1；且「覆盖比高、相似度低」的反差要存在——
// 这正是两个指标互补的证据（覆盖比只看漏没漏，相似度看改了多少）。
ok("逐字引用相似度恰为 1", G.filter((g) => g.相似度 === 1).length === 2);
ok("改写条目相似度低于 0.8", G.filter((g) => g.相似度 < 0.8).length >= 2);
ok("存在「覆盖高但改写多」的反差", G.some((g) => g.覆盖 >= 0.85 && g.相似度 <= 0.5));
ok("覆盖比与相似度不完全同向", G.filter((g) => Math.abs(g.覆盖 - g.相似度) > 0.3).length >= 2);

const rec = QC.receipt(ctx);
eq("回执版本随能力升级", rec.tool, "会议待办质检器 v3.3");
ok("回执 evidence 带 lev", rec.items.every((it) => typeof it.evidence.lev === "number"));
ok("回执 evidence 带 diff", rec.items.every((it) => Array.isArray(it.evidence.diff)));

// ---------- 4 页面与报告都已呈现（不是只写在引擎里）
ok("页面 F 段有「相似度」表头", /<th>相似度<\/th>/.test(html));
ok("页面 F 段渲染相似度百分比", /\+\s*"%"/.test(html) || html.includes('%") + (dtxt'));
ok("报告 md 表含相似度列", html.includes('"相似度", "指纹"'));
ok("报告写明口径与出处", html.includes("归一化 Levenshtein") && html.includes("Myers 差分"));
ok("工作台零外链", !/(?:src|href)="https?:\/\//.test(html));

// ---------- 5 不引入额外依赖（仍是单文件）
ok("未引入 npm 依赖", !html.includes("require(\"diff\"") && !html.includes("from \"diff\""));

const total = 34;
if (fails.length) {
  console.log(`FAIL ${fails.length} 项：\n- ` + fails.join("\n- "));
  process.exit(1);
}
console.log(`PASS 技术移植 ${total} 项：归一化编辑相似度（对拍 5/6、4/5、对称、单调）+ 字符级差异（缺/多方向、两段上限、12 字上限）+ 接入 locate/graded/receipt + 页面与报告已呈现 + 零外链 + 无新增依赖`);