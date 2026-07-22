# -*- coding: utf-8 -*-
"""
体験②：請求書OCR（読み取り）体験版

invoices/ フォルダに置いた請求書PDFを、Claudeに読み取らせて
    取引先名 / 請求日 / 支払期日 / 税込金額 / 内容の要約 /
    勘定科目の候補と理由 / 源泉所得税の対象らしさ
を一覧にします。

そのうえで、あなたが選んだ請求書だけを --register でfreeeに取引登録します。

------------------------------------------------------------------------
使い方
------------------------------------------------------------------------
0) 事前に invoices/ フォルダへ請求書PDFを置いてください（何枚でもOK）。

1) まず読み取るだけ（登録はしない。安全）:
       python scripts/invoice_ocr.py

   → 一覧が表示され、invoice_result.csv も保存されます。

2) 内容を確認して「登録してよい」と思った1枚を登録:
       python scripts/invoice_ocr.py --register --file 請求書A.pdf

------------------------------------------------------------------------
注意
------------------------------------------------------------------------
- OCRの結果（特に金額・日付）は必ず自分の目で確認してから登録してください。
- 勘定科目・源泉の判定はあくまで"候補"です。最終判断は人が行います。
- 税区分は既定で「課税仕入10%（コード136）」で登録します。
"""

import os
import sys
import csv
import json
import base64
import argparse
import glob as globmod

from dotenv import load_dotenv
import anthropic

from freee_auth import get_access_token, freee_get, freee_post

# --- Windowsで日本語が文字化けしないようにする（おまじない）-------------
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

load_dotenv()

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
DEFAULT_TAX_CODE = 136  # 課税仕入10%

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INVOICE_DIR = os.path.join(BASE_DIR, "invoices")
RESULT_CSV = os.path.join(BASE_DIR, "invoice_result.csv")


def list_pdfs() -> list[str]:
    return sorted(globmod.glob(os.path.join(INVOICE_DIR, "*.pdf")))


def read_invoice(client, pdf_path: str) -> dict:
    """1枚の請求書PDFをClaudeに読み取らせ、項目を辞書で返す"""
    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.standard_b64encode(f.read()).decode("utf-8")

    system = (
        "あなたは日本の会計実務に詳しい経理担当者です。"
        "渡された請求書PDFを読み取り、必ず次のJSONだけを返してください"
        "（前後に説明文やコードフェンスは付けない）:\n"
        '{"partner_name":"取引先名","issue_date":"YYYY-MM-DD(請求日)",'
        '"due_date":"YYYY-MM-DD(支払期日。無ければ空文字)",'
        '"amount_incl_tax":整数(税込金額。円。数字のみ),'
        '"summary":"内容の要約(30字以内)",'
        '"account_name":"想定される勘定科目",'
        '"account_reason":"科目の理由(30字以内)",'
        '"withholding_likely":true/false(源泉所得税の対象らしさ)}\n'
        "withholding_likely は、税理士・弁護士・デザイナー・原稿料など"
        "士業や個人への報酬で源泉徴収の対象になりそうな場合に true にしてください。"
    )

    msg = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=600,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": "application/pdf",
                        "data": pdf_b64,
                    },
                },
                {"type": "text", "text": "この請求書を読み取ってJSONで返してください。"},
            ],
        }],
    )
    raw = "".join(block.text for block in msg.content if block.type == "text").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = {}

    # 金額は数字以外が混ざることがあるので整数に整える
    amount = parsed.get("amount_incl_tax", 0)
    if isinstance(amount, str):
        digits = "".join(ch for ch in amount if ch.isdigit())
        amount = int(digits) if digits else 0

    return {
        "file": os.path.basename(pdf_path),
        "partner_name": parsed.get("partner_name", ""),
        "issue_date": parsed.get("issue_date", ""),
        "due_date": parsed.get("due_date", ""),
        "amount": amount,
        "summary": parsed.get("summary", ""),
        "account_name": parsed.get("account_name", ""),
        "account_reason": parsed.get("account_reason", ""),
        "withholding_likely": bool(parsed.get("withholding_likely", False)),
    }


def print_table(rows: list[dict]) -> None:
    print("\n" + "=" * 78)
    print("  請求書の読み取り結果（この段階ではfreeeに登録していません）")
    print("=" * 78)
    for r in rows:
        genzen = "源泉対象の可能性あり" if r["withholding_likely"] else "源泉対象ではなさそう"
        print(f"\n  ファイル : {r['file']}")
        print(f"    取引先 : {r['partner_name']}")
        print(f"    請求日 : {r['issue_date']}    支払期日: {r['due_date'] or '-'}")
        print(f"    税込金額: {r['amount']:>10,}円")
        print(f"    内容   : {r['summary']}")
        print(f"    勘定科目: {r['account_name'] or '-'}（{r['account_reason']}）")
        print(f"    源泉   : {genzen}")
    print("\n" + "-" * 78)
    if rows:
        print("  登録するには、内容を確認のうえ次のように実行します:")
        print(f"    python scripts/invoice_ocr.py --register --file {rows[0]['file']}")
    print("-" * 78)


