// 视频会议入口：字幕解析、材料识别、浮窗降级与页面接线。
// 只测确定性行为；真实 PiP 窗口与麦克风依赖浏览器，不在此列（页面另有降级路径断言）。
const fs = require("fs");
const path = require("path");
const S = require("./subtitle.js");
const M = require("./media_intake.js");
const AC = (require("./a_channel.js").A_CHANNEL) || require("./a_channel.js");

const fails = [];
const eq = (name, got, want) => { if (String(got) !== String(want)) fails.push(`${name}: 得到 ${got}，期望 ${want}`); };
const ok = (name, cond) => { if (!cond) fails.push(name); };

// ---------- 1 VTT：说话人标签、样式标签、滚动重复、多行合并
const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
<v 张岚>今天三件事。

00:00:04.000 --> 00:00:07.500
<v 张岚>今天三件事。先看漏斗数据。

00:00:08.000 --> 00:00:10.000
<v 王睿>漏斗数据

00:00:10.000 --> 00:00:12.000
<c.colorE5E5E5>漏斗数据我拉一下，<00:00:10.500>下周二之前给你。</c>`;
const v = S.parse(VTT);
ok("VTT 有解析结果", v.ok);
eq("VTT 裁掉滚动重复与回声", v.turns.length, 2);
eq("VTT 说话人", v.names.join("、"), "张岚、王睿");
ok("VTT 去重计数非零", v.dropped >= 2);
ok("VTT 无样式标签残留", !/[<>]/.test(v.transcript.replace(/\[[^\]]*\]/g, "")));
ok("VTT 时间码统一成 [HH:MM:SS]", /\[00:00:08\] 王睿：/.test(v.transcript));
ok("VTT 不带说话人标签的 cue 继承上一位（不拆成两个“人”）", !v.transcript.includes("说话人1"));
eq("VTT 同人连续轮合并", v.turns[0].text, "今天三件事。先看漏斗数据。");

// ---------- 2 SRT：序号行、逗号毫秒、姓名：前缀
const SRT = `1
00:00:01,000 --> 00:00:03,000
张岚：今天三件事。

2
00:00:03,500 --> 00:00:06,000
王睿：漏斗数据我拉一下，下周二之前给你。`;
const r = S.parse(SRT);
eq("SRT 轮数", r.turns.length, 2);
eq("SRT 说话人", r.names.join("、"), "张岚、王睿");
ok("SRT 首行序号被跳过", r.transcript.indexOf("1\n") < 0);

// ---------- 3 没有说话人：退到「说话人1」，不编人名
const bare = S.parse("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n今天三件事。\n\n00:00:03.000 --> 00:00:04.000\n先看数据。");
eq("无说话人退到占位名", bare.names.join("、"), "说话人1");
ok("占位名不进参会人当真人", bare.transcript.indexOf("参会人：说话人1") === 0);

// ---------- 4 嗅探与识别：扩展名骗人时以内容为准
eq("detect VTT", S.detect(VTT).format, "vtt");
eq("detect SRT", S.detect(SRT).format, "srt");
eq("detect 普通转录不算字幕", S.detect("参会人：甲、乙\n\n甲：好").is_subtitle, false);
eq("存成 .txt 的字幕按内容认", M.kindOf("会议.txt", VTT).kind, "subtitle");
eq("字幕文件按扩展名认", M.kindOf("会议.vtt", "").kind, "subtitle");
eq("录像扩展名", M.kindOf("周会.mp4", "").kind, "video");
eq("音频扩展名", M.kindOf("录音.m4a", "").kind, "audio");
eq("普通文本", M.kindOf("转录.txt", "参会人：甲").kind, "text");
eq("时长 4271 秒", M.formatDuration(4271), "1:11:11");
eq("体积 117.7 MB", M.formatBytes(123456789), "117.7 MB");

// ---------- 5 素材卡：必须说清“不转文字”，并给出两条转写路径
const card = M.videoCard({ name: "周会.mp4", ext: "mp4", size: 1024, duration: 4271, width: 1920, height: 1080, hasAudio: null });
ok("素材卡有时长", card.includes("1:11:11"));
ok("素材卡有分辨率", card.includes("1920×1080"));
ok("素材卡说未探测不假装", card.includes("未探测"));
ok("素材卡明写不做语音识别", card.includes("不把音轨转成文字"));
ok("素材卡给出两条转写路", card.includes("会议平台自带转写") && card.includes("录屏文件"));
ok("音频卡也明写不识别", M.audioCard({ name: "a.m4a", ext: "m4a", duration: 60 }).includes("不做语音识别"));

// ---------- 6 端到端：字幕转录必须能被 A 通道消费（这就是“视频内容提取”落到实处）
const res = AC.scan(v.transcript, [
  { "编号": "1", "任务": "拉漏斗数据", "负责人": "王睿", "截止时间": "下周二前", "约束": "", "原文依据": "漏斗数据我拉一下，下周二之前给你。" }
]);
ok("字幕转录切出 2 人", res.names && res.names.length === 2);
eq("字幕转录切出 3 句（张岚两句、王睿一句）", res.count, 3);

// ---------- 7 页面接线：卡、按钮、浮窗降级、零外链
const html = fs.readFileSync(path.join(__dirname, "质检工作台.html"), "utf8");
ok("有视频会议卡", html.includes('id="video"') && html.includes("视频会议 · 字幕与录像"));
ok("有字幕/录像选择键", html.includes('id="video-pick"') && html.includes('id="video-files"'));
ok("有素材卡输出区", html.includes('id="video-out"'));
ok("有浮窗按钮", html.includes('id="rec-float"'));
ok("字幕与素材模块已内联", html.includes("SUBTITLE.parse") && html.includes("MEDIA.kindOf"));
ok("拖放走统一 intake", html.includes("await intakeFiles(fs)"));
ok("页面零外链", !/src="http|href="http|@import url\(http/.test(html));
ok("浮窗降级样式在页内", html.includes("body.rec-float-on #rec"));

// ---------- 8 记录器源码：PiP 检测、内联样式、降级说明
const recSrc = fs.readFileSync(path.join(__dirname, "recorder.js"), "utf8");
ok("检测 Document PiP", recSrc.includes("window.documentPictureInPicture") && recSrc.includes("requestWindow"));
ok("PiP 关闭后把面板移回", recSrc.includes('addEventListener("pagehide"'));
ok("不支持时降级吸附并非假成功", recSrc.includes("这个浏览器不支持置顶浮窗") && recSrc.includes("rec-float-on"));
ok("浮窗样式内联（不引外链）", recSrc.includes("FLOAT_CSS"));
ok("浮窗与页面共用写入路径", recSrc.includes("function submitText(") && recSrc.includes("sayFromPanel"));

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PASS 视频会议入口：VTT/SRT 解析（说话人标签、样式清除、滚动去重、同人合并、时间码统一）、无标签退占位名、内容嗅探优先于扩展名、素材卡明写不做识别、字幕转录可被 A 通道消费（2 人 2 句）、页面卡与浮窗降级齐备且零外链");