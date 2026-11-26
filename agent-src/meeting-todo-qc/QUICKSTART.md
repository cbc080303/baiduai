# 三分钟用起来（含跨电脑）

这个智能体有三种落地形态，按“换电脑要不要重装”从轻到重排：

| 形态 | 换电脑要做什么 | 依赖 | 能跑几层 |
|---|---|---|---|
| `质检工作台.html`（单文件） | 拷过去双击打开 | 只要浏览器 | D / A / C / 分档 + 导出 |
| 插件包 + 一键安装脚本 | 拷 zip 过去、跑一次脚本 | Python 3 + 客户端 | 同上，另可对话追问 |
| 手动复制目录 | 拷过去贴到 plugins/user | 同上 | 同上 |

## 方式一：单文件工作台（最省事）

把 `质检工作台.html` 拷到任何一台电脑，双击用浏览器打开。离线可用，不联网、不上传、不调模型。

1. ①框粘会议转录（每行 `姓名：内容`，首行写 `参会人：张三、李四`）。
2. ②框粘待办表，六列 CSV / TSV / Markdown 表格都认；也可点「从文件导入 CSV」。
3. 点「跑质检」，看四块结果；需要存档就点「下载报告 .md」「下载标注 .csv」。

先点「载入样例」跑一遍：应看到依据 3/6 命中、遗漏候选 1 条（李思远·压测环境）、分档 3 可建单 / 0 需补字段 / 3 待人工判断。**数字对不上说明文件被改过。**

## 方式二：装成客户端专家

Windows：

```bat
:: 解压后双击
install_dumate_windows.bat
```

macOS / Linux：

```bash
sh install_dumate.sh
```

脚本会自己在 `qianfan_desk_xdg/<实例ID>/data/plugins/user/` 下找位置并复制，不用手翻路径。装完重启客户端，左侧「插件技能」里出现 `meeting-todo-qc`。

验证：

```bash
python <插件目录>/skills/meeting-todo-qc/scripts/qc.py --check
python <插件目录>/skills/meeting-todo-qc/scripts/qc.py --demo
```

## 方式三：手动放目录

```
Windows: %APPDATA%\qianfan-desktop-app\qianfan_desk_xdg\<实例ID>\data\plugins\user\
macOS:   ~/Library/Application Support/qianfan-desktop-app/qianfan_desk_xdg/<实例ID>/data/plugins/user/
```

把 `meeting-todo-qc` 整个目录放进去，层级必须是 `plugins/user/meeting-todo-qc/plugin.json`——多套一层就读不到。

## 材料是录音时

本技能不做语音识别。两条路，任选：

- **平台转写**：DuMate「智能会议纪要助手」`createMeeting` 开始 → `endMeeting` 结束 → `queryMeeting` 取转写原文 → 存成 `原稿备份/会议原稿_<时间>.txt`（不改原文）→ 交给本技能质检。技能不上传音频、不另接识别模型。
- **自己边听边记**：打开 `质检工作台.html` 的「会议记录 · 边录边记」卡，点「开始录音」，随手用「记一条」写要点（自动带时间码与说话人），点「送入质检并运行」直接跑；「保存原稿」把文字与录音存在本机，「导出备份包 .zip」把 原稿.txt + meta.json + 录音 一起带走。同样不做语音识别——录音只作原稿留档。

转写平台导出的稿子可以直接用：行首 `[00:01:23]`、每轮发言一行、没有句末标点、夹着 `[听不清]`。工作台会把这种稿子认出来，体检区标「识别为录音转写稿」，并自动去掉时间码、说话人前缀、识别占位与标点后再比对依据。

想看差距就勾选/取消「忽略空白」跑两遍：去噪后命中、严格比对照样不命中，说明差距来自格式噪声，不是依据被改写。

限制（必须说清）：

- 没有「参会人：」行时，名单从说话人标签反推，只认出现 ≥2 次的 1–4 字真名；只发过一次言的人会被漏掉，要提示用户核对。
- 没有说话人标记的录音稿，A 通道（查遗漏）跑不了，只能跑 D 与 C。
- 同音错字不会被修掉——它会继续表现为不匹配，那是识别误差的正确暴露。

## 日常用法

```bash
python skills/meeting-todo-qc/scripts/qc.py --transcript 转录.txt --todo 待办.csv --out 质检输出
```

产物在 `质检输出/`：`报告.md`（结论 / 逐条明细 / 修正建议 / 边界）、`质检标注.csv`（十列，可直接拿去人工改判）、`摘要.json`。

## 没有 Python 的机器

走方式一。能力差异要说清：工作台有 D / A / C / 分档与导出，跑不了「双人一致率」（需两份人工标注表，脚本 `agreement.py` 单独跑），也没有对话追问。