# -*- coding: utf-8 -*-
"""
体験①：freeeオート経理（自動記帳）体験版

freeeの「自動で経理」に溜まった未処理の出金明細を、
    第1段階：手元のルール表（rules.csv）でキーワード判定 → 一致すれば科目確定
    第2段階：ルールで判定できなかった明細だけClaude（Haiku）に判定させる
という2段階で仕分けし、結果を一覧表示します。
（畠山の事務所で動いている本物のスクリプトと同じ構成です）

そのうえで、あなたが「これはOK」と選んだ明細だけを、
--register モードでfreeeに取引登録します（承認してから登録＝暴発しない設計）。

------------------------------------------------------------------------
使い方
------------------------------------------------------------------------
1) まず中身を見るだけ（登録はしない。安全）:
       python scripts/auto_keiri.py
       python scripts/auto_keiri.py --limit 3      # 取ってくる件数を変える（初期値5件）

   → 画面に一覧が出て、result.csv も保存されます。
     各行の先頭に「明細ID」が付きます。

2) 一覧を見て「登録してよい」と判断した明細だけ登録:
       python scripts/auto_keiri.py --register --ids 123,456

   → 指定したIDのうち「登録候補」になっているものだけ、freeeに取引登録します。

------------------------------------------------------------------------
安全のための決めごと（体験版）
------------------------------------------------------------------------
- 取ってくるのは未処理の"出金"明細だけ。しかも初期値5件まで。
- どの明細も勝手には登録しない。必ず 判定 → あなたの承認 → 登録 の順。
- 給与や「請求書の支払い（既存取引の決済）」っぽい明細は自動では登録せず、
  「要確認」に回します。
- freeeには"消込"を自動で行うAPIがありません。この体験版でも消込はしません。
  → 登録後、freeeの「自動で経理」画面に元の明細が"未処理のまま"残ります。
     その明細は画面で「無視」にするか、手動で取引に紐づけてください（README参照）。
"""

import os
import sys
import csv
import json
import argparse

from dotenv import load_dotenv
import anthropic

from freee_auth import get_access_token, freee_get, freee_post

# --- Windowsで日本語が文字化けしないようにする（おまじない）-------------
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

load_dotenv()

# Claudeのモデル（速くて安いHaikuを使います）
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

# freeeの税区分コード（136 = 課税仕入10%）。体験版はこれを既定にします。
DEFAULT_TAX_CODE = 136

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RULES_CSV = os.path.join(BASE_DIR, "rules.csv")
RESULT_CSV = os.path.join(BASE_DIR, "result.csv")

# 給与・借入・税金など「経費として登録してはいけない」明細を弾くキーワード
SKIP_KEYWORDS = [
    # 給与・役員報酬
    "給与", "給料", "賞与", "ボーナス", "役員報酬", "SALARY",
    # 借入・返済
    "借入", "返済", "ローン", "元金", "利息", "融資", "公庫", "信用金庫",
    # 税金・社会保険
    "年金", "健保", "健康保険", "厚生年金", "労働保険", "雇用保険", "社会保険",
    "源泉所得税", "源泉税", "住民税", "法人税", "消費税", "事業税", "固定資産税",
    "予定納税", "国税", "都税", "県税", "市税", "納付", "自動車税",
]


def load_rules() -> list[dict]:
    """rules.csv を読み込む。Excelで開いても壊れないよう cp932 で読む。"""
    rules = []
    with open(RULES_CSV, "r", encoding="cp932", errors="replace") as f:
        reader = csv.DictReader(f)
        for row in reader:
            account = (row.get("勘定科目") or "").strip()
            kw_field = (row.get("キーワード（;区切りで複数可）") or "").strip()
            tax_raw = (row.get("税区分コード") or "").strip()
            if not account or not kw_field:
                continue
            keywords = [k.strip() for k in kw_field.split(";") if k.strip()]
            try:
                tax_code = int(tax_raw)
            except ValueError:
                tax_code = DEFAULT_TAX_CODE
            rules.append({"account": account, "keywords": keywords, "tax_code": tax_code})
    return rules


def match_rule(description: str, rules: list[dict]) -> dict | None:
    """第1段階：摘要にキーワードが含まれる最初のルールを返す（無ければNone）"""
    text = (description or "").upper()
    for rule in rules:
        for kw in rule["keywords"]:
            if kw.upper() in text:
                return rule
    return None


def hits_skip_keyword(description: str) -> str | None:
    """給与・借入・税金など、登録してはいけない明細ならその理由キーワードを返す"""
    text = (description or "")
    upper = text.upper()
    for kw in SKIP_KEYWORDS:
        if kw.upper() in upper:
            return kw
    return None


