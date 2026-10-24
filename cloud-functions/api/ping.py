"""GET /api/ping：测试能否连上 DeepSeek。"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zk_core  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, body = zk_core.ping()
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(payload)
