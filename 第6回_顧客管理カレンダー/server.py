#!/usr/bin/env python3
"""
顧問先管理カレンダー スタンドアロンサーバー（配布版）

使い方:
  python server.py
  → ブラウザで http://localhost:3460 を開く

機能:
- index.html / data.json / clients/ の配信
- タスク状態・チャットURLの保存（calendar-tasks.json / chat-urls.json）
- e-Tax / eLTAX 自動ログインの起動（etax_login.py / eltax_login.py を呼ぶ）
- Notion同期（任意。.env に NOTION_TOKEN と NOTION_DB_ID を設定した場合のみ）
"""
import json
import os
import subprocess
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).parent
PORT = 3460

DATA_JSON = BASE / "data.json"
CHAT_URLS_FILE = BASE / "chat-urls.json"
CALENDAR_TASKS_FILE = BASE / "calendar-tasks.json"
CREDENTIALS_FILE = BASE / "tax-credentials.json"  # git管理外。e-Tax/eLTAXの暗証番号（任意）
GENERATE_PY = BASE / "generate.py"
ETAX_LOGIN_PY = BASE / "etax_login.py"
ELTAX_LOGIN_PY = BASE / "eltax_login.py"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

MISSING_CLIENT_PAGE = """<!doctype html><html lang="ja"><meta charset="utf-8">
<title>詳細ページ未生成</title>
<body style="font-family:sans-serif; max-width:560px; margin:80px auto; line-height:1.8;">
<h2>この顧問先の詳細ページはまだありません</h2>
<p>詳細ページ（clients/*.html）は Notion同期（generate.py）で自動生成されます。<br>
Notion連携をしない場合はこの画面は使いません。一覧に戻ってご利用ください。</p>
<p><a href="/">← カレンダーに戻る</a></p>
</body></html>"""


def load_env_file():
    """BASE/.env から環境変数を読み込む（既に設定済みの変数は上書きしない）"""
    env_path = BASE / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


