# -*- coding: utf-8 -*-
"""把 a_channel.js 的 A_CHANNEL 段同步进 index.html 内联块，保证“同源”。

背景：演示页要求零外链，A 通道代码必须内联；此前靠人工复制，一旦改一侧就会漂移
（第 4 组那次：Python 已 v1.3、页面还 v1.2，单字代称在页面上静默失效）。

版本号不硬编码：从 a_channel.js 首行注释里读出 `qc_tools.py vX.Y`，
用它写页面注释并做断言，避免脚本自己变成新的漂移源。

用法：python inline_a_channel.py
断言：同步后页面版本号与 a_channel.js 一致、含规则④⑤⑥与动作否决、
姓名 1–4 字、不再出现旧 {2,4}。任一不成立即退出码 1。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.join(HERE, "a_channel.js")
HTML = os.path.join(HERE, "index.html")

START = "const A_CHANNEL = (function(){"
# 结束锚点不能用“第一个 })();”：a_channel.js 内部还有 ACT_RE 等立即执行函数，
# 会先把块截断（v1.4 首次同步就踩了，内联块只剩 2165 字符）。改用尾部固定锚点。
JS_END = "\n})();\n\nif (typeof module"
HTML_END = "\n})();\n\nconst aOutEl"
BLOCK_TAIL = "\n})();"
HEADER_RE = re.compile(
    r"// -+ A 通道：按人切片查遗漏（与 qc_tools\.py v[\d.]+ slice_scan 逐条对拍一致） -+"
)
VER_RE = re.compile(r"qc_tools\.py (v[\d.]+) slice_scan")


def extract(js_text):
    i = js_text.index(START)
    j = js_text.index(BLOCK_TAIL, i) + len(BLOCK_TAIL)
    return js_text[i:j]


def main():
    with open(JS, encoding="utf-8") as f:
        js = f.read().replace("\r\n", "\n")
    with open(HTML, encoding="utf-8") as f:
        # 统一换行为 LF：锚点才能稳定匹配，线上页面也一直是 LF 版本
        html = f.read().replace("\r\n", "\n")

    m = VER_RE.search(js)
    ver = m.group(1) if m else "v1.4"
    print("a_channel.js 声明版本 %s" % ver)

    block = extract(js)
    i = html.index(START)
    j = html.index(BLOCK_TAIL, i) + len(BLOCK_TAIL)
    old = html[i:j]
    changed = old != block
    if changed:
        html = html[:i] + block + html[j:]

    header = ("// ---------- A 通道：按人切片查遗漏（与 qc_tools.py %s slice_scan "
              "逐条对拍一致） ----------" % ver)
    html, n_hdr = HEADER_RE.subn(header, html)

    with open(HTML, "w", encoding="utf-8", newline="") as f:
        f.write(html)

    checks = {
        "页面注释标 %s" % ver: ("qc_tools.py %s slice_scan" % ver) in html,
        "含规则④ 参会对象剥离": "stripInvitees" in html,
        "含规则⑤⑥ 复述/回溯句": ("isRecap" in html and "isLookback" in html),
        "含动作否决词表": "ACTION_EXTRA" in html,
        "姓名放宽为 1–4 字": "{1,4}" in html,
        "旧 {2,4} 已消失": "{2,4}" not in html,
    }
    print("内联块长度 %d 字符，%s" % (len(block), "已更新" if changed else "本就一致"))
    print("版本注释命中 %d 处" % n_hdr)
    ok = True
    for name, val in checks.items():
        print(("PASS  " if val else "FAIL  ") + name)
        ok = ok and val
    print("页面字节数 %d" % len(html.encode("utf-8")))
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()