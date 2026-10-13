#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bench T4 真靶机：带真实 LFI（路径穿越）漏洞的微型 Web 服务。

漏洞形态：/view?file=<name> 读 webroot 下文件，但不过滤 ../ ——
可穿越到 webroot 外读 ../flag.txt（真 flag 在 webroot 外，必须真利用才拿得到）。

用法：python bench/targets/lfi-target.py [--port 8400]
（flag 写在 <本目录>/secret/flag.txt，webroot 在 <本目录>/webroot/）
"""
import argparse
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

BASE = Path(__file__).resolve().parent
WEBROOT = BASE / "webroot"
SECRET = BASE / "secret"

INDEX = """<html><body>
<h1>ImageShare</h1>
<p>查看图片：<code>/view?file=logo.txt</code></p>
<ul><li><a href="/view?file=logo.txt">logo.txt</a></li>
<li><a href="/view?file=notes/todo.txt">notes/todo.txt</a></li></ul>
</body></html>"""


def ensure_files():
    (WEBROOT / "notes").mkdir(parents=True, exist_ok=True)
    SECRET.mkdir(exist_ok=True)
    (WEBROOT / "logo.txt").write_text("ImageShare v0.9 logo placeholder\n")
    (WEBROOT / "notes" / "todo.txt").write_text(
        "1. 上线前把 secret 目录挪走\n2. 别忘了改 admin 密码\n")
    (SECRET / "flag.txt").write_text("flag{real_lfi_path_traversal_04}\n")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/":
            return self._send(200, INDEX)
        if u.path == "/view":
            f = (parse_qs(u.query).get("file") or [""])[0]
            # ⚠️ 漏洞点：直接拼接 webroot + 用户输入，无 ../ 过滤
            target = WEBROOT / f
            try:
                if target.is_file():
                    return self._send(200, target.read_text(errors="replace"),
                                      "text/plain; charset=utf-8")
            except OSError:
                pass
            return self._send(404, "not found", "text/plain; charset=utf-8")
        return self._send(404, "not found", "text/plain; charset=utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8400)
    args = ap.parse_args()
    ensure_files()
    print(f"lfi-target on http://127.0.0.1:{args.port}（webroot={WEBROOT}）")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
