#!/usr/bin/env python3
"""
eLTAX PCdesk(web版) 自動ログインスクリプト
環境変数 ELTAX_ID / ELTAX_PW を受け取り、Playwright で自動ログインする。
サーバーから subprocess.Popen で起動される（非同期・ファイアアンドフォーゲット）。
"""
import os
import sys
import time

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("playwright が未インストールです: pip install playwright && playwright install chromium", file=sys.stderr)
    sys.exit(1)

ELTAX_URL = "https://www.portal.eltax.lta.go.jp/apa/web/webindexb#eLTAX"

# PCdesk(WEB) ログイン画面の実フィールドは #sUserId / #sPwd（2026-07-03 実DOM確認）
ID_SELECTORS = [
    'input#sUserId',
    'input[name="sUserId"]',
    'input[name="userId"]',
    'input[name="loginId"]',
    'input[type="text"]',
]
PW_SELECTORS = [
    'input#sPwd',
    'input[name="sPwd"]',
    'input[type="password"]',
    'input[name="password"]',
]
SUBMIT_SELECTORS = [
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("ログイン")',
    'a:has-text("ログイン")',
]


def close_setup_dialog(page):
    """初回表示される「ログイン等セットアップ」案内ダイアログ（jQuery UI）を閉じる。
    このダイアログが画面を覆っていると click ベースの入力がタイムアウトする。"""
    try:
        close_btn = page.locator('.ui-dialog:visible .ui-dialog-titlebar-close').first
        if close_btn.count():
            close_btn.click(timeout=3000)
            page.wait_for_timeout(300)
            print("  セットアップ案内ダイアログを閉じました", flush=True)
    except Exception as e:
        print(f"  ダイアログを閉じられず（続行）: {e}", flush=True)


def find_and_fill(page, selectors, value, label):
    for sel in selectors:
        try:
            el = page.locator(sel).first
            if not (el.count() and el.is_visible(timeout=1000)):
                continue
            # fill はダイアログに覆われていても入力できる。失敗時のみ click+type にフォールバック
            try:
                el.fill(value, timeout=5000)
            except Exception:
                el.click(timeout=5000)
                page.keyboard.press("Control+a")
                page.keyboard.press("Delete")
                page.keyboard.type(value, delay=50)
            page.wait_for_timeout(200)
            actual = el.input_value()
            if actual == value:
                print(f"  {label}: {sel} に入力完了", flush=True)
            else:
                print(f"  {label}: {sel} に入力したが値が不一致（入力後: {len(actual)}文字 / 期待: {len(value)}文字）", flush=True)
            return
        except Exception:
            continue
    raise RuntimeError(f"{label} の入力フィールドが見つかりませんでした\n  試したセレクター: {selectors}")


def eltax_login(eltax_id: str, eltax_pw: str):
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            channel="chrome",
            args=[
                "--start-maximized",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        ctx = browser.new_context(
            no_viewport=True,
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        )
        ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = ctx.new_page()

        print(f"eLTAX PCdesk ログインページへ移動: {ELTAX_URL}", flush=True)
        page.goto(ELTAX_URL, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(2000)
        print(f"  現在URL: {page.url}", flush=True)

        try:
            # ログインフォーム（#sUserId）が現れるまで待機
            page.wait_for_selector('input#sUserId, input[type="text"]', timeout=10000)
            print("  入力フォーム検出", flush=True)

            close_setup_dialog(page)

            find_and_fill(page, ID_SELECTORS, eltax_id, "利用者ID")
            if eltax_pw:
                find_and_fill(page, PW_SELECTORS, eltax_pw, "パスワード")
            else:
                print("  パスワードは手動で入力してください（自動入力なし）", flush=True)

            page.wait_for_timeout(500)
            print("入力完了。ログインボタンを押してください。", flush=True)
            print("ブラウザを維持します（最大2時間）", flush=True)

        except Exception as e:
            print(f"自動入力失敗（手動でログインしてください）: {e}", flush=True)
            print("ブラウザを開いたまま維持します（最大2時間）", flush=True)

        time.sleep(7200)


def normalize_id(raw: str) -> str:
    """全角英数→半角に変換し、空白を除去（利用者IDは半角11桁・maxlength=11のため）"""
    s = raw.translate(str.maketrans(
        "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ",
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    ))
    return "".join(s.split())


if __name__ == "__main__":
    eltax_id = normalize_id(os.environ.get("ELTAX_ID", ""))
    eltax_pw = os.environ.get("ELTAX_PW", "")  # パスワードは手動入力運用のため任意
    if not eltax_id:
        print("環境変数 ELTAX_ID が未設定です", file=sys.stderr)
        sys.exit(1)
    try:
        eltax_login(eltax_id, eltax_pw)
    except Exception as e:
        print(f"エラー: {e}", file=sys.stderr)
        sys.exit(1)
