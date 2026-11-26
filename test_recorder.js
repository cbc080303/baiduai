// 记录器离线测试：recorder.js 的纯函数、zip 结构、存档，以及「成稿能否被质检端直接消费」。
// 不依赖浏览器：录音与 DOM 挂载在页面里跑，这里只测可机械判定的部分。
const fs = require("fs");
const path = require("path");
const R = require("./recorder.js");
const A = require("./a_channel.js");
const AC = A.A_CHANNEL || A;

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 时间码
eq("stamp(0)", R.stamp(0), "[00:00:00]");
eq("stamp(65)", R.stamp(65), "[00:01:05]");
eq("stamp(3725)", R.stamp(3725), "[01:02:05]");
eq("clock(0)", R.clock(0), "00:00");
eq("clock(59)", R.clock(59), "00:59");
eq("clock(3725)", R.clock(3725), "62:05");

// ---------- 2 单行化与名单
eq("oneLine 多行压句", R.oneLine("先拉数据\n再拆分"), "先拉数据。再拆分");
eq("oneLine 去多余句号", R.oneLine("a。\n。b"), "a。b");
const names = R.collectNames([
  { at: 3, speaker: "张岚", text: "开场" },
  { at: 9, speaker: "王睿", text: "我拉数据" },
  { at: 12, speaker: "张岚", text: "好" },
  { at: 20, speaker: "", text: "没填说话人" }
]);
eq("名单去重保序", names.join("、"), "张岚、王睿、未标注");
eq("参会人行", R.namesLine(names), "参会人：张岚、王睿、未标注");

// ---------- 3 成稿：打点不进成稿，格式能被解析
const turns = [
  { at: 3, speaker: "张岚", text: "今天三件事。" },
  { at: 9, speaker: "王睿", text: "漏斗数据我拉一下，下周二之前给你。" },
  { at: 15, mark: "争议点" },
  { at: 21, speaker: "张岚", text: "李思远把埋点补齐。" }
];
const script = R.buildScript(turns);
const lines = script.split("\n");
eq("成稿首行", lines[0], "参会人：张岚、王睿");
eq("成稿空行", lines[1], "");
eq("成稿条数", lines.filter((l) => l.startsWith("[")).length, 3);
ok("成稿不带打点", !script.includes("※"));
ok("成稿带时间码与说话人", script.includes("[00:00:09] 王睿：漏斗数据我拉一下"));

// ---------- 4 预览追加：保留手改、参会人行随新增刷新
let prev = "";
prev = R.appendLine(prev, [turns[0]], turns[0]);
eq("首条追加", prev, "参会人：张岚\n\n[00:00:03] 张岚：今天三件事。");
prev = R.appendLine(prev, [turns[0], turns[1]], turns[1]);
ok("参会人行补新人", prev.split("\n")[0] === "参会人：张岚、王睿");
eq("追加两行", prev.split("\n").filter((l) => l.startsWith("[")).length, 2);
const handEdited = "参会人：张岚\n\n[00:00:03] 张岚：今天三件事（我手动改过）。";
const afterEdit = R.appendLine(handEdited, [turns[0], turns[1]], turns[1]);
ok("手改正文保留", afterEdit.includes("（我手动改过）"));

// ---------- 5 原稿备份：元信息头 + 打点行
const backup = R.buildBackup({ title: "产品周会", createdAt: Date.parse("2026-11-26T14:30:00"), duration: 3725, turns });
const bLines = backup.split("\n");
eq("备份元信息 6 行", bLines.filter((l) => l.startsWith("# ")).length, 6);
ok("备份写会议名", backup.includes("# 会议记录：产品周会"));
ok("备份写时长", backup.includes("# 时长：62:05"));
ok("备份保留打点", backup.includes("[00:00:15] ※ 争议点"));
ok("备份含参会人行", backup.includes("参会人：张岚、王睿"));
ok("备份不含语音识别声明相反项", backup.includes("不做语音识别"));

const meta = JSON.parse(R.buildMeta({ title: "产品周会", createdAt: 1, duration: 3725, turns, audio: true, audioType: "audio/webm" }));
eq("meta turns", meta.turns, 4);
eq("meta marks", meta.marks, 1);
eq("meta hasAudio", meta.hasAudio, true);
eq("meta asr", meta.asr, false);