def fetch_unprocessed_expenses(token: str, company_id: int, limit: int) -> list[dict]:
    """
    未処理（status=1）の"出金"（entry_side=expense）明細を limit 件まで取得。
    freeeの wallet_txns（明細）APIを使う。
    """
    data = freee_get(
        "/wallet_txns",
        token,
        params={"company_id": company_id, "status": 1, "limit": 100},
    )
    txns = data.get("wallet_txns", [])
    expenses = [
        t for t in txns
        if t.get("status") == 1 and t.get("entry_side") == "expense"
    ]
    return expenses[:limit]


def classify_with_claude(client, description: str, amount: int) -> dict:
    """
    第2段階：ルールで判定できなかった明細だけをClaudeに判定してもらう。
    （本物と同じ構成。ルール一致分はAIを通さないので、速くて安い）
    - ふさわしい勘定科目の候補と理由
    - 給与や請求書の決済っぽくないか（looks_like_settlement）
    戻り値: {"account_name","confidence","reason","looks_like_settlement"}
    """
    rule_hint = "手元のキーワードルールに該当しませんでした。ふさわしい勘定科目を提案してください。"
    system = (
        "あなたは日本の会計実務に詳しい経理担当者です。"
        "freeeの出金明細1件について、勘定科目を判定します。"
        "必ず次のJSONだけを返してください（前後に説明文やコードフェンスは付けない）:\n"
        '{"account_name":"勘定科目名","confidence":"high|medium|low",'
        '"reason":"判断理由(40字以内)","looks_like_settlement":true/false}\n'
        "looks_like_settlement は、この明細が『給与の支払い』または"
        "『既存の請求書・未払金の決済（振込）』のように見える場合に true にしてください。"
        "通常の経費の購入・カード決済なら false です。"
    )
    user = f"摘要: {description}\n金額: {amount}円\n{rule_hint}"

    msg = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=300,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    raw = "".join(block.text for block in msg.content if block.type == "text").strip()

    # 念のためコードフェンスが付いていたら剥がす
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {
            "account_name": "",
            "confidence": "low",
            "reason": "Claudeの応答を解釈できませんでした",
            "looks_like_settlement": False,
        }
    return {
        "account_name": parsed.get("account_name", ""),
        "confidence": (parsed.get("confidence") or "low").lower(),
        "reason": parsed.get("reason", ""),
        "looks_like_settlement": bool(parsed.get("looks_like_settlement", False)),
    }


def classify_all(txns: list[dict], rules: list[dict], client) -> list[dict]:
    """全明細を2段階（ルール → ルール外だけAI）で仕分けし、判定結果の行リストを返す"""
    results = []
    for t in txns:
        desc = t.get("description", "")
        amount = t.get("amount", 0)

        # まず「登録してはいけない」明細を弾く（AIにも投げない）
        skip_kw = hits_skip_keyword(desc)
        if skip_kw:
            results.append({
                "id": t.get("id"),
                "date": t.get("date", ""),
                "amount": amount,
                "description": desc,
                "verdict": "要確認（スキップ）",
                "account": "",
                "tax_code": DEFAULT_TAX_CODE,
                "source": "-",
                "confidence": "-",
                "reason": f"「{skip_kw}」を含む（給与/借入/税金など）",
            })
            continue

        # 第1段階：キーワードルール。一致したらここで科目確定（AIは呼ばない＝本物と同じ）
        rule = match_rule(desc, rules)
        if rule:
            results.append({
                "id": t.get("id"),
                "date": t.get("date", ""),
                "amount": amount,
                "description": desc,
                "verdict": "登録候補",
                "account": rule["account"],
                "tax_code": rule["tax_code"],
                "source": "ルール",
                "confidence": "-",
                "reason": f"ルール表のキーワードに一致（{rule['account']}）",
            })
            continue

        # 第2段階：ルールで決まらなかった明細だけClaudeに判定させる
        ai = classify_with_claude(client, desc, amount)
        account = ai["account_name"] or ""

        if ai["looks_like_settlement"]:
            verdict = "要確認（スキップ）"
            reason = "給与・請求書の決済の可能性。手動で確認を"
        elif ai["confidence"] == "low" or not account:
            verdict = "要確認"
            reason = ai["reason"] or "確信度が低い"
        else:
            verdict = "登録候補"
            reason = ai["reason"]

        results.append({
            "id": t.get("id"),
            "date": t.get("date", ""),
            "amount": amount,
            "description": desc,
            "verdict": verdict,
            "account": account,
            "tax_code": DEFAULT_TAX_CODE,
            "source": "AI",
            "confidence": ai["confidence"],
            "reason": reason,
        })
    return results


