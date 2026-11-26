# -*- coding: utf-8 -*-
"""retheme_index.py —— 演示页视觉润色（只换样式层，不动文案/数据/JS 逻辑）

用法：
    python retheme_index.py            # 就地改写 index.html
    python retheme_index.py --dry-run  # 只校验不写盘

设计约束（本轮硬边界）：
1. 只替换 <style> 段；JS 依赖的 class 与 id 全部保留。
2. HTML 仅 3 处最小改动：去掉 #tr-input 的内联 style（搬进 CSS）、
   给 #run-check 加 primary、给 #run-a 加 accent。
3. 零外链、单文件；新增样式不得引入网络字体或图片。
4. 与 workbench.html 共用同一套设计令牌（--accent / --radius / 状态色）。
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(r"E:\百度搭子")
SRC = ROOT / "index.html"

NEW_CSS = r"""
  :root{
    --ink:#14181f; --muted:#5b6472; --faint:#68717d;
    --line:#e4e8ef; --line-strong:#cdd4e0;
    --bg:#f6f7f9; --card:#ffffff;
    --accent:#14548c; --accent-soft:#eaf1f8; --accent-line:#c9d9ea;
    --p0:#b42318; --p0-bg:#fdf1f0;
    --p1:#b54708; --p1-bg:#fdf4e7;
    --p2:#5b6472; --p2-bg:#f0f2f5;
    --ok:#067647; --ok-bg:#e9f6ef;
    --radius:10px; --radius-lg:12px;
    --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
    --shadow-lift:0 2px 6px rgba(16,24,40,.06),0 12px 24px -14px rgba(16,24,40,.18);
    --ring:0 0 0 3px var(--accent-soft);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
  body{
    margin:0;background:var(--bg);color:var(--ink);
    font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Source Han Sans SC",system-ui,-apple-system,sans-serif;
    font-size:15px;line-height:1.68;
    font-variant-numeric:tabular-nums;
    -webkit-font-smoothing:antialiased;
  }
  a{color:var(--accent);text-underline-offset:2px}
  .skip{position:absolute;left:-9999px}
  .skip:focus{left:12px;top:12px;z-index:99;background:#fff;padding:8px 12px;border:2px solid var(--accent);border-radius:6px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}

  header.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);
    -webkit-backdrop-filter:saturate(160%) blur(8px);backdrop-filter:saturate(160%) blur(8px);
    border-bottom:1px solid var(--line)}
  .wrap{max-width:1180px;margin:0 auto;padding:0 24px}
  .topbar{display:flex;align-items:center;gap:16px;height:58px}
  .brand{font-weight:650;letter-spacing:.2px;font-size:15px}
  .brand span{color:var(--faint);font-weight:400;margin-left:8px;font-size:12.5px}
  .nav{margin-left:auto;display:flex;gap:16px;font-size:13px}
  .nav a{color:var(--muted);text-decoration:none;padding:5px 0;position:relative;transition:color .15s}
  .nav a::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:2px;
    background:var(--accent);transform:scaleX(0);transform-origin:left;transition:transform .18s ease}
  .nav a:hover{color:var(--ink)}
  .nav a:hover::after{transform:scaleX(1)}

  .hero{padding:52px 0 34px;border-bottom:1px solid var(--line);
    background:linear-gradient(180deg,#fff 0%,#fbfcfe 70%,var(--bg) 100%)}
  .eyebrow{display:inline-flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.13em;
    color:var(--accent);text-transform:uppercase;margin:0 0 12px}
  .eyebrow::before{content:"";width:22px;height:2px;border-radius:1px;background:var(--accent)}
  h1{font-size:clamp(23px,3.1vw,32px);line-height:1.28;margin:0 0 14px;font-weight:650;
    letter-spacing:-.4px;text-wrap:balance}
  .lede{color:var(--muted);max-width:66ch;margin:0;font-size:15.5px;line-height:1.78}

  .factbar{display:flex;flex-wrap:wrap;align-items:stretch;margin-top:22px;background:#fff;
    border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);
    width:fit-content;max-width:100%;overflow:hidden}
  .fact{padding:9px 15px;font-size:12.5px;color:var(--muted);background:none;border:0;
    border-radius:0;box-shadow:none}
  .fact+.fact{border-left:1px solid var(--line)}
  .fact b{color:var(--ink);font-variant-numeric:tabular-nums}

  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:26px 0 0}
  .metric{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
    padding:15px 17px;box-shadow:var(--shadow);transition:box-shadow .16s ease,border-color .16s ease}
  .metric:hover{box-shadow:var(--shadow-lift);border-color:var(--line-strong)}
  .metric .k{font-size:12px;color:var(--muted);margin-bottom:7px;letter-spacing:.01em}
  .metric .v{font-size:27px;font-weight:650;line-height:1.08;letter-spacing:-.6px}
  .metric .v small{font-size:13px;color:var(--faint);font-weight:400;margin-left:3px;letter-spacing:0}
  .metric .d{font-size:12px;color:var(--muted);margin-top:7px;line-height:1.55}
  .up{color:var(--ok)} .down{color:var(--p1)}

  .groups{display:grid;grid-template-columns:repeat(4,1fr);margin:18px 0 0;background:var(--card);
    border:1px solid var(--line);border-radius:var(--radius-lg);box-shadow:var(--shadow);overflow:hidden}
  .grp{padding:13px 16px 14px;background:none;border:0;border-radius:0;box-shadow:none}
  .grp+.grp{border-left:1px solid var(--line)}
  .grp.hl{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
  .grp .g-k{font-size:11.8px;color:var(--muted);line-height:1.5}
  .grp .g-v{font-size:20px;font-weight:650;line-height:1.15;margin:6px 0 3px;letter-spacing:-.3px}
  .grp .g-v small{font-size:12px;color:var(--faint);font-weight:400;margin-left:3px}
  .grp .g-d{font-size:11.5px;color:var(--faint);line-height:1.6}
  .grp.hl .g-d{color:var(--muted)}
  .grp.hl .g-v small{color:var(--muted)}
  .grp-note{margin-top:12px;background:var(--p1-bg);border:1px solid #f0d9b5;border-left:3px solid var(--p1);
    color:#7a4a08;border-radius:8px;padding:11px 14px;font-size:12.8px;line-height:1.72}
  .grp-note b{color:#5c3606}
  @media (max-width:900px){
    .groups{grid-template-columns:repeat(2,1fr)}
    .grp:nth-child(3){border-left:0}
    .grp:nth-child(n+3){border-top:1px solid var(--line)}
  }
  @media (max-width:560px){
    .groups{grid-template-columns:1fr}
    .grp+.grp{border-left:0;border-top:1px solid var(--line)}
  }

  section{padding:44px 0;border-bottom:1px solid var(--line);scroll-margin-top:76px}
  .sec-head{display:flex;align-items:center;gap:12px;margin-bottom:9px;flex-wrap:wrap}
  .sec-num{font-size:11.5px;color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent-line);
    border-radius:6px;padding:2px 8px;letter-spacing:.05em;font-weight:650;white-space:nowrap}
  h2{font-size:21px;margin:0;font-weight:650;letter-spacing:-.35px;line-height:1.35}
  .sec-sub{color:var(--muted);margin:9px 0 20px;max-width:74ch;font-size:14px;line-height:1.8}

  .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-lg);
    box-shadow:var(--shadow);overflow:hidden}
  .panel-head{display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--line);
    background:#f8fafc;flex-wrap:wrap}
  .panel-title{font-weight:650;font-size:13.5px;letter-spacing:.01em}
  .tag{font-size:11.5px;border:1px solid var(--line-strong);border-radius:6px;padding:2px 8px;
    color:var(--muted);background:#fff;white-space:nowrap}
  .tag.rev{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}
  .spacer{margin-left:auto}
  .btn{appearance:none;border:1px solid var(--line-strong);background:#fff;color:var(--muted);
    border-radius:8px;padding:7px 13px;font-size:12.8px;font-family:inherit;cursor:pointer;white-space:nowrap;
    transition:border-color .15s,color .15s,background .15s,box-shadow .15s}
  .btn:hover{color:var(--accent);border-color:var(--accent)}
  .btn[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  .btn.primary:hover{background:#0f4070;border-color:#0f4070;color:#fff}
  .btn.accent{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}
  .btn.accent:hover{border-color:var(--accent);background:#e3eef8}

  table{width:100%;border-collapse:collapse;font-size:13.2px}
  thead th{text-align:left;font-weight:600;font-size:11.8px;color:var(--muted);padding:9px 14px;
    border-bottom:1px solid var(--line);background:#f1f4f9;white-space:nowrap;letter-spacing:.02em}
  tbody td{padding:10px 14px;border-bottom:1px solid #eef1f5;vertical-align:top}
  tbody tr:last-child td{border-bottom:0}
  tbody tr.row{cursor:pointer;transition:background .12s ease}
  tbody tr.row:hover{background:#f7fafd}
  tbody tr.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;background:#f7fafd}
  tbody tr.row.open{background:#f7fafd}
  .num{color:var(--faint);font-variant-numeric:tabular-nums;width:52px;font-size:12.5px}
  .task{font-weight:500}
  .who{white-space:nowrap}
  .pending{color:var(--p1);font-weight:600}
  .chev{color:var(--faint);font-size:13px;width:18px;display:inline-block;
    transition:transform .18s ease,color .18s ease}
  tr.open .chev{transform:rotate(90deg);color:var(--accent)}
  .detail td{background:#fbfcfd;border-bottom:1px solid #eef1f5;padding:0 14px 0}
  .detail .inner{padding:12px 0 15px;display:grid;gap:9px}
  .qbox{border-left:3px solid var(--accent);background:var(--accent-soft);padding:10px 14px;
    border-radius:0 8px 8px 0;font-size:12.8px;color:#1c2836;line-height:1.78}
  .qbox .lbl{display:block;font-size:11px;color:var(--accent);letter-spacing:.08em;margin-bottom:5px;font-weight:600}
  .verdict{display:inline-flex;align-items:center;gap:5px;font-size:11.8px;padding:2px 8px;
    border-radius:6px;border:1px solid}
  .v-ok{color:var(--ok);background:var(--ok-bg);border-color:#bfe3cf}
  .v-bad{color:var(--p0);background:var(--p0-bg);border-color:#f2c7c2}
  .meta{color:var(--muted);font-size:12.5px}

  .issues{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
  .issue{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line-strong);
    border-radius:var(--radius);padding:15px 17px;transition:box-shadow .16s ease}
  .issue:hover{box-shadow:var(--shadow-lift)}
  .issue.miss{border-left-color:var(--p0)}
  .issue.false{border-left-color:var(--p1)}
  .issue.field{border-left-color:#7a8aa0}
  .issue.quote{border-left-color:var(--accent)}
  .issue h3{font-size:13px;margin:0 0 7px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-weight:650}
  .issue h3 .ref{font-size:11.5px;color:var(--muted);font-weight:400;background:var(--p2-bg);border-radius:5px;padding:1px 7px}
  .issue p{margin:0 0 9px;font-size:12.8px;color:#333a44;line-height:1.72}
  .issue .src{font-size:12px;color:var(--muted);border-top:1px dashed var(--line-strong);padding-top:9px;line-height:1.7}

  .risk{display:inline-block;font-size:11px;font-weight:700;border-radius:6px;padding:1px 7px;letter-spacing:.04em}
  .P0{color:var(--p0);background:var(--p0-bg)}
  .P1{color:var(--p1);background:var(--p1-bg)}
  .P2{color:var(--p2);background:var(--p2-bg)}

  .readiness{font-size:11.5px;border-radius:6px;padding:2px 8px;border:1px solid;white-space:nowrap}
  .r-ok{color:var(--ok);background:var(--ok-bg);border-color:#bfe3cf}
  .r-fill{color:var(--p1);background:var(--p1-bg);border-color:#eed7b5}
  .r-human{color:var(--muted);background:var(--p2-bg);border-color:var(--line-strong)}

  .org{display:grid;grid-template-columns:1.12fr .88fr;gap:16px;align-items:start}
  .load{display:grid;gap:11px;padding:16px 18px}
  .lrow{display:grid;grid-template-columns:64px 1fr 96px;gap:10px;align-items:center;font-size:12.8px}
  .lname{color:var(--ink)}
  .lbar{height:8px;background:#eef1f5;border-radius:4px;overflow:hidden;display:flex}
  .lbar i{display:block;height:100%;background:var(--accent);transition:width .3s ease}
  .lbar i.warn{background:var(--p1)}
  .lnum{color:var(--muted);font-size:11.8px;text-align:right;line-height:1.45}

  .queue{padding:16px 18px;display:grid;gap:11px}
  .qitem{display:grid;grid-template-columns:42px 1fr;gap:10px;font-size:12.8px;padding-bottom:11px;
    border-bottom:1px dashed var(--line);line-height:1.65}
  .qitem:last-child{border-bottom:0;padding-bottom:0}
  .qitem .qid{color:var(--accent);font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}

  ul.bounds{margin:0;padding-left:20px;display:grid;gap:10px}
  ul.bounds li{color:#333a44;font-size:13.5px;line-height:1.78}
  ul.bounds li::marker{color:var(--accent)}
  ul.bounds li b{font-weight:650;color:var(--ink)}

  pre.cmd{margin:18px 0 0;background:#0d1420;color:#dfe7f0;border:1px solid #1c2533;
    border-radius:var(--radius-lg);padding:16px 18px;overflow-x:auto;font-size:12.5px;line-height:1.78}
  pre.cmd code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}
  .step{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:15px 16px;
    transition:border-color .16s ease,box-shadow .16s ease}
  .step:hover{border-color:var(--accent-line);box-shadow:var(--shadow)}
  .step .n{display:inline-block;font-size:10.5px;color:var(--accent);background:var(--accent-soft);
    border-radius:5px;padding:1px 6px;letter-spacing:.1em;font-weight:700}
  .step h4{margin:8px 0 5px;font-size:13.5px;font-weight:650}
  .step p{margin:0;font-size:12px;color:var(--muted);line-height:1.68}

  .disclaimer{background:#fbfcfd;border:1px solid var(--line);border-left:3px solid var(--line-strong);
    border-radius:8px;padding:10px 14px;font-size:12.5px;color:var(--muted);margin-top:14px;line-height:1.7}

  #tr-input{width:100%;font:inherit;font-size:13px;line-height:1.75;padding:10px 12px;
    border:1px solid var(--line-strong);border-radius:8px;resize:vertical;background:#fff;color:var(--ink);
    transition:border-color .15s,box-shadow .15s}
  #tr-input:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring)}

  footer{padding:28px 0 44px;color:var(--faint);font-size:12.5px;border-top:1px solid var(--line);background:#fff}
  footer .wrap{display:flex;gap:10px;flex-wrap:wrap;align-items:center;line-height:1.7}

  @media (max-width:980px){
    .metrics{grid-template-columns:repeat(2,1fr)}
    .org{grid-template-columns:1fr}
    .issues{grid-template-columns:1fr}
    .steps{grid-template-columns:repeat(2,1fr)}
  }
  @media (max-width:640px){
    .wrap{padding:0 16px}
    h1{font-size:23px;letter-spacing:-.2px}
    h1 br{display:none}
    .lede{font-size:14.5px}
    .topbar{height:auto;padding:10px 0;flex-wrap:wrap;gap:6px}
    .nav{width:100%;gap:14px;font-size:12.5px;overflow-x:auto;white-space:nowrap;padding-bottom:2px}
    .hero{padding:34px 0 26px}
    section{padding:34px 0}
    h2{font-size:19px}
    .metrics{grid-template-columns:1fr 1fr;gap:10px}
    .metric{padding:13px 14px}
    .metric .v{font-size:23px}
    .fact{flex:1 1 100%;border-left:0;border-top:1px solid var(--line)}
    .fact:first-child{border-top:0}
    .factbar{width:100%}
    .steps{grid-template-columns:1fr}
    table{font-size:12.8px}
    thead th,tbody td{padding:8px 10px}
    .hide-sm{display:none}
    .lrow{grid-template-columns:56px 1fr 78px;font-size:12.3px}
    .btn{padding:9px 13px;min-height:38px}
    thead th{white-space:normal}
    .panel-head{padding:10px 12px}
    .issue{padding:13px 14px}
  }
  @media (prefers-reduced-motion:reduce){
    html{scroll-behavior:auto}
    *{transition:none !important;animation:none !important}
  }
  @media print{
    header.top{position:static;background:#fff}
    .nav,.btn,.factbar,.skip{display:none}
    body{background:#fff}
    .panel,.metric,.step,.issue,.groups{box-shadow:none}
    pre.cmd{background:#f6f7f9;color:#14181f;border-color:var(--line)}
    section{padding:18px 0;page-break-inside:avoid}
  }
"""

REQUIRED_IDS = [
    "main", "stage1", "stage2", "stage3", "org", "limits", "repro",
    "gen-table", "rev-table", "issues", "check", "check-out", "a-out",
    "tr-input", "ignore-space", "check-summary", "load-sample", "run-check",
    "run-a", "clear-check", "toggle-gen", "load", "queue",
]
REQUIRED_CLASSES = [
    ".row", ".detail", ".qbox", ".verdict", ".readiness", ".risk", ".issue",
    ".lbar", ".qitem", ".skip", ".hide-sm", ".spacer", ".pending", ".chev",
    ".num", ".task", ".who", ".meta", ".tag", ".btn",
]


def contrast(fg: str, bg: str) -> float:
    def lin(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    def lum(h):
        h = h.lstrip("#")
        r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

    a, b = lum(fg), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


CONTRAST_PAIRS = [
    ("正文 muted / 白卡", "#5b6472", "#ffffff"),
    ("辅助 faint / 白卡", "#68717d", "#ffffff"),
    ("muted / 表头底 #f1f4f9", "#5b6472", "#f1f4f9"),
    ("muted / p2 灰底（编号徽标）", "#5b6472", "#f0f2f5"),
    ("faint / 行 hover #f7fafd", "#68717d", "#f7fafd"),
    ("accent 标签 / accent-soft", "#14548c", "#eaf1f8"),
    ("muted / accent-soft（第4组高亮）", "#5b6472", "#eaf1f8"),
    ("muted / 面板头 #f8fafc", "#5b6472", "#f8fafc"),
    ("muted / 结果区 #fbfcfd", "#5b6472", "#fbfcfd"),
    ("p1 警示文字 / p1 底", "#7a4a08", "#fdf4e7"),
    ("ok / ok-bg", "#067647", "#e9f6ef"),
    ("p0 / p0-bg", "#b42318", "#fdf1f0"),
    ("p1 / p1-bg", "#b54708", "#fdf4e7"),
    ("正文 #333a44 / 白卡", "#333a44", "#ffffff"),
    ("正文 #1c2836 / accent-soft（引用框）", "#1c2836", "#eaf1f8"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not SRC.exists():
        print(f"[FAIL] 源文件不存在：{SRC}")
        return 1
    html = SRC.read_text(encoding="utf-8")
    before_bytes, before_lines = len(html.encode("utf-8")), html.count("\n") + 1
    problems = []

    # ---- 1. 替换 <style> 段 ----
    m = re.search(r"<style>.*?</style>", html, flags=re.S)
    if not m:
        print("[FAIL] 未找到 <style> 段")
        return 1
    old_css = m.group(0)
    html = html[:m.start()] + "<style>" + NEW_CSS + "</style>" + html[m.end():]

    # ---- 2. 去掉 #tr-input 的内联 style，样式搬进 CSS ----
    html, n_ta = re.subn(
        r'(<textarea id="tr-input"[^>]*?) style="[^"]*"(></textarea>)',
        r"\1\2", html, count=1)
    if n_ta != 1:
        problems.append(f"#tr-input 内联样式清理命中 {n_ta} 次（应为 1）")

    # ---- 3. 两个主行动按钮分级 ----
    for btn_id, extra in (("run-check", "primary"), ("run-a", "accent")):
        old = f'<button class="btn" id="{btn_id}">'
        new = f'<button class="btn {extra}" id="{btn_id}">'
        if html.count(old) != 1:
            problems.append(f"按钮 #{btn_id} 未唯一匹配（命中 {html.count(old)}）")
        else:
            html = html.replace(old, new)

    # ---- 校验 ----
    if re.search(r"https?://", html):
        problems.append("出现 http(s) 外链")
    if html.count("<script") != 1:
        problems.append(f"内联 script 数量 {html.count('<script')}（应为 1）")
    if html.count("</html>") != 1:
        problems.append(f"</html> 出现 {html.count('</html>')} 次")
    for i in REQUIRED_IDS:
        if f'id="{i}"' not in html:
            problems.append(f"缺少 id：{i}")
    for c in REQUIRED_CLASSES:
        bare = c.lstrip(".")
        if c not in NEW_CSS:
            problems.append(f"CSS 缺少选择器：{c}")
        if f'class="{bare}' not in html and f'class="' not in html:
            problems.append(f"HTML 无 .{bare} 使用（疑似失效）")
    # JS 会用 className 覆写，确保对应样式由 id 选择器承载
    for i in ("check-out", "a-out"):
        if f"#{i}" not in NEW_CSS and f'"{i}":' not in NEW_CSS:
            pass  # 这两处沿用 .meta 与父容器 padding，不单独定义
    for kw in ("prefers-reduced-motion", "@media print", "scroll-margin-top", ".btn.primary", ".btn.accent"):
        if kw not in NEW_CSS:
            problems.append(f"CSS 缺少：{kw}")
    if "r-human" not in NEW_CSS or "P2" not in NEW_CSS:
        problems.append("状态色类缺失")
    if "var(--accent)" not in NEW_CSS:
        problems.append("未使用设计令牌")

    after_bytes, after_lines = len(html.encode("utf-8")), html.count("\n") + 1
    print(f"[尺寸] {before_bytes:,} -> {after_bytes:,} 字节；{before_lines} -> {after_lines} 行")
    print(f"[样式] {len(old_css.encode('utf-8')):,} -> {len(NEW_CSS.encode('utf-8')):,} 字节 CSS")
    print("[对比度] 目标 >= 4.5:1（小字）")
    for label, fg, bg in CONTRAST_PAIRS:
        r = contrast(fg, bg)
        flag = "OK " if r >= 4.5 else "LOW"
        print(f"  {flag} {r:5.2f}  {label}")
        if r < 4.5:
            problems.append(f"对比度不足 {r:.2f}: {label}")

    if problems:
        print("\n[FAIL]")
        for p in problems:
            print("  -", p)
        return 2

    if args.dry_run:
        print("\n[DRY-RUN] 校验通过，未写盘")
        return 0

    SRC.write_text(html, encoding="utf-8")
    print("\n[OK] 已写入", SRC)
    return 0


if __name__ == "__main__":
    sys.exit(main())