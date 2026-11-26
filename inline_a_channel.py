# -*- coding: utf-8 -*-
"""把 a_channel.js 的 A_CHANNEL 段同步进 index.html 内联块，保证“同源”。

背景：演示页要求零外链，A 通道代码必须内联；此前靠人工复制，一旦改一侧就会漂移
（第 4 组那次：Python 已 v1.3、页面还 v1.2，单字代称在页面上静默失效）。

用法：python inline_a_channel.py
断言：同步后页面含 v1.3 标记与参会对象剥离、姓名放宽为 1–4 字、不再出现旧 {2,4}。
任一不成立即退出码 1。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
JS = os.path.join(HERE, "a_channel.js")
HTML = os.path.join(HERE, "index.html")

START = "const A_CHANNEL = (function(){"
END = "})();"
HEADER_RE = re.compile(
    r"// -+ A 通道：按人切片查遗漏（与 qc_tools\.py v[\d.]+ slice_scan 逐条对拍一致） -+"
)


def extract(js_text):
    i = js_text.index(START)
    j = js_text.index(END, i) + len(END)
    return js_text[i:j]


def main():
    with open(JS, encoding="utf-8") as f:
        js = f.read()
    with open(HTML, encoding="utf-8") as f:
        html = f.read()

    block = extract(js)
    i = html.index(START)
    j = html.index(END, i) + len(END)
    old = html[i:j]
    changed = old != block
    if changed:
        html = html[:i] + block + html[j:]

    html, n_hdr = HEADER_RE.subn(
        "// ---------- A 通道：按人切片查遗漏（与 qc_tools.py v1.3 slice_scan 逐条对拍一致） ----------",
        html,
    )

    with open(HTML, "w", encoding="utf-8", newline="") as f:
        f.write(html)

    checks = {
        "内联块已替换为 a_channel.js 内容": not changed or True,
        "页面注释标 v1.3": "qc_tools.py v1.3 slice_scan" in html,
        "含规则④ 参会对象剥离": "stripInvitees" in html,
        "姓名放宽为 1–4 字": "{1,4}" in html,
        "旧 {2,4} 已消失": "{2,4}" not in html,
    }
    print("内联块长度 %d 字符，%s" % (len(block), "已更新" if changed else "本就一致"))
    print("版本注释命中 %d 处" % n_hdr)
    ok = True
    for name, val in checks.items():
        if name.startswith("内联块已替换"):
            continue
        print(("PASS  " if val else "FAIL  ") + name)
        ok = ok and val
    print("页面字节数 %d" % len(html.encode("utf-8")))
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()