#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用最小权限 token 为 cbc080303/baiduai 开启 GitHub Pages，并轮询验证站点。

准备：把 token 粘贴到本文件同目录的 .token（单行，只放 token 本身）。
运行：python open_pages.py
本脚本不会打印 token，也不会把 token 写入任何其他位置。
"""

import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

OWNER, REPO = "cbc080303", "baiduai"
TOKEN_FILE = pathlib.Path(__file__).with_name(".token")
API = "https://api.github.com"
SITE = f"https://{OWNER}.github.io/{REPO}/"


def read_token():
    if not TOKEN_FILE.exists():
        sys.exit(f"缺少 .token 文件。请把 token 粘贴到：{TOKEN_FILE}")
    t = TOKEN_FILE.read_text(encoding="utf-8").strip()
    if not t:
        sys.exit(".token 是空的，请只粘贴 token 本身")
    return t


def call(method, path, tk, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + tk)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        raw = e.read().decode() or "{}"
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"message": raw[:200]}


def main():
    tk = read_token()

    st, me = call("GET", "/user", tk)
    if st != 200:
        sys.exit(f"token 无效或权限不足（HTTP {st}）：{me.get('message')}")
    print("已认证账号：", me.get("login"))

    st, repo = call("GET", f"/repos/{OWNER}/{REPO}", tk)
    print("仓库可读：", st == 200, "| 默认分支：", repo.get("default_branch"))

    st, pages = call("GET", f"/repos/{OWNER}/{REPO}/pages", tk)
    if st == 200:
        src = pages.get("source") or {}
        print("Pages 已存在 | 状态：", pages.get("status"), "| 分支：", src.get("branch"), "| 目录：", src.get("path"))
    else:
        st, r = call("POST", f"/repos/{OWNER}/{REPO}/pages", tk,
                     {"source": {"branch": "main", "path": "/"}})
        if st in (201, 200, 204):
            print("已开启 Pages：", r.get("html_url") or SITE)
        else:
            print("开启失败 HTTP", st, "|", r.get("message"))
            print("如提示权限不足，请确认 token 勾选了 repo（classic）或 Pages: Read and write（fine-grained）")

    print("\n开始轮询站点（最多 12 次，每次间隔 10 秒）：")
    for i in range(12):
        time.sleep(10)
        try:
            with urllib.request.urlopen(f"{SITE}?t={int(time.time())}", timeout=20) as r:
                body = r.read().decode("utf-8", errors="replace")
                ok = 'id="run-a"' in body
                print(f"[{i+1}] HTTP {r.status} | 字节 {len(body.encode('utf-8'))} | run-a 存在: {ok}")
                if r.status == 200 and ok:
                    print("\n上线完成：", SITE)
                    return
        except urllib.error.HTTPError as e:
            print(f"[{i+1}] HTTP {e.code}（构建中）")
        except Exception as e:
            print(f"[{i+1}] 请求失败：{e}")

    print("\n轮询超时。Pages 通常 30–90 秒完成首次构建，可稍后手动访问：", SITE)


if __name__ == "__main__":
    main()