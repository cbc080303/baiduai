// 加固回归：把「漏洞与潜在问题」修完的点变成可机械判定的断言。
// 只测能确定性判定的行为与结构；录音本身（麦克风、MediaRecorder）依赖真实设备，不在此列。
const fs = require("fs");
const path = require("path");
const R = require("./recorder.js");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 版本与文件名安全化（用户输入会带 / \ : * ? " < > | 和换行）
eq("记录器版本", R.VERSION, "1.2");
eq("斜杠与冒号", R.safeName("产品/周会:复盘"), "产品_周会_复盘");
eq("换行压成空格", R.safeName("会议\n纪要"), "会议 纪要");
eq("反斜杠与问号", R.safeName('a\\b?c*d"e<f>g|h'), "a_b_c_d_e_f_g_h");
eq("空值回退", R.safeName("", "未命名会议"), "未命名会议");
eq("全空白回退", R.safeName("   ", "会议"), "会议");
eq("去前导点防隐藏文件", R.safeName("..隐藏"), "隐藏");
eq("超长截断 60", R.safeName("x".repeat(120)).length, 60);
ok("备份元信息标题已安全化", R.buildBackup({ title: "A/B\nC", createdAt: 1, turns: [] }).split("\n")[0] === "# 会议记录：A_B C");
eq("meta 标题已安全化", JSON.parse(R.buildMeta({ title: "A/B\nC", createdAt: 1, turns: [] })).title, "A_B C");
eq("文件名清理保留扩展名", R.plainFileName("原稿_产品/周会_20261126.txt"), "原稿_产品_周会_20261126.txt");

