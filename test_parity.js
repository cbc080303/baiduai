// 对拍脚本：JS 版 A 通道（a_channel.js，v1.3）vs Python 版 qc_tools.py（v1.3）
// 跑法：node test_parity.js   —— 三组有表的语料，逐条比对，任一项不一致即退出码 1
// 第 3 组 VCSum 无生成版表格，不进对拍
const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");
const {A_CHANNEL} = require("./a_channel.js");

const HERE = __dirname;

const DEMO_ROWS = [
  ["1", "拉取新用户引导漏斗数据并按渠道拆分", "王睿", "下周二前", "按渠道拆分，交付张岚", ""],
  ["2", "修复支付回调重复通知（幂等）", "李思远", "本周五前", "先灰度 10%，无问题再全量", ""],
  ["3", "改版落地页输出两版视觉", "陈晨", "下周三前", "沿用现有结构；内部先选一版", ""],
  ["4", "获取星图渠道正式报价单", "赵敏", "本周内", "拿不到报价单则先要框架协议", ""],
  ["5", "输出改版常见问题客服话术", "何静", "周五前", "覆盖改版后用户常见问题", ""],
  ["6", "统一数据看板日活口径", "何静", "下个月 10 号前", "三个部门口径不一致，需统一", ""],
  ["7", "线下沙龙改期至 9 月并锁定场地", "赵敏", "9 月第二周", "原定 8 月，场地 8 月已排满", ""],
  ["8", "与陈晨确认市场物料展架尺寸", "赵敏", "待确认", "与陈晨共同确认，避免返工", ""],
  ["9", "撰写 Q3 OKR 初稿并发群", "张岚", "下周一", "周三评审会过一遍", ""],
  ["10", "会前阅读两家竞品改版方案", "待确认", "评审会前", "未指定到人", ""],
  ["11", "发送会议纪要到项目群并抄送赵敏", "待确认", "待确认", "抄送赵敏", ""],
];

function demoRows(){
  return DEMO_ROWS.map(r => ({"编号": r[0], "任务": r[1], "负责人": r[2], "截止时间": r[3], "约束": r[4]}));
}

function csvRows(file){
  const text = fs.readFileSync(path.join(HERE, file), "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(",").map(s => s.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map(line => {
    const cells = [];
    let cur = "", inQuote = false;
    for (let i = 0; i < line.length; i++){
      const ch = line[i];
      if (ch === '"'){
        if (inQuote && line[i + 1] === '"'){ cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === "," && !inQuote){
        cells.push(cur); cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] || "").trim(); });
    return row;
  });
}

const CASES = [
  ["示例转录", "会议转录_产品运营周会_示例.txt", demoRows()],
  ["第2组实录", "会议转录_公开实录_第2组.txt", csvRows("会议待办_生成版_第2组.csv")],
  ["第4组真实内部会", "会议转录_第4组_真实内部会议.txt", csvRows("会议待办_生成版_第4组.csv")],
];

function norm(items, keys){
  return items.map(it => keys.map(k => String(it[k] == null ? "" : it[k])).join("\u0001")).sort();
}

function jsSide(){
  const out = {};
  for (const [label, file, rows] of CASES){
    const raw = fs.readFileSync(path.join(HERE, file), "utf8");
    const res = A_CHANNEL.scan(raw, rows);
    out[label] = {
      names: res.names,
      count: res.count,
      cands: norm(res.cands, ["人物", "句", "置信度", "时间"]),
      low: norm(res.low, ["人物", "句", "置信度", "时间"]),
      orgs: norm(res.orgs, ["主体", "句", "时间"]),
    };
  }
  return out;
}

function pySide(){
  const raw = execFileSync("python", [path.join(HERE, "parity_dump.py")], {cwd: HERE, encoding: "utf8"});
  const j = JSON.parse(raw);
  const out = {};
  for (const label of Object.keys(j)){
    out[label] = {
      names: j[label].names,
      count: j[label].count,
      cands: j[label].cands.map(t => t.join("\u0001")),
      low: j[label].low.map(t => t.join("\u0001")),
      orgs: j[label].orgs.map(t => t.join("\u0001")),
    };
  }
  return out;
}

function cmp(label, key, a, b, problems){
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa === sb){
    console.log(`PASS  ${label} · ${key}（${Array.isArray(a) ? a.length : a}）`);
    return;
  }
  problems.push(`${label} · ${key}\n  JS: ${sa}\n  PY: ${sb}`);
  console.log(`FAIL  ${label} · ${key}`);
}

const js = jsSide();
const py = pySide();
const problems = [];

console.log("=== 对拍：a_channel.js v1.3 vs qc_tools.py v1.3 ===");
for (const [label] of CASES){
  console.log(`--- ${label} ---`);
  cmp(label, "names", js[label].names, py[label].names, problems);
  cmp(label, "count", js[label].count, py[label].count, problems);
  cmp(label, "cands", js[label].cands, py[label].cands, problems);
  cmp(label, "low", js[label].low, py[label].low, problems);
  cmp(label, "orgs", js[label].orgs, py[label].orgs, problems);
  console.log(`      候选 ${js[label].cands.length}｜低置信 ${js[label].low.length}｜机构 ${js[label].orgs.length}`);
}

if (problems.length){
  console.log("\n=== 不一致明细 ===");
  problems.forEach(p => console.log(p));
  process.exit(1);
}
console.log("\nALL PARITY PASS：三组语料（含单字代称的第 4 组）、五类输出逐条一致");