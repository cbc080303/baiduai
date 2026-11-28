// 真实语料重标定 v2：负例从 3 份表扩到 5 份表内部全配对；正例首次使用「真实同编号跨版本对」。
// 与 v1 的差别：
//   1) 负例扩到 223 对（原 117 对），新增 G1 示例周会初稿 6 条（15 对）与修正版 v1.1 14 条（91 对）；
//   2) 不做跨表配对 —— 同一批任务在初稿与修正版里同时出现，跨表配对会产生「真重复」被当成负例；
//   3) 正例新增真实来源：初稿 #k 与修正版 #k 是同一件事的两种写法（k=1..6），
//      第 4 组生成版 #k 与修正版 #k 同理（k=1..9，其中文本完全相同的单列为 exact，不算改写正例）。
// 适用边界：这些表都不是人工 gold 标注，正例对是「同一任务的不同表述」，只用于检验阈值敏感度。
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

const keep = (s) => String(s == null ? "" : s).replace(/\s+/g, "").replace(/[。！？；，、：,.!?;:]/g, "");
function lcs(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}
const cover = (a, b) => (a && b ? lcs(a, b) / Math.max(a.length, b.length) : 0);
function bigrams(s) { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; }
function jaccard(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b); let inter = 0, union = 0;
  new Set([...A.keys(), ...B.keys()]).forEach((k) => { const x = A.get(k) || 0, y = B.get(k) || 0; inter += Math.min(x, y); union += Math.max(x, y); });
  return union ? inter / union : 0;
}
const lev = (a, b) => QC.levRatio(a, b);
const MISSING = new Set(["", "待确认", "-", "—", "无"]);
const score = (t) => Math.max(t.cover, t.lev, t.jac);