def write_result_csv(rows: list[dict]) -> None:
    with open(RESULT_CSV, "w", encoding="cp932", newline="", errors="replace") as f:
        w = csv.writer(f)
        w.writerow(["ファイル", "取引先", "請求日", "支払期日", "税込金額",
                    "内容", "勘定科目候補", "科目の理由", "源泉対象らしさ"])
        for r in rows:
            w.writerow([
                r["file"], r["partner_name"], r["issue_date"], r["due_date"],
                r["amount"], r["summary"], r["account_name"], r["account_reason"],
                "対象らしい" if r["withholding_likely"] else "対象外らしい",
            ])
    print(f"\n  結果を保存しました: {RESULT_CSV}")


def build_account_map(token: str, company_id: int) -> dict:
    data = freee_get("/account_items", token, params={"company_id": company_id})
    return {a["name"]: a["id"] for a in data.get("account_items", [])}


def register_invoice(token: str, company_id: int, row: dict) -> None:
    """1枚の請求書をfreeeに取引（未払い＝支出）として登録する"""
    account_map = build_account_map(token, company_id)
    aid = account_map.get(row["account_name"])
    if aid is None:
        print(f"\n  勘定科目「{row['account_name']}」がこの事業所に見つかりません。")
        print("  freeeに実在する勘定科目名を確認して、その名前で登録し直してください。")
        print("  （Claude Codeに「freeeの勘定科目一覧と照らして直して」と頼めば解決できます）")
        return
    if not row["amount"]:
        print("\n  金額が読み取れませんでした。PDFの内容をご確認ください。登録を中止します。")
        return

    issue_date = row["issue_date"] or ""
    if len(issue_date) < 10:
        print("\n  請求日が読み取れませんでした。登録を中止します（日付は手で確認を）。")
        return

    description = f"{row['partner_name']} {row['summary']}".strip()
    body = {
        "company_id": company_id,
        "issue_date": issue_date,
        "type": "expense",
        "details": [
            {
                "account_item_id": aid,
                "tax_code": DEFAULT_TAX_CODE,
                "amount": row["amount"],
                "description": description,
            }
        ],
    }
    resp = freee_post("/deals", token, body)
    deal = resp.get("deal", {})
    print(f"\n  [登録OK] {row['file']} → 取引ID {deal.get('id', '?')}"
          f"（{row['account_name']} / {row['amount']:,}円）")
    if row["withholding_likely"]:
        print("  ※ この請求書は源泉所得税の対象かもしれません。")
        print("     体験版は源泉の自動計算をしません。必要なら畠山先生に確認してください。")


def get_company_id() -> int:
    v = os.environ.get("FREEE_COMPANY_ID", "").strip()
    if not v.isdigit():
        raise SystemExit("FREEE_COMPANY_ID が未設定か数字ではありません。.env を確認してください。")
    return int(v)


def check_anthropic_key() -> None:
    v = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not v or "xxxx" in v.lower():
        raise SystemExit("ANTHROPIC_API_KEY が未設定（またはひな形のまま）です。.env を確認してください。")


def main():
    parser = argparse.ArgumentParser(description="請求書OCR 体験版")
    parser.add_argument("--register", action="store_true", help="指定した請求書をfreeeに登録する")
    parser.add_argument("--file", type=str, default="", help="登録する請求書のファイル名")
    args = parser.parse_args()

    check_anthropic_key()
    pdfs = list_pdfs()
    if not pdfs:
        print(f"invoices/ フォルダにPDFがありません。読み取りたい請求書を置いてください。")
        print(f"  フォルダの場所: {INVOICE_DIR}")
        return

    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY は .env から

    # 登録モードで --file が指定された場合は、その1枚だけ読んで登録
    if args.register and args.file.strip():
        target = os.path.join(INVOICE_DIR, args.file.strip())
        if not os.path.exists(target):
            print(f"指定のファイルが見つかりません: {target}")
            return
        print(f"{args.file} を読み取っています...")
        row = read_invoice(client, target)
        print_table([row])
        token = get_access_token()
        company_id = get_company_id()
        register_invoice(token, company_id, row)
        return

    # 通常モード：全部読み取って一覧表示（登録はしない）
    print(f"{len(pdfs)}件の請求書を読み取っています...")
    rows = []
    for p in pdfs:
        print(f"  読み取り中: {os.path.basename(p)}")
        rows.append(read_invoice(client, p))
    print_table(rows)
    write_result_csv(rows)


if __name__ == "__main__":
    main()
