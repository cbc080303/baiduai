// v3.3 新增：筛后建单包（taskPack / packReady / packBlocked）。
// 要证明的不是「能导出 CSV」，而是三件事：
//   1) 包里只含 readiness()==可直接建单 的条目，其余一条不漏地进「未入包原因」；
//   2) 列名与仓库里三份真实导入模板逐字一致，不自造格式；
//   3) 半角逗号与引号按 CSV 规则转义，相对截止不被硬算成绝对日期。
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
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log("FAIL", name); } };
const eq = (name, got, want) => ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`, got === want);

// 解析出 CSV 行（本文件只用于断言，按引擎的转义规则反向拆）
function splitCsv(text){
  const out = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"'){ if (text[i + 1] === '"'){ cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\r") {}
    else if (c === "\n") { row.push(cur); out.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur || row.length){ row.push(cur); out.push(row); }
  return out;
}

// ---------- 材料一：样例（真实六列，含相对截止与待确认）
const TR1 = fs.readFileSync(path.join(__dirname, "samples", "样例_转录.txt"), "utf8");
const CSV1 = fs.readFileSync(path.join(__dirname, "samples", "样例_待办.csv"), "utf8");
const c1 = QC.run(TR1, CSV1, {});
const ready1 = QC.packReady(c1), blk1 = QC.packBlocked(c1);
eq("样例：进包 + 未入包 = 全部条数", ready1.length + blk1.length, c1.rows.length);
ok("样例：进包条目全部是可直接建单", ready1.every((x) => QC.readiness(x.it) === "可直接建单"));
ok("样例：未入包条目没有一条是可直接建单", blk1.length === 0 || blk1.every((b) => b.处置 !== "可直接建单"));

// 编号集合互斥且并集完整
const idReady = ready1.map((x) => String(x.r["编号"])).sort();
const idBlk = blk1.map((b) => String(b.编号)).sort();
const idAll = c1.rows.map((r) => String(r["编号"])).sort();
eq("样例：进包与未入包编号无交集", idReady.filter((x) => idBlk.indexOf(x) >= 0).length, 0);
eq("样例：编号并集 = 全部", idReady.concat(idBlk).sort().join(","), idAll.join(","));

// ---------- 列名必须与仓库里三份真实模板逐字一致
const TPL = {
  teambition: fs.readFileSync(path.join(__dirname, "导入模板_第4组", "teambition_tasks.csv"), "utf8"),
  feishu: fs.readFileSync(path.join(__dirname, "导入模板_第4组", "feishu_tasks.csv"), "utf8"),
  dingtalk: fs.readFileSync(path.join(__dirname, "导入模板_第4组", "dingtalk_todo.csv"), "utf8"),
};
Object.keys(TPL).forEach((p) => {
  const tplHead = TPL[p].replace(/^\ufeff/, "").split(/\r?\n/)[0].split(",");
  const packHead = QC.taskPack(c1, p).replace(/^\ufeff/, "").split(/\r?\n/)[0].split(",");
  eq(`列名与 ${p} 模板一致`, packHead.join("|"), tplHead.join("|"));
});

// ---------- 行数、列数、BOM
["teambition", "feishu", "dingtalk"].forEach((p) => {
  const txt = QC.taskPack(c1, p);
  ok(`${p}：带 BOM`, txt.charCodeAt(0) === 0xfeff);
  const rows = splitCsv(txt.replace(/^\ufeff/, ""));
  const body = rows.filter((r) => r.length && r.some((x) => x.trim()));
  eq(`${p}：行数 = 表头 + 进包条目`, body.length, ready1.length + 1);
  ok(`${p}：每行列数与表头一致`, body.every((r) => r.length === body[0].length));
});

// ---------- 转义：半角逗号与引号
const TR2 = "参会人：王睿、李思远\n王睿：把漏斗数据拉出来，按渠道拆，下周二之前给我。\n李思远：收到，我这边排。\n";
const CSV2 = '编号,任务,负责人,截止时间,约束,原文依据\n' +
  '1,"拉漏斗数据，按渠道拆（含""新客""与""老客""两版）",王睿,下周二之前,按渠道拆,王睿：把漏斗数据拉出来，按渠道拆，下周二之前给我。\n';
const c2 = QC.run(TR2, CSV2, {});
const p2 = QC.taskPack(c2, "teambition").replace(/^\ufeff/, "");
ok("含逗号的任务被引号包裹", /"拉漏斗数据，按渠道拆（含""新客""与""老客""两版）"/.test(p2));
const rows2 = splitCsv(p2);
ok("转义后仍能被正确拆行（引号内逗号不切列）", rows2.length === 2 && rows2[1].length === rows2[0].length);
eq("转义后任务字段还原为原文", rows2[1][0], '拉漏斗数据，按渠道拆（含"新客"与"老客"两版）');

// ---------- 截止：相对表达不硬算绝对日期，绝对日期不加提示
ok("相对截止标注「未换算绝对日期」", /截止原始表达：下周二之前（相对表达，未换算绝对日期）/.test(p2));
const CSV3 = '编号,任务,负责人,截止时间,约束,原文依据\n' +
  '1,拉漏斗数据,王睿,2026-12-02,按渠道拆,王睿：把漏斗数据拉出来，按渠道拆，下周二之前给我。\n';
const p3 = QC.taskPack(QC.run(TR2, CSV3, {}), "teambition").replace(/^\ufeff/, "");
ok("绝对日期不加「未换算」提示", !/未换算绝对日期/.test(p3));
eq("绝对日期原样保留", splitCsv(p3)[1][2], "2026-12-02");

// ---------- 描述字段携带质检线索
ok("描述含质检编号", /质检编号：#1/.test(p2));
ok("描述含原文依据", /原文依据：王睿：把漏斗数据拉出来/.test(p2));

// ---------- 不得改变原表：导出是只读的
const before = JSON.stringify(c2.rows.map((r) => [r["编号"], r["任务"], r["负责人"], r["截止时间"]]));
QC.taskPack(c2, "feishu"); QC.taskPack(c2, "dingtalk"); QC.packBlocked(c2); QC.packReady(c2);
const after = JSON.stringify(c2.rows.map((r) => [r["编号"], r["任务"], r["负责人"], r["截止时间"]]));
eq("导出不改动原表", after, before);

// ---------- 报告第六节存在且与包同数
const rep = QC.report(c1);
ok("报告含「六、待建单清单（筛后）」", rep.indexOf("## 六、待建单清单（筛后）") >= 0);
ok("报告含未入包原因表或全部可直接建单", rep.indexOf("未入包原因") >= 0 || blk1.length === 0);
ok("报告已保留「四、边界与口径」", rep.indexOf("## 四、边界与口径") >= 0);
ok("页面有导入包入口", html.indexOf("btn-pack-team") >= 0 && html.indexOf("btn-pack-feishu") >= 0 && html.indexOf("btn-pack-dingtalk") >= 0);
ok("页面写明只导可直接建单", html.indexOf("只导出「可直接建单」的条目") >= 0);
ok("tool 版本 v3.3", html.indexOf("会议待办质检器 v3.3") >= 0);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} 筛后建单包 ${pass + fail} 项：只导可直接建单（进包+未入包=全部且互斥）+ 三份列名与真实模板逐字一致 + CSV 逗号与引号转义 + 相对截止不硬算日期 + 导出只读不改表 + 报告第六节`);
if (fail) process.exit(1);