class Handler(BaseHTTPRequestHandler):
    server_version = "ClientCalendarBox/1.0"

    # ---- 共通レスポンス ----

    def _send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _json_ok(self, obj):
        self._json(obj, 200)

    def _json_error(self, message, status=500):
        self._json({"ok": False, "error": message}, status)

    def _serve_file(self, rel_path: str):
        rel_path = rel_path.lstrip("/")
        # パストラバーサル防止
        target = (BASE / rel_path).resolve()
        if not str(target).startswith(str(BASE.resolve())):
            return self._json_error("forbidden", 403)
        if not target.exists() or not target.is_file():
            if rel_path.startswith("clients/") and rel_path.endswith(".html"):
                body = MISSING_CLIENT_PAGE.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            return self._json_error("not found: " + rel_path, 404)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    # ---- ルーティング ----

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        # 元のダッシュボードと同じパスを維持（index.htmlを書き換えずに済むように）
        if path.startswith("/ops/tools/client-calendar/"):
            path = path[len("/ops/tools/client-calendar/"):]
            return self._serve_file(path)
        if path in ("/", "/index.html"):
            return self._serve_file("index.html")
        if path == "/chat-urls":
            return self._json_ok(read_json(CHAT_URLS_FILE, {}))
        if path == "/api/calendar-tasks":
            return self._json_ok(read_json(CALENDAR_TASKS_FILE, {"task_statuses": {}, "spot_tasks": []}))
        if path == "/api/freee-unprocessed":
            return self._json_ok(read_json(BASE / "freee_unprocessed.json", {"counts": {}}))
        return self._serve_file(urllib.parse.unquote(path))

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/chat-urls":
                return self._handle_chat_urls_post()
            if path == "/api/calendar-tasks":
                return self._handle_calendar_tasks_post()
            if path == "/sync":
                return self._handle_sync()
            if path == "/api/freee-unprocessed/refresh":
                return self._json_error("freee連携はこの配布版には含まれていません（freee APIと接続すれば拡張できます）", 501)
            if path == "/api/etax-login":
                return self._handle_tax_login("etax")
            if path == "/api/eltax-login":
                return self._handle_tax_login("eltax")
            return self._json_error("unknown endpoint: " + path, 404)
        except Exception as e:
            return self._json_error(str(e))

    # ---- ハンドラ ----

    def _handle_chat_urls_post(self):
        body = self._read_body()
        client_id = body.get("clientId", "")
        url = body.get("url", "")
        if not client_id:
            return self._json_error("clientId required", 400)
        data = read_json(CHAT_URLS_FILE, {})
        if url:
            data[client_id] = url
        else:
            data.pop(client_id, None)
        CHAT_URLS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._json_ok({"ok": True})

    def _handle_calendar_tasks_post(self):
        body = self._read_body()
        data = {
            "task_statuses": body.get("task_statuses", {}),
            "spot_tasks": body.get("spot_tasks", []),
        }
        CALENDAR_TASKS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._json_ok({"ok": True})

    def _handle_sync(self):
        if not os.environ.get("NOTION_TOKEN"):
            return self._json_error(
                "Notion同期は未設定です。.env に NOTION_TOKEN と NOTION_DB_ID を設定してください"
                "（Notionを使わない場合は data.json を直接編集してください）", 501)
        result = subprocess.run(
            [sys.executable, "-u", str(GENERATE_PY)],
            cwd=str(BASE), capture_output=True, text=True, timeout=300,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if result.returncode != 0:
            tail = (result.stderr or result.stdout or "").strip().splitlines()[-5:]
            return self._json_error("generate.py 失敗: " + " / ".join(tail))
        self._json_ok({"ok": True})

    def _handle_tax_login(self, kind: str):
        """e-Tax / eLTAX 自動ログイン起動。IDはリクエストから、暗証番号は tax-credentials.json から取る"""
        body = self._read_body()
        client_id = body.get("clientId", "")
        creds = read_json(CREDENTIALS_FILE, {}).get(client_id, {})
        if kind == "etax":
            login_id = body.get("etaxId", "") or creds.get("etax_id", "")
            login_pw = creds.get("etax_pw", "")
            script, id_env, pw_env, label = ETAX_LOGIN_PY, "ETAX_ID", "ETAX_PW", "e-Tax"
        else:
            login_id = body.get("eltaxId", "") or creds.get("eltax_id", "")
            login_pw = creds.get("eltax_pw", "")
            script, id_env, pw_env, label = ELTAX_LOGIN_PY, "ELTAX_ID", "ELTAX_PW", "eLTAX"
        if not login_id:
            return self._json_error(f"{label} のIDが未設定です（一覧の +ボタン から登録できます）", 404)
        # 暗証番号は任意。未登録でもID自動入力までは動く
        env = {**os.environ, id_env: login_id, pw_env: login_pw, "PYTHONIOENCODING": "utf-8"}
        log_dir = BASE / "temp"
        log_dir.mkdir(exist_ok=True)
        log_file = open(log_dir / f"{kind}_login_debug.log", "w", encoding="utf-8")
        subprocess.Popen([sys.executable, "-u", str(script)], env=env, stdout=log_file, stderr=log_file)
        self._json_ok({"ok": True, "message": f"{label} ログインを起動しました"})

    def log_message(self, fmt, *args):
        pass  # アクセスログは出さない


def main():
    load_env_file()
    # 初回起動時: サンプルから data.json を作る。
    # data.json（自分の顧問先データ）はgit管理外なので、教材の更新を取り込んでも書き換わらない
    sample = BASE / "data.sample.json"
    if not DATA_JSON.exists() and sample.exists():
        DATA_JSON.write_text(sample.read_text(encoding="utf-8"), encoding="utf-8")
        print("data.json をサンプルから作成しました（このファイルに自分の顧問先を入れてください）")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"顧問先管理カレンダー: http://localhost:{PORT} で起動しました（Ctrl+Cで終了）")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n終了します")


if __name__ == "__main__":
    main()
