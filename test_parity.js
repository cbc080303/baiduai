// 对拍脚本：JS 版 A 通道 vs Python 版 qc_tools.py v1.1
// 跑法：node test_parity.js
const fs = require("fs");
const {scanTranscript} = require("./a_channel.js");

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

const rows = DEMO_ROWS.map(r => ({
  "编号": r[0], "任务": r[1], "负责人": r[2], "截止时间": r[3], "约束": r[4]
}));

const raw = fs.readFileSync("会议转录_产品运营周会_示例.txt", "utf8");
const res = scanTranscript(raw, rows);

console.log("参会人 " + res.names.length + " 人：" + res.names.join("、"));
console.log("句子 " + res.sentences.length + " 条");
console.log("候选 " + res.cands.length + " 条；低置信 " + res.low.length + " 条");
console.log("---");
res.cands.forEach((c, i) => {
  console.log((i + 1) + " | " + c["人物"] + " | " + c["置信度"] + " | " + c["时间"] + " | " + c["句"]);
});
if (res.low.length){
  console.log("--- 低置信池 ---");
  res.low.forEach(c => console.log(c["人物"] + " | " + c["句"] + " | " + c["备注"]));
}