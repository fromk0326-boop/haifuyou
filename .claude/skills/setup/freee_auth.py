# -*- coding: utf-8 -*-
"""
freee認証モジュール（体験版）

freee APIを使うには「アクセストークン」が必要です。
このファイルは、ブラウザでfreeeにログインして許可すると、
トークンを token.json に保存する処理をまとめたものです。

■ 初回の認証（当日一緒にやります）:
    python .claude/skills/setup/freee_auth.py

    → ブラウザが開くので、freeeにログインして「許可する」を押すと
      キットの一番上のフォルダに token.json が作られます。
      以降は auto_keiri.py などが自動で使います。

■ 事業所ID（company_id）の一覧を見たいとき:
    python .claude/skills/setup/freee_auth.py --companies

■ 他のスクリプト（auto_keiri.py / invoice_ocr.py）は、このファイルの
  get_access_token() を呼ぶだけでトークンを受け取れます。
  （期限切れなら自動でリフレッシュ、リフレッシュ不可なら再認証します）

------------------------------------------------------------------------
【重要】freeeアプリ側の「コールバックURL」設定について
------------------------------------------------------------------------
freeeアプリの管理画面で、コールバックURLに次の値を"完全一致"で登録してください:

    http://127.0.0.1:8088/callback

1文字でも違うと認証がエラーになります。README.mdの手順も参照してください。
"""

import os
import sys
import json
import time
import secrets
import webbrowser
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

import requests
from dotenv import load_dotenv

# --- Windowsで日本語が文字化けしないようにする（おまじない）-------------
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

# --- キットの一番上のフォルダ（.env / token.json はここに置きます）-------
# このファイルは .claude/skills/setup/ にあるので、3つ上がキットのルート。
KIT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)

load_dotenv(os.path.join(KIT_ROOT, ".env"))

# --- freeeの固定URL（変更不要）-----------------------------------------
AUTHORIZE_URL = "https://accounts.secure.freee.co.jp/public_api/authorize"
TOKEN_URL = "https://accounts.secure.freee.co.jp/public_api/token"
API_BASE = "https://api.freee.co.jp/api/1"

# --- 認証の受け取り口（freeeアプリのコールバックURLと完全一致させること）---
CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 8088
REDIRECT_URI = f"http://{CALLBACK_HOST}:{CALLBACK_PORT}/callback"

# --- トークンの保存先（キットの一番上のフォルダの token.json）------------
# スキルごとにスクリプトが分かれているので、全スキルが同じ1つのトークンを
# 使えるよう、保存先はキットのルートに固定します。
TOKEN_FILE = os.path.join(KIT_ROOT, "token.json")


def _is_placeholder(v: str) -> bool:
    """未設定、またはひな形（.env.example）の仮の値のままかどうか"""
    return (not v) or v.startswith("あなたの") or ("xxxx" in v.lower())


def _client_id() -> str:
    v = os.environ.get("FREEE_CLIENT_ID", "").strip()
    if _is_placeholder(v):
        raise SystemExit("FREEE_CLIENT_ID が未設定（またはひな形のまま）です。.env を確認してください。")
    return v


def _client_secret() -> str:
    v = os.environ.get("FREEE_CLIENT_SECRET", "").strip()
    if _is_placeholder(v):
        raise SystemExit("FREEE_CLIENT_SECRET が未設定（またはひな形のまま）です。.env を確認してください。")
    return v


class _CallbackHandler(BaseHTTPRequestHandler):
    """ブラウザからのリダイレクトを1回だけ受け取る簡易サーバー"""
    result = {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        params = urllib.parse.parse_qs(parsed.query)
        _CallbackHandler.result = {k: v[0] for k, v in params.items()}
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(
            "<html><body style='font-family:sans-serif'>"
            "<h2>認証が完了しました。</h2>"
            "<p>このタブを閉じて、コマンド画面に戻ってください。</p>"
            "</body></html>".encode("utf-8")
        )

    def log_message(self, *args):
        pass  # サーバーのアクセスログは出さない


def _save_token(data: dict) -> None:
    # 取得時刻を足しておくと、期限切れ判定が楽になる
    data["_obtained_at"] = int(time.time())
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _load_token() -> dict | None:
    if not os.path.exists(TOKEN_FILE):
        return None
    with open(TOKEN_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _exchange_code(code: str) -> dict:
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "code": code,
            "redirect_uri": REDIRECT_URI,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def _refresh_access_token(refresh_token: str) -> dict:
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "client_id": _client_id(),
            "client_secret": _client_secret(),
            "refresh_token": refresh_token,
        },
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def authorize() -> str:
    """ブラウザでの初回認証を行い、アクセストークンを返す"""
    state = secrets.token_urlsafe(32)
    query = urllib.parse.urlencode({
        "client_id": _client_id(),
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "state": state,
    })
    url = f"{AUTHORIZE_URL}?{query}"

    print("ブラウザで認証ページを開きます。freeeにログインして「許可する」を押してください。")
    print("（自動で開かない場合は、次のURLを手動でブラウザに貼ってください）")
    print(url)

    server = HTTPServer((CALLBACK_HOST, CALLBACK_PORT), _CallbackHandler)
    webbrowser.open(url)
    server.handle_request()  # コールバックを1回だけ受け取る
    server.server_close()

    result = _CallbackHandler.result
    if result.get("state") != state:
        raise SystemExit("認証エラー: stateが一致しません。もう一度やり直してください。")
    if "code" not in result:
        raise SystemExit(f"認証エラー: 認可コードを受け取れませんでした。応答={result}")

    token_data = _exchange_code(result["code"])
    _save_token(token_data)
    print("認証に成功しました。token.json を保存しました。")
    return token_data["access_token"]


def get_access_token() -> str:
    """
    有効なアクセストークンを返す。
    1) token.json があればリフレッシュを試す
    2) だめなら（または無ければ）ブラウザ認証をやり直す
    """
    token = _load_token()
    if token and token.get("refresh_token"):
        try:
            new_token = _refresh_access_token(token["refresh_token"])
            _save_token(new_token)
            return new_token["access_token"]
        except requests.HTTPError:
            print("トークンの更新に失敗しました。再認証します。")
    return authorize()


# --- freee APIを呼ぶための小さな共通関数（他スクリプトからも使う）--------
def freee_get(path: str, token: str, params: dict | None = None) -> dict:
    resp = requests.get(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {token}"},
        params=params or {},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()


def freee_post(path: str, token: str, body: dict) -> dict:
    resp = requests.post(
        f"{API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=60,
    )
    # エラー時はfreeeの返すメッセージも見せる（原因が分かりやすい）
    if resp.status_code >= 400:
        raise SystemExit(f"freee APIエラー ({resp.status_code}): {resp.text}")
    return resp.json()


if __name__ == "__main__":
    if "--companies" in sys.argv:
        # 事業所ID（company_id）の一覧を表示する
        tok = get_access_token()
        data = freee_get("/companies", tok)
        print("== 使える事業所の一覧 ==")
        for c in data.get("companies", []):
            print(f"  company_id={c['id']}  {c.get('display_name', '')}")
        print("↑ このうち、練習で使う事業所のIDを .env の FREEE_COMPANY_ID に設定してください。")
    else:
        # 初回認証（token.json を作る）
        get_access_token()
        print("準備OKです。次は auto_keiri.py を試してみましょう。")
