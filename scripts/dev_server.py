"""本地预览：模拟 EdgeOne 的效果，静态文件来自 public/，/api/ping 和 /api/ask 走和云函数相同的代码。

用法：.venv/bin/python scripts/dev_server.py  然后打开 http://localhost:8765
"""
import json
import mimetypes
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from _paths import ROOT

import zk_core

PUBLIC = ROOT / "public"
PORT = int(os.environ.get("PORT", "8765"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body: bytes, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/ping":
            return self._json(*zk_core.ping())
        f = (PUBLIC / (path.lstrip("/") or "index.html")).resolve()
        if PUBLIC not in f.parents or not f.is_file():
            return self.send_error(404)
        self._send(200, f.read_bytes(), (mimetypes.guess_type(f.name)[0] or "application/octet-stream") + "; charset=utf-8")

    def do_POST(self):
        if urlparse(self.path).path != "/api/ask":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length") or 0)
        self._json(*zk_core.ask(json.loads(self.rfile.read(length) or b"{}")))


if __name__ == "__main__":
    print(f"本地预览：http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