// ---------- 6 CRC 与 zip
eq("crc32('123456789')", R.crc32(Buffer.from("123456789")), 0xCBF43926);
const audioFake = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff, 0x10, 0x20]);
const zipBytes = R.zip([
  { name: "原稿.txt", data: backup },
  { name: "meta.json", data: R.buildMeta({ title: "产品周会", createdAt: 1, duration: 3725, turns }) },
  { name: "录音.webm", data: new Uint8Array(audioFake) }
], Date.parse("2026-11-26T14:30:00"));
const zb = Buffer.from(zipBytes);
eq("zip 头签名", zb.slice(0, 4).toString("hex"), "504b0304");
ok("zip 有 EOCD", zb.slice(-22, -18).toString("hex") === "504b0506");
eq("zip 条目数（EOCD）", zb.readUInt16LE(zb.length - 14), 3);
ok("zip 含中文名 原稿.txt", zb.includes(Buffer.from("原稿.txt", "utf8")));
ok("zip 含录音.webm", zb.includes(Buffer.from("录音.webm", "utf8")));
ok("zip 含二进制内容", zb.includes(audioFake));
fs.mkdirSync(path.join(__dirname, ".tmp"), { recursive: true });
fs.writeFileSync(path.join(__dirname, ".tmp", "rec_test.zip"), zb);

// ---------- 7 存档（内存适配器与 IndexedDB 同接口）
const store = R.createStore(R.createMemoryAdapter());
store.save({ id: "a", title: "早会", createdAt: 100, turns: [turns[0]] })
  .then(() => store.save({ id: "b", title: "周会", createdAt: 200, turns: turns }))
  .then(() => store.list())
  .then((rows) => {
    eq("存档条数", rows.length, 2);
    eq("存档按时间倒序", rows[0].id, "b");
    return store.get("a");
  })
  .then((r) => {
    eq("取回标题", r.title, "早会");
    return store.remove("a");
  })
  .then(() => store.list())
  .then((rows) => {
    eq("删除后条数", rows.length, 1);

    // ---------- 8 成稿可被 A 通道直接消费（DQ 契约）
    const todoRows = [{ "编号": "1", "任务": "拉漏斗数据", "负责人": "王睿", "截止时间": "下周二前", "约束": "按渠道拆分", "原文依据": "漏斗数据我拉一下，下周二之前给你。" }];
    const res = AC.scan(script, todoRows);
    ok("A 通道读出名单（≥2 人）", res.names && res.names.length >= 2);
    eq("A 通道切出 3 句", res.count, 3);
    ok("A 通道未报名单缺失", !res.warn || !/名单|一句发言/.test(res.warn));

    // ---------- 9 工作台页面结构
    const html = fs.readFileSync(path.join(__dirname, "workbench.html"), "utf8");
    ["rec-start", "rec-pause", "rec-stop", "rec-float", "rec-say", "rec-mark", "rec-preview",
      "rec-send", "rec-save", "rec-dl-txt", "rec-dl-audio", "rec-dl-zip", "rec-list", "rec-load", "rec-del"]
      .forEach((id) => ok("页面含 #" + id, html.includes('id="' + id + '"')));
    ok("页面挂载记录器", html.includes("RECORDER.mount"));
    ok("页面声明不做语音识别", html.includes("不做语音识别"));
    ok("页面零外链", !/src="http|href="http/.test(html));
    ok("成稿片段与页面同源", R.buildScript(turns).includes(R.stamp(9)));

    // 把成稿落盘，交给 Python 端复核解析契约
    fs.writeFileSync(path.join(__dirname, ".tmp", "rec_script.txt"), script, "utf8");
    fs.writeFileSync(path.join(__dirname, ".tmp", "rec_backup.txt"), backup, "utf8");

    if (fails.length) {
      console.error("FAIL " + fails.length + " 项：");
      fails.forEach((f) => console.error("  - " + f));
      process.exit(1);
    }
    console.log("PASS 记录器：时间码与单行化、名单去重、成稿格式、预览追加保留手改、备份元信息与打点、CRC 与 zip 结构、存档增删序、A 通道可直接消费（2 人 / 3 句）、页面 14 个钩子齐备且零外链");
  })
  .catch((e) => {
    console.error("测试自身异常：", e && e.stack ? e.stack : e);
    process.exit(2);
  });