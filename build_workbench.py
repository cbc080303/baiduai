"""把 a_channel.js / recorder.js / subtitle.js / media_intake.js 内联进 workbench_src.html，
产出单文件 质检工作台.html。

只改源模块，不手改生成物；通道、记录器、字幕解析与素材识别各自同源，避免出现第二套规则。
用法：python build_workbench.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "workbench_src.html")
MODS = [
    ("/*==A_CHANNEL==*/", os.path.join(HERE, "a_channel.js")),
    ("/*==RECORDER==*/", os.path.join(HERE, "recorder.js")),
    ("/*==SUBTITLE==*/", os.path.join(HERE, "subtitle.js")),
    ("/*==MEDIA==*/", os.path.join(HERE, "media_intake.js")),
]
OUT = os.path.join(HERE, "质检工作台.html")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def main():
    html = open(SRC, encoding="utf-8").read()
    missing = [m for m, _ in MODS if m not in html]
    if missing:
        sys.stderr.write("模板里找不到占位符：%s\n" % "、".join(missing))
        return 2

    out = html
    for mark, path in MODS:
        code = open(path, encoding="utf-8").read()
        # 浏览器里没有 CommonJS：去掉导出段，避免 ReferenceError
        code = code.replace(
            'if (typeof module !== "undefined" && module.exports){\n'
            '  module.exports = {A_CHANNEL, scanTranscript: (raw, rows) => A_CHANNEL.scan(raw, rows)};\n'
            '}',
            "/* CommonJS 导出已在单文件构建中移除 */",
        ).replace(
            'if (typeof module !== "undefined" && module.exports) module.exports = RECORDER;',
            "/* CommonJS 导出已在单文件构建中移除 */",
        ).replace(
            'if (typeof module !== "undefined" && module.exports) module.exports = SUBTITLE;',
            "/* CommonJS 导出已在单文件构建中移除 */",
        ).replace(
            'if (typeof module !== "undefined" && module.exports) module.exports = MEDIA;',
            "/* CommonJS 导出已在单文件构建中移除 */",
        )
        out = out.replace(mark, code)

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(out)

    bad = [t for t in ('src="http', 'href="http', "@import url(http") if t in out]
    print("out:", OUT)
    print("bytes:", os.path.getsize(OUT))
    print("external refs:", len(bad))
    print("a_channel inlined:", "A_CHANNEL" in out and "scanTranscript" not in out)
    print("recorder inlined:", "RECORDER.mount" in out and "/*==RECORDER==*/" not in out)
    print("subtitle inlined:", "SUBTITLE.parse" in out and "/*==SUBTITLE==*/" not in out)
    print("media inlined:", "MEDIA.kindOf" in out and "/*==MEDIA==*/" not in out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())