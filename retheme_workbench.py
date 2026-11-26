# -*- coding: utf-8 -*-
"""把工作台模板的视觉换成与演示页同一套设计令牌，并补结构细节。

只改样式与页头结构，不动引擎与交互逻辑；生成物仍由 build_workbench.py 产出。
"""

import re

P = "workbench_src.html"

NEW_STYLE = """<style>
  :root{
    --ink:#14181f; --muted:#5b6472; --faint:#68717d;
    --line:#e4e8ef; --line-strong:#cdd4e0;
    --bg:#f6f7f9; --card:#ffffff;
    --accent:#14548c; --accent-soft:#eaf1f8;
    --p0:#b42318; --p0-bg:#fdf1f0;
    --p1:#b54708; --p1-bg:#fdf4e7;
    --p2:#5b6472; --p2-bg:#f0f2f5;
    --ok:#067647; --ok-bg:#e9f6ef;
    --radius:10px;
    --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;background:var(--bg);color:var(--ink);
    font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB","Source Han Sans SC",system-ui,-apple-system,sans-serif;
    font-size:15px;line-height:1.65;font-variant-numeric:tabular-nums;
  }
  a{color:var(--accent)}
  .skip{position:absolute;left:-9999px}
  .skip:focus{left:12px;top:12px;z-index:99;background:#fff;padding:8px 12px;border:2px solid var(--accent);border-radius:6px}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .wrap{max-width:1180px;margin:0 auto;padding:0 24px 64px}

  .topbar{display:flex;align-items:center;gap:16px;height:56px;border-bottom:1px solid var(--line)}
  .brand{font-weight:600;letter-spacing:.2px}
  .brand span{color:var(--faint);font-weight:400;margin-left:8px;font-size:13px}
  .nav{margin-left:auto;display:flex;gap:18px;font-size:13.5px}
  .nav a{color:var(--muted);text-decoration:none;padding:4px 0;border-bottom:1.5px solid transparent}
  .nav a:hover{color:var(--ink);border-bottom-color:var(--accent)}
  .nav a.on{color:var(--ink);border-bottom-color:var(--accent)}

  .hero{padding:34px 0 24px;border-bottom:1px solid var(--line)}
  .eyebrow{font-size:12.5px;letter-spacing:.12em;color:var(--accent);text-transform:uppercase;margin:0 0 10px}
  h1{font-size:30px;line-height:1.28;margin:0 0 12px;font-weight:650;letter-spacing:-.2px}
  .lede{color:var(--muted);max-width:78ch;margin:0}

  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0 0}
  @media(max-width:860px){.grid{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow)}
  .card h2{font-size:15px;margin:0 0 6px;display:flex;align-items:center;gap:8px;font-weight:650}
  .card h2 .idx{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:700}
  .card .hint{color:var(--muted);font-size:13px;margin:0 0 10px}
  .card .hint.warn{color:#7a4a08;background:var(--p1-bg);border:1px solid #f0d9b5;border-radius:8px;padding:8px 10px}
  textarea{width:100%;min-height:196px;border:1px solid var(--line-strong);border-radius:8px;padding:10px 12px;
    font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical;background:#fff;color:var(--ink)}
  textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  textarea::placeholder{color:#9aa3b0}

  .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:12px}
  button{font:inherit;font-size:13px;padding:7px 14px;border-radius:8px;border:1px solid var(--line-strong);
    background:#fff;color:var(--ink);cursor:pointer;transition:border-color .15s,color .15s,background .15s}
  button:hover{border-color:var(--accent);color:var(--accent)}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;padding:9px 22px}
  button.primary:hover{background:#0f4070;border-color:#0f4070;color:#fff}
  button:disabled{opacity:.5;cursor:not-allowed}
  label.chk{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px}
  input[type=checkbox]{accent-color:var(--accent)}

  .actions{position:sticky;bottom:0;z-index:5;background:rgba(255,255,255,.94);border-top:1px solid var(--line);
    padding:12px 0;margin-top:16px}
  .actions .row{margin:0}
  .status{font-size:13px;color:var(--muted);margin:0}

  .preflight{margin:22px 0 0;border:1px solid #f0d9b5;background:var(--p1-bg);color:#7a4a08;
    border-radius:var(--radius);padding:12px 14px;font-size:13px}
  .preflight h3{margin:0 0 6px;font-size:14px;font-weight:650;color:#5c3606}
  .preflight ul{margin:0;padding-left:18px}
  .preflight li{margin:3px 0}
  .preflight .fix{color:#8a5a00}

  .summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(158px,1fr));gap:14px;margin:22px 0 6px}
  @media(max-width:560px){.summary{grid-template-columns:1fr 1fr}}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px 16px;box-shadow:var(--shadow)}
  .kpi .n{font-size:26px;font-weight:650;line-height:1.12}
  .kpi .t{font-size:12.5px;color:var(--muted);margin-top:2px}
  .kpi .s{font-size:12px;color:var(--faint);margin-top:4px}
  .kpi.bad .n{color:var(--p0)} .kpi.warn .n{color:var(--p1)} .kpi.ok .n{color:var(--ok)}

  section.out{margin-top:26px}
  section.out h3{font-size:15px;margin:0 0 10px;padding-left:10px;border-left:3px solid var(--accent);font-weight:650}
  table{width:100%;border-collapse:collapse;font-size:13px;background:var(--card);
    border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
  th,td{padding:9px 11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
  th{background:#f1f4f9;font-weight:600;font-size:12px;color:var(--muted);white-space:nowrap}
  tbody tr:hover{background:#fafbfd}
  tr:last-child td{border-bottom:none}
  td.num{width:54px;color:var(--muted);font-variant-numeric:tabular-nums}
  .tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:6px;background:var(--accent-soft);color:var(--accent)}
  .v-ok{display:inline-block;font-size:12px;padding:1px 8px;border-radius:6px;color:var(--ok);background:var(--ok-bg)}
  .v-bad{display:inline-block;font-size:12px;padding:1px 8px;border-radius:6px;color:var(--p0);background:var(--p0-bg)}
  .v-warn{display:inline-block;font-size:12px;padding:1px 8px;border-radius:6px;color:var(--p1);background:var(--p1-bg)}

  .note{font-size:13px;color:var(--muted);margin:10px 0 0}
  .note.alert{background:var(--p1-bg);border:1px solid #f0d9b5;color:#7a4a08;padding:10px 12px;border-radius:8px}
  .note b{color:var(--ink)}
  .empty{color:var(--muted);font-size:13px;padding:12px 0}
  footer{margin-top:34px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px}
  footer b{color:var(--ink)}
  .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--muted)}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>"""

