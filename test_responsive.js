// 适配与打开方式的机械断言：把「手机上能不能用」拆成可判定的 CSS/HTML 事实。
// 只断言源码事实，不断言视觉观感；真实渲染取证另行记录（见工作文档证据表）。
const fs = require("fs");
const path = require("path");

const pages = [
  { name: "index.html", role: "演示页", needPanelScroll: ".panel" },
  { name: "workbench.html", role: "工作台", needPanelScroll: "section.out" },
];

const fails = [];
const ok = (name, cond, extra) => { if (!cond) fails.push(name + (extra ? "：" + extra : "")); };

function block(html, head) {
  const i = html.indexOf(head);
  if (i < 0) return "";
  let depth = 0, j = html.indexOf("{", i);
  for (let k = j; k < html.length; k++) {
    if (html[k] === "{") depth++;
    else if (html[k] === "}") { depth--; if (depth === 0) return html.slice(j + 1, k); }
  }
  return "";
}

pages.forEach(({ name, role, needPanelScroll }) => {
  const p = path.join(__dirname, name);
  const html = fs.readFileSync(p, "utf8");

  // 1 视口与安全区
  ok(role + " 含 viewport-fit=cover", /content="[^"]*viewport-fit=cover"/.test(html));
  ok(role + " 用 safe-area 处理刘海/home 指示条",
    /env\(safe-area-inset-(top|bottom|left|right)\)/.test(html));

  // 2 触摸输入能力（不是按设备型号猜）
  const coarse = block(html, "@media (pointer:coarse)");
  ok(role + " 有 pointer:coarse 分支", coarse.length > 0);
  ok(role + " 触摸目标 ≥44px", /min-height:\s*44px/.test(coarse));
  ok(role + " 触摸下输入框 ≥16px（iOS 不放大）", /font-size:\s*16px/.test(coarse));

  // 3 窄屏重排
  const sm = block(html, "@media (max-width:640px)");
  ok(role + " 有 640px 断点", sm.length > 0);
  ok(role + " 窄屏宽表横滚（overflow-x:auto）", /overflow-x:\s*auto/.test(sm));
  ok(role + " 窄屏宽表最小宽 560px", /min-width:\s*560px/.test(sm));
  ok(role + " 窄屏仍保留 44px 触摸目标", /min-height:\s*44px/.test(sm) || /min-height:\s*44px/.test(coarse));
  ok(role + " 目标容器为 " + needPanelScroll, sm.indexOf(needPanelScroll) >= 0);
  // 页面内边距带安全区，不再硬写死 16px
  ok(role + " 页边距含安全区", /padding[^;]*max\([^)]*env\(safe-area-inset-left\)/.test(html));
  // 4 零外链（打开方式用纯文本地址，不引入第三方资源）
  ok(role + " 零外链", !/src="http|href="http/.test(html));

  // 5 打开方式三条路可见
  ok(role + " 有「怎么打开」条（#open）", /id="open"/.test(html));
  ok(role + " 打开条含 .open-strip", /class="open-strip"/.test(html));
  const strip = (html.match(/<div class="open-strip"[\s\S]*?<\/div>/) || [""])[0];
  ok(role + " 打开条写了电脑路径", strip.includes("电脑"));
  ok(role + " 打开条写了手机路径", strip.includes("手机"));
  ok(role + " 打开条写了离线或录音限制", strip.includes("离线") || strip.includes("录音"));
  ok(role + " 打开条给出可复制的线上地址", strip.includes("cbc080303.github.io/baiduai"));

  // 6 记录卡（仅工作台）
  if (name === "workbench.html") {
    ok("工作台 记录卡在窄屏单列", /@media\(max-width:860px\)\{\.rec-grid\{grid-template-columns:1fr\}\}/.test(html));
    ok("工作台 记录卡录音键为触摸目标", /button\{min-height:44px/.test(coarse));
    ok("工作台 成稿框窄屏降高不挤占", /#rec-preview\{min-height:132px\}/.test(sm));
    ok("工作台 粘底操作条留出 home 指示条",
      /padding:12px 0 calc\(12px \+ env\(safe-area-inset-bottom\)\)/.test(html));
  }

  // 7 桌面圆角裁切可以 hidden，但窄屏必须覆盖成可横滚（可见前面 640 断点断言）
  if (name === "index.html") {
    ok("演示页 窄屏 .panel 覆盖为可横滚", /@media \(max-width:640px\)[\s\S]*?\.panel\{overflow-x:auto/.test(html));
  }
});

if (fails.length) {
  console.error("FAIL " + fails.length + " 项：");
  fails.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PASS 适配断言：两页 viewport-fit + safe-area、pointer:coarse 44px/16px、640 断点宽表横滚（560px）、页边距 safety、零外链、「怎么打开」三条路（电脑/手机/离线或录音限制 + 可复制地址）、工作台记录卡窄屏重排与粘底操作条安全区、演示页面板不再用 overflow:hidden 裁表");