// ---------- 五份待办表（表内配对，不跨表）
const SETS = [
  { name: "G1 示例周会·初稿", tr: "agent-src/meeting-todo-qc/samples/样例_转录.txt", csv: "agent-src/meeting-todo-qc/samples/样例_待办.csv" },
  { name: "G1 示例周会·修正v1.1", tr: "会议转录_产品运营周会_示例.txt", csv: "会议待办_修正版_v1.1.csv" },
  { name: "G2 财政部公开实录", tr: "会议转录_公开实录_第2组.txt", csv: "会议待办_生成版_第2组.csv" },
  { name: "G4 内部会·生成版", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_生成版_第4组.csv" },
  { name: "G4 内部会·修正版", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_修正版_第4组.csv" },
];
const tables = {};
const neg = [];
SETS.forEach((S) => {
  const tr = fs.readFileSync(path.join(__dirname, S.tr), "utf8");
  const csv = fs.readFileSync(path.join(__dirname, S.csv), "utf8");
  const rows = QC.run(tr, csv, {}).rows.filter((r) => String(r["任务"] || "").trim());
  tables[S.name] = rows;
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      const ta = keep(a["任务"]), tb = keep(b["任务"]);
      if (!ta || !tb) continue;
      const t = { cover: +cover(ta, tb).toFixed(3), lev: +lev(ta, tb).toFixed(3), jac: +jaccard(ta, tb).toFixed(3) };
      const oa = String(a["负责人"] || "").trim(), ob = String(b["负责人"] || "").trim();
      // 口径与引擎 v3.2 对齐：负责人按主责集合比较（「赵敏（主）／陈晨（配合）」与「赵敏」等价）
      const ka = QC.ownerMainKey(oa), kb = QC.ownerMainKey(ob);
      const sameOwner = !!ka && ka === kb;
      neg.push({ set: S.name, a: String(a["编号"]), b: String(b["编号"]),
        sameOwner: sameOwner, ownerA: ka || oa, ownerB: kb || ob,
        taskA: String(a["任务"]), taskB: String(b["任务"]), ...t, score: +score(t).toFixed(3) });
    }
});

// ---------- 真实同编号跨版本对（同一件事的两种写法）
const pairs = [];
function linkVersion(leftSet, rightSet, maxK, label) {
  const L = tables[leftSet], R = tables[rightSet];
  const byId = (rows) => { const m = new Map(); rows.forEach((r) => m.set(String(r["编号"]), r)); return m; };
  const ml = byId(L), mr = byId(R);
  for (let k = 1; k <= maxK; k++) {
    const a = ml.get(String(k)), b = mr.get(String(k));
    if (!a || !b) { console.log(`  跳过 ${label} #${k}：缺一侧`); continue; }
    const ta = keep(a["任务"]), tb = keep(b["任务"]);
    const t = { cover: +cover(ta, tb).toFixed(3), lev: +lev(ta, tb).toFixed(3), jac: +jaccard(ta, tb).toFixed(3) };
    const exact = ta === tb;
    pairs.push({ label, k, taskA: String(a["任务"]), taskB: String(b["任务"]), exact, ...t, score: +score(t).toFixed(3) });
  }
}
linkVersion("G1 示例周会·初稿", "G1 示例周会·修正v1.1", 6, "G1初稿↔修正");
linkVersion("G4 内部会·生成版", "G4 内部会·修正版", 9, "G4生成↔修正");

const posReal = pairs.filter((p) => !p.exact);
const posExact = pairs.filter((p) => p.exact);

// ---------- 报告
console.log("== 负例集（各表内全配对，不跨表） ==");
SETS.forEach((S) => console.log(`  ${S.name}: ${tables[S.name].length} 条 → ${neg.filter((n) => n.set === S.name).length} 对`));
console.log(`  合计 ${neg.length} 对`);
const maxOf = (m) => neg.reduce((x, n) => Math.max(x, n[m]), 0);
const top = (m) => neg.map((n) => n[m]).sort((x, y) => y - x).slice(0, 5).map((v) => v.toFixed(2)).join(" ");
["cover", "lev", "jac", "score"].forEach((m) => console.log(`  ${m}: 最大 ${maxOf(m).toFixed(2)}｜前 5 ${top(m)}`));

console.log("\n== 负例中组合分 ≥0.35 的对（需逐对判读） ==");
const hot = neg.filter((n) => n.score >= 0.35).sort((x, y) => y.score - x.score);
if (!hot.length) console.log("  无");
hot.forEach((n) => console.log(`  【${n.set}】#${n.a} vs #${n.b}｜组合 ${n.score.toFixed(2)}（覆盖 ${n.cover.toFixed(2)}／编辑 ${n.lev.toFixed(2)}／二元组 ${n.jac.toFixed(2)}）｜同负责人 ${n.sameOwner ? n.ownerA : "否"}\n      A ${n.taskA}\n      B ${n.taskB}`));
console.log(`  组合分 ≥0.5 的负例：${neg.filter((n) => n.score >= 0.5).length} 对`);

console.log("\n== 真实同编号跨版本对（同一件事的两种写法） ==");
pairs.forEach((p) => console.log(`  ${p.label} #${p.k}${p.exact ? "［文本相同］" : ""}｜组合 ${p.score.toFixed(2)}（覆盖 ${p.cover.toFixed(2)}／编辑 ${p.lev.toFixed(2)}／二元组 ${p.jac.toFixed(2)}）\n      A ${p.taskA}\n      B ${p.taskB}`));
console.log(`  真实改写正例 ${posReal.length} 对｜文本完全相同 ${posExact.length} 对`);

// ---------- 阈值扫描：真实负例 vs 真实改写正例
console.log("\n== 阈值扫描（组合判据 max(覆盖, 编辑, 二元组)） ==");
console.log("阈值  | 真实改写召回 | 负例误报(共" + neg.length + ")");
for (let t = 0.30; t <= 0.9501; t += 0.05) {
  const T = +t.toFixed(2);
  const tp = posReal.filter((p) => p.score >= T).length;
  const fp = neg.filter((n) => n.score >= T).length;
  console.log(`  ${T.toFixed(2)} | ${(tp / posReal.length).toFixed(2)} | ${fp}`);
}
const zeroNeg = [];
for (let t = 0.05; t <= 0.9951; t += 0.01) {
  const T = +t.toFixed(3);
  if (!neg.filter((n) => n.score >= T).length) zeroNeg.push(T);
}
const lower = Math.max(...zeroNeg.filter((T) => T <= 0.6));
console.log(`  负例零误报的最低阈值（0.05–0.60 区间内）：${lower.toFixed(2)}`);
const pick = (T) => ({ rec: (posReal.filter((p) => p.score >= T).length / posReal.length).toFixed(2) });
[0.45, 0.5, 0.55, 0.6].forEach((T) => {
  const r = pick(T);
  console.log(`  候选 T=${T}：真实改写召回 ${r.rec}｜距最高负例 ${(T - maxOf("score")).toFixed(2)}`);
});

// ---------- 「同负责人」闸门单独取证：阈值本身是否独立成立
console.log("\n== 负责人闸门单独取证（引擎判据里 0.5 之外还有一层「同负责人」） ==");
const sameOwnerNeg = neg.filter((n) => n.sameOwner);
const sameOwnerMax = sameOwnerNeg.reduce((x, n) => Math.max(x, n.score), 0);
[0.46, 0.5, 0.55].forEach((T) => {
  console.log(`  不看负责人：组合 ≥${T.toFixed(2)} 命中 ${neg.filter((n) => n.score >= T).length} 对｜同负责人负例 ${sameOwnerNeg.length} 对中最高 ${sameOwnerMax.toFixed(2)}`);
});
console.log(`  加上负责人条件后 ≥0.5 命中 ${neg.filter((n) => n.score >= 0.5 && n.sameOwner).length} 对`);

// ---------- 明细 CSV
const esc = (v) => { const s = String(v == null ? "" : v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
const lines = [];
lines.push(["类型", "语料或来源", "编号A", "编号B", "同负责人", "覆盖比", "编辑相似度", "二元组重合", "组合分(取最大)", "任务A", "任务B"].join(","));
hot.forEach((n) => lines.push(["负例(需判读)", n.set, n.a, n.b, n.sameOwner ? "是" : "否", n.cover, n.lev, n.jac, n.score, n.taskA, n.taskB].map(esc).join(",")));
neg.filter((n) => n.score < 0.35).forEach((n) => lines.push(["负例(低分)", n.set, n.a, n.b, n.sameOwner ? "是" : "否", n.cover, n.lev, n.jac, n.score, n.taskA, n.taskB].map(esc).join(",")));
pairs.forEach((p) => lines.push([(p.exact ? "正例(文本相同)" : "正例(真实改写)"), p.label, "#" + p.k, "#" + p.k, "是", p.cover, p.lev, p.jac, p.score, p.taskA, p.taskB].map(esc).join(",")));
fs.writeFileSync(path.join(__dirname, "真实语料配对_重标定v2.csv"), "\ufeff" + lines.join("\r\n"), "utf8");
console.log(`\n明细已写 真实语料配对_重标定v2.csv（${lines.length - 1} 行）`);