NEW_HEAD = """<header>
  <div class="topbar">
    <div class="brand">会议待办质检器 <span>跨电脑工作台</span></div>
    <nav class="nav" aria-label="页面导航">
      <a href="index.html">← 演示页</a>
      <a class="on" href="workbench.html" aria-current="page">工作台</a>
    </nav>
  </div>
  <div class="hero">
    <p class="eyebrow">MEETING TODO QC · WORKBENCH</p>
    <h1>会议待办质检工作台</h1>
    <p class="lede">粘贴转录与待办表，一次跑完输入体检、D 依据回查、A 遗漏候选、C 字段核查与风险分档。全部在本机完成，不联网、不上传、不调模型。</p>
  </div>
</header>"""


def main():
    t = open(P, encoding="utf-8").read()

    t, n1 = re.subn(r"<style>.*?</style>", NEW_STYLE, t, count=1, flags=re.S)
    t, n2 = re.subn(r"<header>.*?</header>", NEW_HEAD, t, count=1, flags=re.S)
    print("style replaced:", n1, "header replaced:", n2)

    t = t.replace("<h2>① 会议转录</h2>", '<h2><span class="idx" aria-hidden="true">1</span>会议转录</h2>')
    t = t.replace("<h2>② 待办表</h2>", '<h2><span class="idx" aria-hidden="true">2</span>待办表</h2>')
    t = t.replace('<div class="row" style="margin-top:14px">', '<div class="actions"><div class="row">')
    t = t.replace('<span class="note" id="status" style="margin:0"></span>\n</div>',
                  '<span class="status" id="status"></span>\n</div></div>')
    if "<body>\n" in t:
        t = t.replace("<body>\n", '<body>\n<a class="skip" href="#main">跳到主要内容</a>\n', 1)
    t = t.replace('<div id="result">', '<div id="result" role="region" aria-live="polite" aria-label="质检结果">')

    open(P, "w", encoding="utf-8", newline="\n").write(t)
    print("bytes:", len(t.encode("utf-8")))


if __name__ == "__main__":
    main()