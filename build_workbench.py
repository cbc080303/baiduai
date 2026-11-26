"""把 a_channel.js 内联进 workbench_src.html，产出单文件 质检工作台.html。

只改 a_channel.js，不手改生成物；两条通道同源，避免出现第三套规则。
用法：python build_workbench.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "workbench_src.html")
AJS = os.path.join(HERE, "a_channel.js")
REC = os.path.join(HERE, "recorder.js")
OUT = os.path.join(HERE, "质检工作台.html")
MARK = "/*==A_CHANNEL==*/"
MARK_REC = "/*==RECORDER==*/"

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    html = open(SRC, encoding="utf-8").read()
    ajs = open(AJS, encoding="utf-8").read()
    rec = open(REC, encoding="utf-8").read()
    if MARK not in html or MARK_REC not in html:
        sys.stderr.write("模板里找不到占位符 %s / %s\n" % (MARK, MARK_REC))
        return 2
    # 浏览器里没有 module，去掉 CommonJS 导出段，避免 ReferenceError
    ajs = ajs.replace(
        'if (typeof module !== "undefined" && module.exports){\n  module.exports = {A_CHANNEL, scanTranscript: (raw, rows) => A_CHANNEL.scan(raw, rows)};\n}',
        "/* CommonJS 导出已在单文件构建中移除 */",
    )
    out = html.replace(MARK, ajs).replace(MARK_REC, rec)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(out)
    bad = [t for t in ('src="http', 'href="http', "@import url(http") if t in out]
    print("out:", OUT)
    print("bytes:", os.path.getsize(OUT))
    print("external refs:", len(bad))
    print("a_channel inlined:", "A_CHANNEL" in out and "scanTranscript" not in out)
    print("recorder inlined:", "RECORDER.mount" in out and MARK_REC not in out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())