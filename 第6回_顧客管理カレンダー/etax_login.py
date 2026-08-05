#!/usr/bin/env python3
"""
e-Tax 自動ログインスクリプト
環境変数 ETAX_ID / ETAX_PW を受け取り、Playwright で自動ログインする。
サーバーから subprocess.Popen で起動される（非同期・ファイアアンドフォーゲット）。
"""
import os
import sys
import time

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("playwright が未インストールです: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

ETAX_URL = "https://login.e-tax.nta.go.jp/login/reception/loginIndividual"

# e-Tax ログインフォームのセレクター候補
ID_SELECTORS = [
    'input[name="oStUserId"]',
    'input#oStUserId',
    'input[name="userId"]',
    'input[id="userId"]',
    'input[name="loginId"]',
    'input[id="loginId"]',
    'input[name="riyoushaShikibetsuBangou"]',
    'input[id*="user" i][type="text"]',
    'input[autocomplete="username"]',
]
PW_SELECTORS = [
    'input[name="oStPassword"]',
    'input#oStPassword',
    'input[type="password"]',
    'input[name="password"]',
    'input[id="password"]',
]
SUBMIT_SELECTORS = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("ログイン")',
    'a:has-text("ログイン")',
]


def find_and_fill(page, selectors: list[str], value: str, label: str):
    for sel in selectors:
        try:
            el = page.locator(sel).first
            if el.count() and el.is_visible(timeout=1000):
                # クリックしてフォーカス → 既存値をクリア → 1文字ずつ入力（React対応）
                el.click()
                page.wait_for_timeout(200)
                el.select_text()
                page.wait_for_timeout(100)
                page.keyboard.press("Control+a")
                page.keyboard.press("Delete")
                page.wait_for_timeout(100)
                page.keyboard.type(value, delay=50)
                page.wait_for_timeout(200)
                print(f"  {label}: {sel} に入力完了（keyboard.type）", flush=True)
                return
        except Exception:
            continue
    raise RuntimeError(f"{label} の入力フィールドが見つかりませんでした\n  試したセレクター: {selectors}")


def etax_login(etax_id: str, etax_pw: str):
    # Chromeのデフォルトユーザーデータディレクトリ（本物のプロファイル）を使う。
    # new_context() のクリーンコンテキスト（シークレット相当）だと e-Tax のポップアップが
    # about:blank のまま描画されないため、persistent_context を使用する。
    import pathlib
    # e-Tax 専用のプロファイルディレクトリ（本物の Chrome の User Data とは別）。
    # 本物のプロファイルを使うと、Chrome が起動中のときプロファイルロックで
    # launch_persistent_context がハングしてしまう。専用ディレクトリにすれば
    # Chrome を開いたままでも起動できる。e-Tax は識別番号＋暗証番号のフォーム
    # ログインなので、専用プロファイルでも問題ない（初回以降はこのプロファイルに
    # Cookie 等が永続化される）。
    user_data_dir = str(pathlib.Path.home() / "AppData" / "Local" / "etax-login-profile")
    pathlib.Path(user_data_dir).mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data_dir=user_data_dir,
            channel="chrome",
            headless=False,
            no_viewport=True,
            args=[
                "--start-maximized",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        )
        # navigator.webdriver を隠してbot検知を回避
        ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        # ポップアップはPlaywrightのpersistent contextが自動で処理する（ハンドラ不要）

        # e-Tax はメッセージを開くとき confirm/alert を出すことがある。
        # Playwright はダイアログのハンドラ未登録だと自動 dismiss するため、
        # 「開く」処理が中断されて無反応（フリーズ）に見える。accept して先に進める。
        # どのダイアログが出たかはデバッグログに残し、原因の検証に使う。
        # 注: dialog は Page 単位のイベント。BrowserContext には無いので各 Page に付ける。
        def _on_dialog(dialog):
            try:
                print(f"  [dialog] {dialog.type}: {dialog.message[:80]} → accept", flush=True)
            except Exception:
                pass
            try:
                dialog.accept()
            except Exception:
                pass

        # 新しく開く窓（メッセージ詳細のポップアップ含む）すべてに dialog ハンドラを付け、
        # 前面に出す。ctx.on("page") は new_page() でも発火するので初期ページもここで処理。
        def _on_page(pg):
            try:
                print(f"  [popup] new page: {pg.url}", flush=True)
            except Exception:
                pass
            try:
                pg.on("dialog", _on_dialog)
            except Exception:
                pass
            try:
                pg.bring_to_front()
            except Exception:
                pass
        ctx.on("page", _on_page)

        page = ctx.new_page()

        print(f"e-Tax ログインページへ移動: {ETAX_URL}", flush=True)
        page.goto(ETAX_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1500)
        print(f"  現在URL: {page.url}", flush=True)

        try:
            # 法人タブをクリック（a/button/li など複数タグに対応）
            try:
                hojin_tab = page.locator(':is(a, button, li, [role="tab"]):has-text("法人ログイン")').first
                if hojin_tab.count():
                    hojin_tab.click()
                    page.wait_for_timeout(1500)
                    print(f"  法人ログインタブをクリック。URL: {page.url}", flush=True)
                else:
                    print("  法人タブが見つからず（スキップ）", flush=True)
            except Exception as te:
                print(f"  法人タブクリック失敗: {te}", flush=True)

            # フィールドが表示されるまで待機（利用者識別番号入力欄）
            page.wait_for_selector('input#oStUserId, input[name="oStUserId"], input[name="loginId"]', timeout=8000)
            print("  入力フォーム検出", flush=True)

            find_and_fill(page, ID_SELECTORS, etax_id, "利用者識別番号")
            if etax_pw:
                find_and_fill(page, PW_SELECTORS, etax_pw, "暗証番号")
            else:
                print("  暗証番号は手動で入力してください（自動入力なし）", flush=True)

            # 入力後に少し待つ（React の状態更新を待つ）
            page.wait_for_timeout(500)

            print("入力完了。ログインボタンを押してください。", flush=True)
            print("ブラウザを維持します（最大2時間）", flush=True)
        except Exception as e:
            print(f"自動入力失敗（手動でログインしてください）: {e}", flush=True)
            print("ブラウザを開いたまま維持します（最大2時間）", flush=True)

        # page.on("popup") は ctx.on("page") で集約済みのため不要

        # ブラウザをユーザーが使えるよう維持（最大2時間、subprocess なので server はブロックしない）。
        # 重要: bare time.sleep() だと Playwright の sync API がイベントを
        # ディスパッチせず、dialog ハンドラが発火しない（メッセージを開くと
        # ダイアログが開きっぱなしでフリーズする）。Playwright のメソッドを
        # 定期的に呼んでイベントポンプを回し続けることで dialog/page を捌く。
        deadline = time.time() + 7200
        while time.time() < deadline:
            live = [pg for pg in ctx.pages if not pg.is_closed()]
            if not live:
                print("  全ページが閉じられたため終了", flush=True)
                break
            try:
                live[0].wait_for_timeout(500)
            except Exception:
                # ページが途中で閉じられた等。次ループで生存ページを取り直す
                time.sleep(0.5)


if __name__ == "__main__":
    etax_id = os.environ.get("ETAX_ID", "")
    etax_pw = os.environ.get("ETAX_PW", "")  # 暗証番号は手動入力運用のため任意
    if not etax_id:
        print("環境変数 ETAX_ID が未設定です", file=sys.stderr)
        sys.exit(1)
    try:
        etax_login(etax_id, etax_pw)
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)
