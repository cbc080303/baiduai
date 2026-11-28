// 阈值扫描：负例（真实语料全配对）+ 正例（受控改写）→ 三把尺子在各阈值下的召回与误报。
// 为什么要这样分：真实语料 117 对里没有任何一对是「同一件事登两次」，所以真实语料只能提供负例；
// 正例只能靠受控改写构造（规则生成、可复现），并在报告里明确标注「合成正例」。
// 结论的适用边界：只说明「在 3 份真实待办表 + 40 个受控改写下，哪条判据最省事」，不等于人工标注的 gold 标定。
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

// ---------- 负例：三份真实/半真实待办表全配对
const SETS = [
  { name: "G2 财政部公开实录", tr: "会议转录_公开实录_第2组.txt", csv: "会议待办_生成版_第2组.csv" },
  { name: "G4 真实内部会·生成版", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_生成版_第4组.csv" },
  { name: "G4 真实内部会·修正版", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_修正版_第4组.csv" },
];
const neg = [];
SETS.forEach((S) => {
  const tr = fs.readFileSync(path.join(__dirname, S.tr), "utf8");
  const csv = fs.readFileSync(path.join(__dirname, S.csv), "utf8");
  const ctx = QC.run(tr, csv, {});
  const it = ctx.rows;
  for (let i = 0; i < it.length; i++)
    for (let j = i + 1; j < it.length; j++) {
      const a = keep(it[i]["任务"]), b = keep(it[j]["任务"]);
      if (!a || !b) continue;
      neg.push({ set: S.name, a: String(it[i]["编号"]), b: String(it[j]["编号"]),
        cover: +cover(a, b).toFixed(3), lev: +lev(a, b).toFixed(3), jac: +jaccard(a, b).toFixed(3) });
    }
});

// ---------- 正例：受控改写（可复现规则）
const SYN = [["素材", "物料"], ["交", "提交"], ["确认", "敲定"], ["约", "大概"], ["图", "海报"], ["群里", "群内"]];
const addTone = (t) => "请" + t + "，尽快";
const addTime = (t) => t + "，这周内";
const swapWords = (t) => { let s = t; SYN.forEach(([a, b]) => { s = s.replace(a, b); }); return s; };
// 调语序：只移动短语，不重排字符；无法安全重排时原样返回（排除，避免制造伪变体）
const reorder = (t) => {
  const m = t.match(/^(.*?)（(.+?)）(.*)$/);
  if (m) return `（${m[2]}）${m[1]}${m[3]}`;
  const n = t.match(/^(.{2,10}?)(交|提交|做|排|拉|跟进|确认)(.*)$/);
  if (n) return `${n[2]}${n[3]}，${n[1]}`;
  return null;
};
const heavy = (t) => swapWords(addTime(addTone(t)));

const tr4 = fs.readFileSync(path.join(__dirname, "会议转录_第4组_真实内部会议.txt"), "utf8");
const csv4 = fs.readFileSync(path.join(__dirname, "会议待办_修正版_第4组.csv"), "utf8");
const base = QC.run(tr4, csv4, {}).rows.map((r) => String(r["任务"] || "")).filter(Boolean);

const pos = [];
const modes = [["语气增补", addTone], ["时间增补", addTime], ["同义替换", swapWords], ["语序调整", reorder], ["重度改写", heavy]];
base.forEach((t, k) => {
  modes.forEach(([name, fn]) => {
    const v = fn(t);
    if (!v || v === t) return;                       // 没改写成功的不计入
    const a = keep(t), b = keep(v);
    pos.push({ i: k + 1, mode: name, base: t, variant: v,
      cover: +cover(a, b).toFixed(3), lev: +lev(a, b).toFixed(3), jac: +jaccard(a, b).toFixed(3) });
  });
});

// ---------- 扫描
const metrics = ["cover", "lev", "jac"];
const grid = [];
for (let t = 0.30; t <= 0.9001; t += 0.05) {
  const T = +t.toFixed(2);
  const row = { T };
  metrics.forEach((m) => {
    const tp = pos.filter((p) => p[m] >= T).length;
    const fp = neg.filter((n) => n[m] >= T).length;
    row[m] = { recall: +(tp / pos.length).toFixed(2), fp: fp, fpRate: +(fp / neg.length).toFixed(2), tp };
  });
  grid.push(row);
}

console.log("负例（真实语料全配对）：", neg.length, "对");
metrics.forEach((m) => {
  const vals = neg.map((n) => n[m]).sort((x, y) => y - x);
  console.log(`  ${m}: 最大 ${vals[0].toFixed(2)}｜前 5 ${vals.slice(0, 5).map((v) => v.toFixed(2)).join(" ")}`);
});
console.log("\n正例（受控改写）：", pos.length, "对");
modes.forEach(([name]) => {
  const arr = pos.filter((p) => p.mode === name);
  if (!arr.length) { console.log(`  ${name}: 0 对（无法安全改写）`); return; }
  const mn = (m) => Math.min(...arr.map((p) => p[m])).toFixed(2);
  console.log(`  ${name}: ${arr.length} 对｜cover min ${mn("cover")}｜lev min ${mn("lev")}｜jac min ${mn("jac")}`);
});

console.log("\n阈值   | cover 召回/误报 | lev 召回/误报 | jac 召回/误报");
grid.forEach((r) => {
  const c = r.cover, l = r.lev, j = r.jac;
  console.log(`${r.T.toFixed(2)}   | ${c.recall}/${c.fp}      | ${l.recall}/${l.fp}     | ${j.recall}/${j.fp}`);
});

// ---------- 结论：负例零误报前提下，找召回最高的最低阈值
console.log("");
metrics.forEach((m) => {
  const zero = grid.filter((r) => r[m].fp === 0);
  if (!zero.length) { console.log(`${m}: 所有阈值都有误报`); return; }
  const best = zero.slice().sort((x, y) => y[m].recall - x[m].recall || x.T - y.T)[0];
  console.log(`${m}: 负例零误报的阈值区间 0.${String(Math.round(zero[zero.length - 1].T * 100)).padStart(2, "0")}–0.${String(Math.round(zero[0].T * 100)).padStart(2, "0")}｜该区间最优 T=${best.T.toFixed(2)}，召回 ${best[m].recall}`);
});

// ---------- 组合判据：三者取最大（对语序改写更稳）
const comb = (o) => Math.max(o.cover, o.lev, o.jac);
console.log("\n组合判据 max(cover, lev, jac)：");
for (let t = 0.40; t <= 0.9001; t += 0.05) {
  const T = +t.toFixed(2);
  const tp = pos.filter((p) => comb(p) >= T).length;
  const fp = neg.filter((n) => comb(n) >= T).length;
  console.log(`  T=${T.toFixed(2)} 召回 ${(tp / pos.length).toFixed(2)} 误报 ${fp}/${neg.length}`);
}

const esc = (v) => { const s = String(v == null ? "" : v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
fs.writeFileSync(path.join(__dirname, "阈值扫描_明细.csv"),
  "\ufeff" + ["类型", "语料或模式", "原任务", "对比任务", "覆盖比", "编辑相似度", "二元组重合"].map(esc).join(",") + "\r\n" +
  neg.map((n) => ["负例", n.set, `#${n.a}`, `#${n.b}`, n.cover, n.lev, n.jac].map(esc).join(",")).join("\r\n") + "\r\n" +
  pos.map((p) => ["正例", p.mode, p.base, p.variant, p.cover, p.lev, p.jac].map(esc).join(",")).join("\r\n"), "utf8");
console.log("\n明细已写 阈值扫描_明细.csv");