def print_table(results: list[dict]) -> None:
    print("\n" + "=" * 78)
    print("  判定結果（この段階ではfreeeに登録していません）")
    print("=" * 78)
    for r in results:
        print(f"\n  明細ID: {r['id']}   {r['date']}   {r['amount']:>10,}円")
        print(f"    摘要   : {r['description']}")
        print(f"    判定   : {r['verdict']}   勘定科目: {r['account'] or '-'}"
              f"（税区分{r['tax_code']} / 判定元:{r['source']} / 確信度:{r['confidence']}）")
        print(f"    理由   : {r['reason']}")
    print("\n" + "-" * 78)
    ids = [str(r["id"]) for r in results if r["verdict"] == "登録候補"]
    if ids:
        print("  登録候補の明細を登録するには、次のように実行します:")
        print(f"    python scripts/auto_keiri.py --register --ids {','.join(ids)}")
    else:
        print("  今回は「登録候補」がありませんでした。")
    print("-" * 78)


def write_result_csv(results: list[dict]) -> None:
    """結果を result.csv（cp932）に保存。Excelでそのまま開けます。"""
    with open(RESULT_CSV, "w", encoding="cp932", newline="", errors="replace") as f:
        w = csv.writer(f)
        w.writerow(["明細ID", "日付", "金額", "摘要", "判定", "勘定科目", "税区分", "判定元", "確信度", "理由"])
        for r in results:
            w.writerow([
                r["id"], r["date"], r["amount"], r["description"],
                r["verdict"], r["account"], r["tax_code"], r["source"], r["confidence"], r["reason"],
            ])
    print(f"\n  結果を保存しました: {RESULT_CSV}")


def build_account_map(token: str, company_id: int) -> dict:
    """勘定科目名 → freeeの勘定科目ID の対応表を作る"""
    data = freee_get("/account_items", token, params={"company_id": company_id})
    return {a["name"]: a["id"] for a in data.get("account_items", [])}


def register_selected(token: str, company_id: int, results: list[dict], target_ids: set[int]) -> None:
    """承認された（--idsで指定された）『登録候補』だけをfreeeに取引登録する"""
    account_map = build_account_map(token, company_id)

    to_register = [
        r for r in results
        if r["id"] in target_ids and r["verdict"] == "登録候補"
    ]
    if not to_register:
        print("\n  指定されたIDの中に『登録候補』がありませんでした。登録は行いません。")
        return

    print("\n  次の明細をfreeeに取引登録します:")
    registered = 0
    for r in to_register:
        aid = account_map.get(r["account"])
        if aid is None:
            print(f"    [スキップ] 明細ID {r['id']}: 勘定科目「{r['account']}」が"
                  f"この事業所に見つかりません（freeeで科目名をご確認ください）")
            continue

        body = {
            "company_id": company_id,
            "issue_date": r["date"],       # 例: "2026-07-01"
            "type": "expense",             # 出金（支出）
            "details": [
                {
                    "account_item_id": aid,
                    "tax_code": r["tax_code"],
                    "amount": r["amount"],
                    "description": r["description"],
                }
            ],
        }
        resp = freee_post("/deals", token, body)
        deal = resp.get("deal", {})
        print(f"    [登録OK] 明細ID {r['id']} → 取引ID {deal.get('id', '?')}"
              f"（{r['account']} / {r['amount']:,}円）")
        registered += 1

    print(f"\n  登録が完了しました（{registered}件）。")
    print("  " + "!" * 60)
    print("  【重要】freeeの『自動で経理』画面には、いま登録した明細が")
    print("          "'"未処理のまま"'"残っています（この体験版は消込をしません）。")
    print("          freee画面で該当明細を『無視』にするか、手動で今の取引に")
    print("          紐づけてください。放置すると二重計上の原因になります。")
    print("  " + "!" * 60)


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
    parser = argparse.ArgumentParser(description="freeeオート経理 体験版")
    parser.add_argument("--limit", type=int, default=5, help="取得する明細の件数（初期値5）")
    parser.add_argument("--register", action="store_true", help="承認した明細をfreeeに登録する")
    parser.add_argument("--ids", type=str, default="", help="登録する明細ID（カンマ区切り）")
    args = parser.parse_args()

    check_anthropic_key()
    token = get_access_token()
    company_id = get_company_id()
    rules = load_rules()
    client = anthropic.Anthropic()  # ANTHROPIC_API_KEY は .env から読まれます

    print(f"事業所ID {company_id} の未処理・出金明細を最大{args.limit}件取得します...")
    txns = fetch_unprocessed_expenses(token, company_id, args.limit)
    if not txns:
        print("未処理の出金明細はありませんでした。（すべて処理済みかもしれません）")
        return

    results = classify_all(txns, rules, client)
    print_table(results)
    write_result_csv(results)

    if args.register:
        if not args.ids.strip():
            print("\n  --register には --ids で明細IDの指定が必要です。")
            print("  例: python scripts/auto_keiri.py --register --ids 123,456")
            return
        target_ids = set()
        for part in args.ids.split(","):
            part = part.strip()
            if part.isdigit():
                target_ids.add(int(part))
        register_selected(token, company_id, results, target_ids)


if __name__ == "__main__":
    main()