// ---------- 2 源码层：这轮修的真缺陷必须留在代码里（防止后续重构悄悄回退）
const rec = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");
ok("录音启动有并发保护", /if \(mr \|\| starting\) return Promise\.resolve\(false\)/.test(rec));
ok("MediaRecorder 构造失败会释放麦克风", rec.includes("MediaRecorder 初始化失败") && /catch \(e\) \{\s*\n\s*\/\/ 构造失败必须把麦克风还回去/.test(rec));
ok("cleanup 复位 starting", /mr = null;\s*\n\s*starting = false;/.test(rec));
ok("下载 revoke 不再 0ms", rec.includes("URL.revokeObjectURL(a.href); a.remove(); }, 5000)") && !rec.includes("a.remove(); }, 0)"));
ok("下载名走 plainFileName", rec.includes("a.download = plainFileName(name);"));
ok("送入前检查待办表", rec.includes('var todo = $("todo-input")') && rec.includes("还差待办表"));
ok("保存时同 id 另存新份", rec.includes("store.get(s.id)") && rec.includes("原存档保留"));
ok("清空前先停录", rec.includes("rec.isRecording() || rec.isPaused()") && rec.includes("这段音频没有保存"));
ok("存档可全部清除且二次确认", rec.includes('confirm("清除本机全部 "') && rec.includes("Promise.all(rows.map"));
ok("存档失败给出导出兜底", rec.includes("导出备份包 .zip」带走"));
ok("文件名中间段带会议名", rec.includes('safeName(title(), "会议")') && rec.includes('safeName(s.title, "会议")'));

// ---------- 3 页面结构：按钮与挂载都在
const page = fs.readFileSync(path.join(__dirname, "workbench.html"), "utf8");
ok("工作台有清除全部按钮", page.includes('id="rec-clear-all"'));
ok("工作台记录器仍挂载", page.includes("RECORDER.mount"));
ok("工作台零外链", !/src="http|href="http/.test(page));
ok("粘底操作条留 safe-area", page.includes("env(safe-area-inset-bottom)"));

// ---------- 4 痕迹一致性：交付副本不能落后于实物
const idx = fs.readFileSync(path.join(__dirname, "index.html"));
const demo = fs.readFileSync(path.join(__dirname, "会议待办质检器_演示页.html"));
ok("演示页副本与 index 逐字节一致", idx.length === demo.length && idx.equals(demo));
const wb = fs.readFileSync(path.join(__dirname, "workbench.html"));
const wb2 = fs.readFileSync(path.join(__dirname, "质检工作台.html"));
ok("工作台副本与构建产物逐字节一致", wb.length === wb2.length && wb.equals(wb2));

// ---------- 5 口径：首屏结论与数字不能自相矛盾（6/11 可执行 → 不是"一半以上不能"）
const readme = fs.readFileSync(path.join(__dirname, "README.md"), "utf8");
ok("README 不再写「一半以上不能直接用」", !readme.includes("一半以上不能直接用"));
ok("README 写成「近一半」并保留 54.5% 口径", readme.includes("近一半不能直接用") && readme.includes("54.5%"));
const talk = fs.readFileSync(path.join(__dirname, "答辩话术_四组数据版.md"), "utf8");
ok("答辩开场不再与 54.5% 矛盾", !talk.includes("一半以上不能直接用"));

// ---------- 6 数据：成稿仍可被质检端消费（修复不得伤到主链路）
const script = R.buildScript([
  { at: 5, speaker: "张岚", text: "今天三件事。" },
  { at: 9, speaker: "王睿", text: "漏斗数据我拉一下，下周二之前给你。" }
]);
const AC = (require("./a_channel.js").A_CHANNEL) || require("./a_channel.js");
const res = AC.scan(script, [{ "编号": "1", "任务": "拉数据", "负责人": "王睿", "截止时间": "下周二前", "约束": "", "原文依据": "漏斗数据我拉一下，下周二之前给你。" }]);
ok("成稿仍切出 2 人", res.names && res.names.length === 2);
eq("成稿仍切出 2 句", res.count, 2);

// ---------- 7 长会议与离开保护：性能、滚动、丢数据（本轮新增）
ok("成稿行可单独取（增量追加用）", typeof R.lineOf === "function" && typeof R.stripNames === "function");
eq("剥名单行", R.stripNames("参会人：A、B\n\n甲：x"), "甲：x");
eq("打点行格式", R.lineOf({ at: 65, mark: "争议点" }), "[00:01:05] ※ 争议点");
ok("手改正文在追加时保留", R.appendLine("参会人：A\n\n甲：手改过的一句", [{ speaker: "A" }, { speaker: "B" }], { at: 9, speaker: "B", text: "新一条" }).includes("甲：手改过的一句"));
ok("未手改时走增量追加（不重建整段）", rec.includes("lastWritten !== null && el.preview.value === lastWritten"));
ok("增量追加后滚到底", rec.includes("el.preview.scrollTop = el.preview.scrollHeight"));
ok("关闭页面有丢数据拦截", rec.includes('addEventListener("beforeunload"') && rec.includes("还在录音：关闭页面会丢掉这段音频") && rec.includes("这段会议记录还没保存：关闭页面会丢掉"));
ok("已落档后放行（dirty 复位）", (rec.match(/dirty = false;/g) || []).length >= 4);
ok("stop 有 1.5s 兜底（onstop 不派发也不会挂住）", rec.includes("}, 1500);") && rec.includes("function finish(out)"));
ok("本地库不可用时降级内存并明说", rec.includes("persists = false") && rec.includes("本浏览器禁用了本地库"));
ok("载入存档后重置手改基准", rec.includes("lastWritten = el.preview.value"));

// ---------- 8 交付副本与文档：装在本机的智能体不能跑旧版
const A = require("path");
const D = "C:/Users/caiba/AppData/Roaming/qianfan-desktop-app/qianfan_desk_xdg/03905633a72a4d4d822fcdf9e5554e06/data/plugins/user/meeting-todo-qc/workbench/质检工作台.html";
const wbA = fs.readFileSync(A.join(__dirname, "agent-src/meeting-todo-qc/workbench/质检工作台.html"));
ok("agent-src 副本与构建产物一致", wb.length === wbA.length && wb.equals(wbA));
let wbD = null; try { wbD = fs.readFileSync(D); } catch (e) { /* 换机器时可能没有 */ }
if (wbD) ok("插件目录副本与构建产物一致", wb.length === wbD.length && wb.equals(wbD));
ok("构建产物含本轮加固（清除全部 + 离开拦截）", page.includes('id="rec-clear-all"') && page.includes("beforeunload"));
const full = fs.readFileSync(path.join(__dirname, "README_完整版.md"), "utf8");
ok("完整版 README 也不再写「一半以上不能直接用」", !full.includes("一半以上不能直接用"));

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PASS 加固回归 " + (26 + 15) + " 项：文件名安全化 + 录音并发与麦克风释放 + 下载 revoke 5s + 送入前查待办表 + 同 id 另存 + 清空先停录 + 全部清除带确认 + 存档失败兜底 + stop 兜底 + 增量追加与滚底 + 离开页面拦截 + 内存降级提示 + 三处副本逐字节一致 + 口径与 54.5% 不再矛盾 + 成稿仍被 A 通道消费（2 人 2 句）");