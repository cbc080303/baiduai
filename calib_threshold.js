// 重复阈值标定：在真实语料上把「疑似重复」的 0.6 换成一个有依据的值。
// 做法：三份真实/半真实待办表全配对 → 三把尺子（覆盖比 / 编辑相似度 / 二元组重合）→ 人工逐对判读 → 扫阈值看命中与误报。
// 输出：候选对清单（CSV）+ 判读用的完整信息（stdout）。
// 口径：覆盖比与引擎内 commonCover 同逻辑（LCS / 较长者长度），脚本内自带实现，启动时与 QC.locate 抽样对拍。
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

// —— 与引擎同口径的两把尺子
const keep = (s) => String(s == null ? "" : s).replace(/\s+/g, "").replace(/[。！？；，、：,.!?;:]/g, "");
function lcs(a, b) {
  if (!a || !b) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++)
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}
const cover = (a, b) => (a && b ? lcs(a, b) / Math.max(a.length, b.length) : 0);
function bigrams(s) {
  const g = new Map();
  for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); }
  return g;
}
function jaccard(a, b) {
  if (!a || !b) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, union = 0;
  const keys = new Set([...A.keys(), ...B.keys()]);
  keys.forEach((k) => {
    const x = A.get(k) || 0, y = B.get(k) || 0;
    inter += Math.min(x, y); union += Math.max(x, y);
  });
  return union ? inter / union : 0;
}

const SETS = [
  { name: "G2", label: "第2组·财政部公开实录", tr: "会议转录_公开实录_第2组.txt", csv: "会议待办_生成版_第2组.csv" },
  { name: "G4g", label: "第4组·真实内部会（生成版）", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_生成版_第4组.csv" },
  { name: "G4r", label: "第4组·真实内部会（修正版）", tr: "会议转录_第4组_真实内部会议.txt", csv: "会议待办_修正版_第4组.csv" },
];

// —— 口径对拍：用带已知重复的样例待办，验证脚本的 cover 与引擎 findings 的判定逐对一致
// （注意引擎内部有两套分母：locate 的 ratio 除以「依据长度」，findings 除以「较长者」；本脚本按 findings 口径）
let parityOk = true, parityMsg = "";
{
  const trS = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_转录.txt"), "utf8");
  const csvS = fs.readFileSync(path.join(__dirname, "agent-src", "meeting-todo-qc", "samples", "样例_待办.csv"), "utf8");
  const ctxS = QC.run(trS, csvS, {});
  const eng = QC.findings(ctxS.rows, QC.splitLines(trS), ctxS.quotes)
    .filter((f) => f.type === "疑似重复").map((f) => f.ids.join("|"));
  const mine = [];
  const miss = new Set(["", "待确认", "-", "—", "无"]);
  for (let i = 0; i < ctxS.rows.length; i++) {
    for (let j = i + 1; j < ctxS.rows.length; j++) {
      const a = keep(ctxS.rows[i]["任务"]), b = keep(ctxS.rows[j]["任务"]);
      const oa = String(ctxS.rows[i]["负责人"] || "").trim(), ob = String(ctxS.rows[j]["负责人"] || "").trim();
      const sc = Math.max(cover(a, b), QC.levRatio(a, b), QC.bigramJaccard(a, b));
      if (sc >= 0.5 && !miss.has(oa) && oa === ob) mine.push([String(ctxS.rows[i]["编号"]), String(ctxS.rows[j]["编号"])].join("|"));
    }
  }
  if (eng.length !== mine.length || eng.some((x, i) => x !== mine[i])) {
    parityOk = false;
    parityMsg = `引擎 ${JSON.stringify(eng)} vs 脚本 ${JSON.stringify(mine)}`;
  }
}

const rows = [];
SETS.forEach((S) => {
  const tr = fs.readFileSync(path.join(__dirname, S.tr), "utf8");
  const csv = fs.readFileSync(path.join(__dirname, S.csv), "utf8");
  const ctx = QC.run(tr, csv, {});
  const items = ctx.rows;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const ta = keep(a["任务"]), tb = keep(b["任务"]);
      if (!ta || !tb) continue;
      const cv = cover(ta, tb), lv = QC.levRatio(ta, tb), jc = jaccard(ta, tb);
      const oa = String(a["负责人"] || "").trim(), ob = String(b["负责人"] || "").trim();
      const missing = new Set(["", "待确认", "-", "—", "无"]);
      const sameOwner = !missing.has(oa) && oa === ob;
      const hitNow = Math.max(cv, lv, jc) >= 0.5 && sameOwner;   // 新判据：三把尺子取最大、阈值 0.5
      rows.push({
        set: S.name, setLabel: S.label,
        a: String(a["编号"]), b: String(b["编号"]),
        taskA: String(a["任务"] || ""), taskB: String(b["任务"] || ""),
        ownerA: oa, ownerB: ob, sameOwner,
        evA: String(a["原文依据"] || "").slice(0, 48),
        evB: String(b["原文依据"] || "").slice(0, 48),
        dueA: String(a["截止时间"] || ""), dueB: String(b["截止时间"] || ""),
        cover: +cv.toFixed(3), lev: +lv.toFixed(3), jac: +jc.toFixed(3), hitNow,
      });
    }
  }
});

rows.sort((x, y) => Math.max(y.cover, y.lev) - Math.max(x.cover, x.lev));
const cand = rows.filter((r) => r.cover >= 0.35 || r.lev >= 0.45 || r.sameOwner && r.cover >= 0.3);

// —— CSV（供复核，含 blank label 列）
const head = ["语料", "编号A", "编号B", "同一件事", "负责人A", "负责人B", "同负责人", "覆盖比", "编辑相似度", "二元组重合", "现行命中(组合≥0.5且同负责人)", "任务A", "任务B", "依据A", "依据B", "判读理由"];
const esc = (v) => {
  const s = String(v == null ? "" : v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
};
const lines = [head.join(",")];
rows.forEach((r) => {
  lines.push([r.setLabel, r.a, r.b, "", r.ownerA, r.ownerB, r.sameOwner ? "是" : "否",
    r.cover, r.lev, r.jac, r.hitNow ? "是" : "否",
    r.taskA, r.taskB, r.evA, r.evB, ""].map(esc).join(","));
});
fs.writeFileSync(path.join(__dirname, "候选对_重复阈值.csv"), "\ufeff" + lines.join("\r\n"), "utf8");

// —— 摘要
console.log(`口径对拍：${parityOk ? "OK" : "不一致 " + parityMsg}`);
console.log(`总对数 ${rows.length}｜现行命中 ${rows.filter((r) => r.hitNow).length} 对｜候选判读集 ${cand.length} 对`);
console.log("\n需要逐对判读的（覆盖比/相似度较高，或同负责人）：");
cand.slice(0, 40).forEach((r) => {
  console.log(`【${r.set}】#${r.a} vs #${r.b}｜cover ${r.cover.toFixed(2)}｜lev ${r.lev.toFixed(2)}｜jac ${r.jac.toFixed(2)}｜同负责人 ${r.sameOwner ? r.ownerA : "否"}${r.hitNow ? "｜★现行命中" : ""}`);
  console.log(`   A ${r.taskA}`);
  console.log(`   B ${r.taskB}`);
  console.log(`   依据A ${r.evA}`);
  console.log(`   依据B ${r.evB}`);
});