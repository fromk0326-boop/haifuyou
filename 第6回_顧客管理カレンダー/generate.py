#!/usr/bin/env python3
"""
client-calendar generate.py
Notion APIから顧問先データを直接取得してdata.jsonと個別HTMLを更新する。
index.htmlは手動管理のため生成しない。

使い方:
  $env:NOTION_TOKEN="secret_xxx"
  python generate.py
"""

import json
import os
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import defaultdict

# ---- 設定 ----
BASE_DIR = Path(__file__).parent
DATA_JSON = BASE_DIR / "data.json"
CLIENTS_DIR = BASE_DIR / "clients"
MEETINGS_JSON = BASE_DIR / "meetings.json"
MEETINGS_CACHE_JSON = BASE_DIR / "meetings-cache.json"

NOTION_DB_ID = os.environ.get("NOTION_DB_ID", "")  # 顧問先DB（.env か環境変数で設定）
MEETING_DB_ID = os.environ.get("NOTION_MEETING_DB_ID", "")  # ミーティング議事録DB（任意）


# ---- Notion API ----

def notion_query(database_id: str, start_cursor=None) -> dict:
    token = os.environ.get("NOTION_TOKEN")
    if not token:
        raise RuntimeError("NOTION_TOKEN 環境変数が未設定です。$env:NOTION_TOKEN='secret_xxx' を設定してください")
    url = f"https://api.notion.com/v1/databases/{database_id}/query"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
    }
    body = {"page_size": 100}
    if start_cursor:
        body["start_cursor"] = start_cursor
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Notion API エラー {e.code}: {e.read().decode()}")


def fetch_all_pages(database_id: str) -> list:
    all_results, cursor, page_num = [], None, 1
    while True:
        print(f"  取得中... {page_num}ページ目 ({len(all_results)} 件)", end="\r")
        result = notion_query(database_id, cursor)
        all_results.extend(result.get("results", []))
        if result.get("has_more"):
            cursor, page_num = result.get("next_cursor"), page_num + 1
        else:
            break
    print(f"  Notion取得完了: {len(all_results)} 件 (raw)          ")
    return all_results


CONSUL_KEYWORDS = ["コンサル", "顧問", "アドバイザー", "advisor"]

def extract_clients_from_notion(pages: list) -> list:
    """Notionページリストからclientsリストを抽出"""
    clients = []
    skipped_archived = 0
    skipped_no_name = []
    for page in pages:
        props = page.get("properties", {})

        # アーカイブ済みはスキップ
        if props.get("アーカイブ", {}).get("checkbox", False):
            skipped_archived += 1
            continue

        # name (略称 -> 正式 fallback)
        title_items = props.get("略称", {}).get("title", [])
        name = "".join([t.get("plain_text", "") for t in title_items]).strip() if title_items else ""

        formal_name_items = props.get("正式", {}).get("rich_text", [])
        formal_name = "".join([t.get("plain_text", "") for t in formal_name_items]) if formal_name_items else None

        if not name and formal_name:
            name = formal_name.strip()
        if not name:
            skipped_no_name.append(page["id"])
            continue  # 名前が空はスキップ

        # fiscal_month
        kessan = props.get("決算", {}).get("date")
        fiscal_month = None
        if kessan and kessan.get("start"):
            fiscal_month = datetime.strptime(kessan["start"][:10], "%Y-%m-%d").month

        # category（区分フィールド優先、名前にコンサル系キーワードがあれば上書き）
        kubun = props.get("区分", {}).get("select")
        category = kubun.get("name") if kubun else None
        if any(kw in name for kw in CONSUL_KEYWORDS):
            category = "コンサル"

        # status
        st = props.get("ステータス", {}).get("status")
        status = st.get("name") if st else None

        # annual_fee
        annual_fee = props.get("年額", {}).get("number")

        # software
        soft = props.get("ソフト", {}).get("select")
        software = soft.get("name") if soft else None

        # address
        addr_items = props.get("法人住所", {}).get("rich_text", [])
        address = "".join([t.get("plain_text", "") for t in addr_items]) if addr_items else None

        # 代表者名
        rep_items = props.get("代表者", {}).get("rich_text", [])
        representative = "".join([t.get("plain_text", "") for t in rep_items]).strip() if rep_items else None

        # e-Tax 利用者識別番号（暗証番号はセキュリティのため data.json に含めない）
        etax_prop = props.get("🚀利用者", {})
        etax_items = etax_prop.get("rich_text", []) or etax_prop.get("title", [])
        etax_id = "".join([t.get("plain_text", "") for t in etax_items]).strip() if etax_items else None

        # 納税用確認番号
        taxnote_items = props.get("納税用確認番号", {}).get("rich_text", [])
        taxnote_id = "".join([t.get("plain_text", "") for t in taxnote_items]).strip() if taxnote_items else None

        # eLTAX 利用者ID（パスワードはセキュリティのため data.json に含めない）
        eltax_prop = props.get("✊ID", {})
        eltax_items = eltax_prop.get("rich_text", []) or eltax_prop.get("title", [])
        eltax_id = "".join([t.get("plain_text", "") for t in eltax_items]).strip() if eltax_items else None

        clients.append({
            "id": page["id"],
            "name": name,
            "formal_name": formal_name if formal_name else None,
            "fiscal_month": fiscal_month,
            "category": category,
            "status": status,
            "annual_fee": annual_fee,
            "software": software,
            "address": address if address else None,
            "representative": representative if representative else None,
            "etax_id": etax_id if etax_id else None,
            "taxnote_id": taxnote_id if taxnote_id else None,
            "eltax_id": eltax_id if eltax_id else None,
            "tasks": [],
        })

    if skipped_archived:
        print(f"  スキップ(アーカイブ済み): {skipped_archived} 件")
    if skipped_no_name:
        print(f"  スキップ(名前なし): {len(skipped_no_name)} 件 → ID: {skipped_no_name}")

    by_cat = defaultdict(list)
    for c in clients:
        by_cat[c["category"] or "(未設定)"].append(c["name"])
    for cat, names in sorted(by_cat.items()):
        print(f"  [{cat}] {len(names)}件: {names}")

    return clients



# ---- STEP2: 定期税務タスク生成 ----

TASK_DEFS = [
    # (title, type, color, months_fn)
    # months_fn(M) -> list of months (1-12)
    ("決算期", "kessan_mark", "#1a56db", lambda m: [m] if m else []),
    ("申告（法人税・地方税・消費税）", "kessan", "#93c5fd", lambda m: [(m + 1) % 12 + 1] if m else []),
    ("予定納税（中間申告）", "yotei", "#16a34a", lambda m: [(m + 5) % 12 + 1] if m else []),
    ("源泉所得税納付", "gensen", "#fb923c", lambda m: [1, 7]),
    ("年末調整", "nencho", "purple", lambda m: [12]),
]

# 決算月なし顧問先は源泉+年末のみ
TASK_DEFS_NO_FISCAL = [
    ("源泉所得税納付", "gensen", "orange", lambda m: [1, 7]),
    ("年末調整", "nencho", "purple", lambda m: [12]),
]


def generate_tasks(clients: list) -> tuple[list, int]:
    """定期タスクを生成して clients に設定、生成件数を返す"""
    total_tasks = 0

    def make_task(client_id, title, task_type, color, month):
        # IDを決定論的に固定 → 再生成後もlocalStorageのステータスが有効
        t_id = f"{client_id[:8]}-{task_type}-{month}"
        return {
            "id": t_id,
            "title": title,
            "month": month,
            "type": task_type,
            "color": color,
            "status": "todo",
            "note": "",
        }

    for client in clients:
        m = client.get("fiscal_month")
        defs = TASK_DEFS if m else TASK_DEFS_NO_FISCAL

        # 既存のスポットタスクを保持（手動追加分を上書きしない）
        existing_spots = [t for t in client.get("tasks", []) if t.get("type") == "spot"]

        tasks = []
        for title, task_type, color, months_fn in defs:
            months = months_fn(m)
            for month in months:
                tasks.append(make_task(client["id"], title, task_type, color, month))

        tasks.extend(existing_spots)
        client["tasks"] = tasks
        total_tasks += len(tasks)

    return clients, total_tasks


# ---- STEP2.5: 議事録同期 ----

MEETING_BLOCK_TYPE_SHORT = {
    "heading_3": "h",
    "to_do": "todo",
    "bulleted_list_item": "li",
    "numbered_list_item": "li",
    "paragraph": "p",
}


def notion_get_block_children(block_id: str, start_cursor=None) -> dict:
    token = os.environ.get("NOTION_TOKEN")
    if not token:
        raise RuntimeError("NOTION_TOKEN 環境変数が未設定です。$env:NOTION_TOKEN='secret_xxx' を設定してください")
    url = f"https://api.notion.com/v1/blocks/{block_id}/children?page_size=100"
    if start_cursor:
        url += f"&start_cursor={start_cursor}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": "2022-06-28",
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Notion API エラー {e.code}: {e.read().decode()}")


def fetch_block_children_all(block_id: str) -> list:
    """ブロック配下の子ブロックを全件取得（ページネーション対応）"""
    all_results, cursor = [], None
    while True:
        result = notion_get_block_children(block_id, cursor)
        time.sleep(0.35)  # Notionレート制限(3req/s)対策
        all_results.extend(result.get("results", []))
        if result.get("has_more"):
            cursor = result.get("next_cursor")
        else:
            break
    return all_results


def parse_notion_datetime(iso_str):
    if not iso_str:
        return None
    s = iso_str.replace("Z", "+00:00")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def extract_meeting_title(props: dict) -> str:
    """「名前」titleのtext部分のみを連結（日付mentionは除く）"""
    title_items = props.get("名前", {}).get("title", [])
    parts = [t.get("plain_text", "") for t in title_items if t.get("type") == "text"]
    title = "".join(parts).strip()
    return title if title else "（無題ミーティング）"


def extract_meeting_date(props: dict, page: dict) -> tuple:
    """タイトル中の日付mentionを優先、無ければcreated_time。ISO文字列とJST表示用文字列を返す"""
    title_items = props.get("名前", {}).get("title", [])
    date_iso = None
    for t in title_items:
        if t.get("type") == "mention":
            mention = t.get("mention", {})
            if mention.get("type") == "date":
                d = mention.get("date", {})
                if d.get("start"):
                    date_iso = d["start"]
                    break
    if not date_iso:
        date_iso = page.get("created_time")

    dt = parse_notion_datetime(date_iso)
    if dt:
        dt_jst = dt.astimezone(timezone(timedelta(hours=9)))
        date_display = dt_jst.strftime("%Y-%m-%d %H:%M")
    else:
        date_display = date_iso or ""
    return date_iso, date_display


def blocks_to_summary(blocks: list) -> list:
    """要約ブロック配列を {"t":..., "text":...} のリストへ構造化"""
    result = []
    for b in blocks:
        btype = b.get("type")
        short = MEETING_BLOCK_TYPE_SHORT.get(btype)
        if not short:
            continue
        rich = b.get(btype, {}).get("rich_text", [])
        text = "".join([t.get("plain_text", "") for t in rich]).strip()
        if not text:
            continue
        result.append({"t": short, "text": text})
    return result


def fetch_meeting_summary(page_id: str) -> list:
    """ページ直下のtranscriptionブロック→summary_block_idの子ブロックを要約として取得"""
    try:
        children = fetch_block_children_all(page_id)
    except Exception as e:
        print(f"  [WARN] ページ本文取得失敗 ({page_id}): {e}")
        return []

    transcription_block = None
    for b in children:
        if b.get("type") == "transcription":
            transcription_block = b
            break
    if not transcription_block:
        return []

    summary_block_id = transcription_block.get("transcription", {}).get("children", {}).get("summary_block_id")
    if not summary_block_id:
        return []

    try:
        summary_blocks = fetch_block_children_all(summary_block_id)
    except Exception as e:
        print(f"  [WARN] summaryブロック取得失敗 ({page_id}): {e}")
        return []

    return blocks_to_summary(summary_blocks)


def title_contains_name(title: str, name: str) -> bool:
    """タイトルに顧問先名が含まれるか。
    英数字のみの名前は大文字小文字を無視しつつ、前後が英数字なら不一致扱い
    （例: 「Satsuki」に「SAT」が部分一致するのを防ぐ）。日本語名は単純部分一致。"""
    if name.isascii():
        title_lower, name_lower = title.lower(), name.lower()
        start = 0
        while True:
            i = title_lower.find(name_lower, start)
            if i < 0:
                return False
            before = title_lower[i - 1] if i > 0 else ""
            after = title_lower[i + len(name_lower)] if i + len(name_lower) < len(title_lower) else ""
            if not (before.isascii() and before.isalnum()) and not (after.isascii() and after.isalnum()):
                return True
            start = i + 1
    return name in title


def sync_meetings(clients: list) -> dict:
    """Notionミーティング議事録DBを顧問先に紐づけてmeetings.jsonの内容を生成"""
    print("[STEP2.5] 議事録同期中...")

    if not MEETING_DB_ID:
        print("[STEP2.5] NOTION_MEETING_DB_ID 未設定のため議事録同期をスキップします")
        return {"generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"), "meetings": {}}

    try:
        pages = fetch_all_pages(MEETING_DB_ID)
    except (RuntimeError, urllib.error.URLError) as e:
        print(f"[WARN] ミーティングDBにアクセスできません（インテグレーション未共有の可能性）。議事録同期をスキップします: {e}")
        if MEETINGS_JSON.exists():
            print("[STEP2.5] 既存の meetings.json をそのまま使用します")
            try:
                return json.loads(MEETINGS_JSON.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {"generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"), "meetings": {}}

    client_by_id = {c["id"]: c for c in clients}

    # タイトルフォールバック用の候補（2文字未満の名前は誤マッチ防止のため除外）
    # 英語の一般単語と同名の顧問先（and等）はカレンダー自動タイトル「X and Y」に誤マッチするため除外
    exclude_words = {"and", "the", "with", "for", "meet", "mtg"}
    name_candidates = []
    for c in clients:
        for key in ("name", "formal_name"):
            v = c.get(key)
            if v and len(v) >= 2 and v.lower() not in exclude_words:
                name_candidates.append((c["id"], v))

    cache = {}
    if MEETINGS_CACHE_JSON.exists():
        try:
            cache = json.loads(MEETINGS_CACHE_JSON.read_text(encoding="utf-8"))
        except Exception:
            cache = {}

    meetings_by_client = defaultdict(list)
    matched_relation = 0
    matched_title = 0
    unmatched = 0
    api_fetched = 0
    cache_reused = 0

    for page in pages:
        props = page.get("properties", {})
        title = extract_meeting_title(props)
        date_iso, date_display = extract_meeting_date(props, page)
        relation_ids = [r["id"] for r in props.get("顧問先", {}).get("relation", [])]

        matched_client_ids = []
        matched_by = None
        if relation_ids:
            matched_client_ids = [cid for cid in relation_ids if cid in client_by_id]
            if matched_client_ids:
                matched_by = "relation"
        else:
            # relationが空の場合のみタイトル一致でフォールバック（ちょうど1社のときだけ）
            found = set()
            for cid, name in name_candidates:
                if title_contains_name(title, name):
                    found.add(cid)
            if len(found) == 1:
                matched_client_ids = list(found)
                matched_by = "title"

        if not matched_client_ids:
            unmatched += 1
            continue

        if matched_by == "relation":
            matched_relation += 1
        else:
            matched_title += 1

        page_id = page["id"]
        last_edited = page.get("last_edited_time")
        cached = cache.get(page_id)
        if cached and cached.get("last_edited_time") == last_edited:
            summary = cached.get("summary", [])
            cache_reused += 1
        else:
            summary = fetch_meeting_summary(page_id)
            cache[page_id] = {"last_edited_time": last_edited, "summary": summary}
            api_fetched += 1

        entry = {
            "page_id": page_id,
            "title": title,
            "date": date_display,
            "date_iso": date_iso,
            "url": page.get("url", ""),
            "matched_by": matched_by,
            "summary": summary,
        }
        for cid in matched_client_ids:
            meetings_by_client[cid].append(entry)

    for cid in meetings_by_client:
        meetings_by_client[cid].sort(key=lambda m: m["date_iso"] or "", reverse=True)

    with open(MEETINGS_CACHE_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    print(
        f"[STEP2.5] 取得: {len(pages)}件 / relation一致: {matched_relation}件 / "
        f"title一致: {matched_title}件 / 本文API取得: {api_fetched}件 / "
        f"キャッシュ再利用: {cache_reused}件 / 未紐づけ: {unmatched}件"
    )

    return {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "meetings": dict(meetings_by_client),
    }


# ---- STEP3: HTML生成 ----

LEGEND_ITEMS = [
    ("kessan_mark", "#1a56db", "決算期"),
    ("kessan", "#93c5fd", "申告"),
    ("yotei", "#16a34a", "予定納税"),
    ("gensen", "#fb923c", "源泉所得税納付"),
    ("nencho", "purple", "年末調整（12月）"),
    ("spot", "#888", "スポット"),
]

TYPE_COLOR_MAP = {t: c for t, c, _ in LEGEND_ITEMS}

MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月",
                "7月", "8月", "9月", "10月", "11月", "12月"]


def js_safe(s: str) -> str:
    """文字列をJSシングルクォート内で安全にエスケープ"""
    return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ").replace("\r", "")


def html_attr_escape(s: str) -> str:
    """文字列をHTML属性（ダブルクォート内）で安全にエスケープ"""
    return (str(s).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def mask_id_value(v: str) -> str:
    """識別番号を「●●●…下4桁」形式でマスクする。4桁以下は全マスク"""
    v = str(v)
    if len(v) <= 4:
        return "●" * len(v)
    return "●" * (len(v) - 4) + v[-4:]


def masked_id_field_html(label: str, value: str) -> str:
    """利用者識別番号等の税務系番号フィールドを、クリックで表示切替＋コピーボタン付きで生成する。
    デフォルトはマスク表示。元の値はHTML内に埋め込む（ローカルツールのため許容）。"""
    full = html_attr_escape(value)
    masked = html_attr_escape(mask_id_value(value))
    return (
        f'<div class="info-item"><div class="info-label">{label}</div>'
        f'<div class="masked-value-wrap">'
        f'<span class="masked-value" data-full="{full}" data-masked-text="{masked}" '
        f'onclick="toggleMaskedValue(this)" title="クリックで表示切替">{masked}</span>'
        f'<button class="copy-btn" onclick="copyMaskedValue(this)" title="全桁をコピー">📋</button>'
        f'</div></div>'
    )


def generate_index_html(data: dict) -> str:
    # 申告期限（決算月+2ヶ月）が近い順（今月が7月なら5月決算=0, 6月決算=1, ..., null=99）
    base_month = datetime.now().month
    clients = sorted(data["clients"], key=lambda c: (c["fiscal_month"] - base_month + 2) % 12 if c.get("fiscal_month") else 99)
    sorted_data = {**data, "clients": clients}
    data_json_str = json.dumps(sorted_data, ensure_ascii=False, indent=2)

    legend_html = ""
    for t, c, label in LEGEND_ITEMS:
        legend_html += f'<span class="legend-dot" style="background:{c}"></span><span class="legend-label">{label}</span>\n'

    client_options = ""
    for c in clients:
        client_options += f'<option value="{c["id"]}">{c["name"]}</option>\n'

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>顧問先年間カレンダー</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #333; }}
  header {{ background: #fff; border-bottom: 1px solid #ddd; padding: 12px 20px; position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }}
  header h1 {{ font-size: 18px; font-weight: 700; }}
  .legend {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; margin-left: auto; }}
  .legend-dot {{ width: 10px; height: 10px; border-radius: 50%; display: inline-block; }}
  .legend-label {{ margin-right: 6px; }}
  .add-btn {{ margin-left: 8px; padding: 5px 14px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }}
  .table-wrap {{ overflow: auto; max-height: calc(100vh - var(--header-h, 57px)); padding: 12px 20px; }}
  table {{ border-collapse: collapse; min-width: 900px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1); }}
  thead th {{ background: #f8f9fa; font-size: 12px; font-weight: 600; padding: 8px 10px; border: 1px solid #e5e7eb; text-align: center; position: sticky; top: 0; z-index: 10; }}
  thead th:first-child {{ text-align: left; min-width: 160px; }}
  tbody tr {{ cursor: pointer; transition: background .15s; }}
  tbody tr:hover {{ background: #f0f4ff; }}
  tbody td {{ border: 1px solid #e5e7eb; padding: 6px 10px; font-size: 13px; vertical-align: middle; }}
  tbody td:first-child {{ white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }}
  .current-month {{ background: #e0f2fe !important; }}
  thead th.current-month {{ background: #bae6fd !important; }}
  .dots {{ display: flex; flex-wrap: wrap; gap: 3px; justify-content: center; align-items: center; }}
  .dot {{ width: 9px; height: 9px; border-radius: 50%; display: inline-block; cursor: default; flex-shrink: 0; }}
  .task-label {{ font-size: 9px; padding: 1px 5px; border-radius: 3px; background: #93c5fd; color: #1e3a8a; white-space: nowrap; cursor: default; font-weight: 600; }}
  .status-badge {{ font-size: 10px; padding: 1px 5px; border-radius: 8px; background: #e5e7eb; margin-left: 4px; }}
  .status-進行中 {{ background: #dbeafe; color: #1e40af; }}
  .status-回答待ち {{ background: #fef3c7; color: #92400e; }}
  .status-完了 {{ background: #d1fae5; color: #065f46; }}

  /* Modal */
  .modal-overlay {{ display:none; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:200; align-items:center; justify-content:center; }}
  .modal-overlay.open {{ display:flex; }}
  .modal {{ background:#fff; border-radius:10px; padding:24px; min-width:340px; max-width:480px; width:90%; }}
  .modal h2 {{ font-size:16px; margin-bottom:16px; }}
  .form-row {{ margin-bottom:12px; }}
  .form-row label {{ display:block; font-size:12px; margin-bottom:4px; color:#555; }}
  .form-row input, .form-row select, .form-row textarea {{ width:100%; border:1px solid #ccc; border-radius:4px; padding:7px 10px; font-size:13px; }}
  .modal-btns {{ display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }}
  .btn-cancel {{ padding:6px 16px; border:1px solid #ccc; border-radius:4px; background:#fff; cursor:pointer; }}
  .btn-save {{ padding:6px 16px; background:#1a56db; color:#fff; border:none; border-radius:4px; cursor:pointer; }}
  .search-box {{ padding: 4px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; min-width: 160px; }}
  .client-count {{ font-size: 13px; color: #555; white-space: nowrap; }}
  .month-count {{ display: block; font-size: 10px; color: #888; font-weight: 400; margin-top: 2px; }}
  thead th.current-month .month-count {{ color: #0e7490; }}
  .filter-btns {{ display: flex; gap: 4px; }}
  .filter-btn {{ padding: 4px 12px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; font-size: 13px; }}
  .filter-btn.active {{ background: #0e7490; color: #fff; border-color: #0e7490; }}
</style>
</head>
<body>

<header>
  <h1>顧問先年間カレンダー</h1>
  <input class="search-box" type="text" placeholder="顧問先を検索..." oninput="filterClients(this.value)" />
  <div class="filter-btns">
    <button class="filter-btn active" onclick="setCategory(null, this)">全て</button>
    <button class="filter-btn" onclick="setCategory('法人', this)">法人</button>
    <button class="filter-btn" onclick="setCategory('個人', this)">個人</button>
    <button class="filter-btn" onclick="setCategory('コンサル', this)">コンサル</button>
  </div>
  <div class="legend">
    {legend_html}
  </div>
  <span class="client-count" id="client-count"></span>
  <button class="add-btn" onclick="openModal()">＋追加</button>
</header>

<div class="table-wrap">
  <table id="main-table">
    <thead>
      <tr>
        <th>顧問先</th>
        {' '.join(f'<th>{m}<span class="month-count" id="mc-{i+1}"></span></th>' for i, m in enumerate(MONTH_LABELS))}
      </tr>
    </thead>
    <tbody id="table-body"></tbody>
  </table>
</div>

<!-- Add Task Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2>スポットタスク追加</h2>
    <div class="form-row">
      <label>顧問先</label>
      <select id="modal-client">
        {client_options}
      </select>
    </div>
    <div class="form-row">
      <label>タスク名</label>
      <input type="text" id="modal-title" placeholder="例: 書類提出" />
    </div>
    <div class="form-row">
      <label>月 (1-12)</label>
      <input type="number" id="modal-month" min="1" max="12" value="1" />
    </div>
    <div class="form-row">
      <label>メモ</label>
      <textarea id="modal-note" rows="2" placeholder="備考など"></textarea>
    </div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">キャンセル</button>
      <button class="btn-save" onclick="saveSpot()">追加</button>
    </div>
  </div>
</div>

<script>
// インライン埋め込みデータ（fetchが使えないローカル環境用）
const DATA_FALLBACK = {data_json_str};

const currentYear = new Date().getFullYear();
let allClients = [];
let filterText = '';
let filterCategory = null;
const currentMonth = new Date().getMonth() + 1;

const TYPE_COLOR = {{
  kessan_mark: '#1a56db',
  kessan: '#93c5fd',
  yotei: '#16a34a',
  gensen: '#fb923c',
  nencho: 'purple',
  spot: '#888',
}};

function loadData() {{
  fetch('./data.json')
    .then(r => r.json())
    .catch(() => DATA_FALLBACK)
    .then(data => {{
      allClients = data.clients || [];
      mergeLocalStorage();
      renderTable();
    }});
}}

function mergeLocalStorage() {{
  const spots = JSON.parse(localStorage.getItem('spot_tasks') || '[]');
  spots.forEach(s => {{
    const c = allClients.find(x => x.id === s.client_id);
    if (c) {{
      const exists = c.tasks.some(t => t.id === s.id);
      if (!exists) {{
        c.tasks.push({{ ...s, type: 'spot', color: '#888', status: 'todo' }});
      }}
    }}
  }});

  // ステータス上書き
  const statuses = JSON.parse(localStorage.getItem('task_statuses') || '{{}}');
  allClients.forEach(c => {{
    c.tasks.forEach(t => {{
      const key = c.id + ':' + t.id;
      if (statuses[key]) t.status = statuses[key];
    }});
  }});
}}

function filterClients(v) {{
  filterText = v.toLowerCase();
  renderTable();
}}

function setCategory(cat, btn) {{
  filterCategory = cat;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderTable();
}}

function fiscalSortKey(c) {{
  // 申告期限（決算月+2ヶ月）が近い順。今月が7月なら5月決算（期限7月末）が最上位
  const m = c.fiscal_month;
  return m ? (m - currentMonth + 2 + 12) % 12 : 99;
}}

function renderTable() {{
  const tbody = document.getElementById('table-body');
  tbody.innerHTML = '';
  const filtered = allClients
    .filter(c => !filterText || c.name.toLowerCase().includes(filterText) || (c.formal_name || '').toLowerCase().includes(filterText))
    .filter(c => !filterCategory || c.category === filterCategory)
    .sort((a, b) => fiscalSortKey(a) - fiscalSortKey(b));

  // 顧問先数を更新
  document.getElementById('client-count').textContent = filtered.length + '社';

  // 月別申告件数を更新
  for (let m = 1; m <= 12; m++) {{
    const cnt = filtered.filter(c => c.tasks.some(t => t.month === m && t.type === 'kessan_mark')).length;
    const el = document.getElementById('mc-' + m);
    if (el) el.textContent = cnt > 0 ? cnt + '件' : '';
  }}

  filtered.forEach(client => {{
    const tr = document.createElement('tr');
    tr.onclick = () => {{ window.location.href = 'clients/' + client.id + '.html'; }};

    // 名前セル
    const nameCell = document.createElement('td');
    nameCell.innerHTML = `<span title="${{client.formal_name || client.name}}">${{client.name}}</span>`;
    tr.appendChild(nameCell);

    // 月別セル
    for (let m = 1; m <= 12; m++) {{
      const td = document.createElement('td');
      if (m === currentMonth) td.classList.add('current-month');
      const monthTasks = client.tasks.filter(t => t.month === m);
      if (monthTasks.length > 0) {{
        const dotsDiv = document.createElement('div');
        dotsDiv.className = 'dots';
        monthTasks.forEach(t => {{
          const isDone = t.status === 'done';
          if (t.type === 'kessan') {{
            const label = document.createElement('span');
            label.className = 'task-label';
            label.textContent = '申告';
            label.title = t.title + (isDone ? ' ✓' : '');
            if (isDone) label.style.opacity = '0.4';
            dotsDiv.appendChild(label);
          }} else {{
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = TYPE_COLOR[t.type] || t.color || '#aaa';
            dot.title = t.title + (isDone ? ' ✓' : '');
            if (isDone) dot.style.opacity = '0.4';
            dotsDiv.appendChild(dot);
          }}
        }});
        td.appendChild(dotsDiv);
      }}
      tr.appendChild(td);
    }}
    tbody.appendChild(tr);
  }});
}}

// Modal
function openModal() {{
  document.getElementById('modal').classList.add('open');
}}
function closeModal() {{
  document.getElementById('modal').classList.remove('open');
}}
function saveSpot() {{
  const clientId = document.getElementById('modal-client').value;
  const title = document.getElementById('modal-title').value.trim();
  const month = parseInt(document.getElementById('modal-month').value);
  const note = document.getElementById('modal-note').value.trim();

  if (!title || !month || month < 1 || month > 12) {{
    alert('タスク名と月を入力してください');
    return;
  }}

  const spot = {{
    id: 'spot-' + Date.now(),
    client_id: clientId,
    title,
    month,
    note,
    type: 'spot',
    color: '#888',
    status: 'todo',
  }};

  const spots = JSON.parse(localStorage.getItem('spot_tasks') || '[]');
  spots.push(spot);
  localStorage.setItem('spot_tasks', JSON.stringify(spots));

  const c = allClients.find(x => x.id === clientId);
  if (c) c.tasks.push(spot);
  renderTable();
  closeModal();
}}

loadData();

// 当月列のtheadを色付け（th[0]=顧問先, th[1]=1月, ...）
document.querySelectorAll('thead th')[currentMonth].classList.add('current-month');

// theadのstickyをheader実高さに追従させる
(function() {{
  const header = document.querySelector('header');
  const update = () => document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  update();
  new ResizeObserver(update).observe(header);
}})();
</script>
</body>
</html>
"""
    return html


def generate_client_html(client: dict, all_clients: list) -> str:
    """個別顧問先HTML生成"""
    name = client["name"]
    formal = client.get("formal_name") or name
    fiscal = client.get("fiscal_month")
    software = client.get("software") or "未設定"
    category = client.get("category") or ""
    status = client.get("status") or ""
    annual_fee = client.get("annual_fee")
    fee_str = f"¥{annual_fee:,}" if annual_fee is not None else "未設定"
    address = client.get("address") or "未設定"
    representative = client.get("representative") or ""
    etax_id = client.get("etax_id") or ""
    taxnote_id = client.get("taxnote_id") or ""
    eltax_id = client.get("eltax_id") or ""
    client_id = client["id"]

    tasks_json = json.dumps(client["tasks"], ensure_ascii=False)

    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{name} - 顧問先カレンダー</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #333; }}
  header {{ background: #fff; border-bottom: 1px solid #ddd; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }}
  .back-link {{ color: #1a56db; text-decoration: none; font-size: 13px; }}
  .back-link:hover {{ text-decoration: underline; }}
  header h1 {{ font-size: 18px; font-weight: 700; }}
  .client-info {{ background: #fff; margin: 16px 20px; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.1); display: flex; flex-wrap: wrap; gap: 16px; }}
  .info-item {{ min-width: 140px; }}
  .info-label {{ font-size: 11px; color: #666; margin-bottom: 2px; }}
  .info-value {{ font-size: 14px; font-weight: 500; }}
  .main-cols {{ display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; margin: 0 20px 20px; }}
  @media (max-width: 900px) {{ .main-cols {{ grid-template-columns: 1fr; }} }}
  .col-header {{ font-size: 14px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; min-height: 30px; }}
  .tasks-wrap {{ margin: 0; }}
  .month-section {{ background: #fff; border-radius: 8px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden; }}
  .month-header {{ background: #f8f9fa; padding: 10px 16px; font-weight: 600; font-size: 14px; border-bottom: 1px solid #e5e7eb; display: flex; align-items: center; gap: 8px; cursor: pointer; }}
  .month-header .count {{ font-size: 12px; color: #666; font-weight: 400; }}
  .task-list {{ padding: 0; }}
  .task-item {{ display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid #f3f4f6; }}
  .task-item:last-child {{ border-bottom: none; }}
  .task-dot {{ width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }}
  .task-title {{ flex: 1; font-size: 13px; }}
  .task-note {{ font-size: 12px; color: #888; }}
  .task-status-btn {{ padding: 3px 12px; border-radius: 12px; border: 1px solid #ccc; font-size: 12px; cursor: pointer; background: #fff; }}
  .task-status-btn.done {{ background: #d1fae5; color: #065f46; border-color: #6ee7b7; }}
  .add-spot-btn {{ display: inline-block; margin-left: auto; padding: 5px 14px; background: #1a56db; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 400; }}

  /* 議事録 */
  .meetings-wrap {{ margin: 0; }}
  .meetings-header {{ font-size: 14px; font-weight: 700; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; min-height: 30px; }}
  .meetings-header .count {{ font-size: 12px; color: #666; font-weight: 400; }}
  .meeting-item {{ background: #fff; border-radius: 8px; margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); overflow: hidden; }}
  .meeting-row {{ padding: 10px 16px; display: flex; align-items: center; gap: 10px; cursor: pointer; }}
  .meeting-date {{ font-size: 12px; color: #666; white-space: nowrap; }}
  .meeting-title {{ flex: 1; font-size: 13px; font-weight: 500; }}
  .meeting-badge {{ font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #fef3c7; color: #92400e; white-space: nowrap; }}
  .meeting-body {{ display: none; padding: 0 16px 14px; border-top: 1px solid #f3f4f6; }}
  .meeting-body.open {{ display: block; }}
  .meeting-body h4 {{ font-size: 13px; margin: 10px 0 4px; }}
  .meeting-body p {{ font-size: 12.5px; color: #444; margin: 4px 0; line-height: 1.5; }}
  .meeting-body ul {{ margin: 4px 0 4px 18px; }}
  .meeting-body li {{ font-size: 12.5px; color: #444; margin: 2px 0; line-height: 1.5; }}
  .meeting-link {{ display: inline-block; margin-top: 8px; font-size: 12px; color: #1a56db; text-decoration: none; }}
  .meeting-link:hover {{ text-decoration: underline; }}
  .meeting-empty {{ color: #999; font-size: 13px; padding: 8px 0; }}

  /* Modal */
  .modal-overlay {{ display:none; position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:200; align-items:center; justify-content:center; }}
  .modal-overlay.open {{ display:flex; }}
  .modal {{ background:#fff; border-radius:10px; padding:24px; min-width:320px; max-width:440px; width:90%; }}
  .modal h2 {{ font-size:16px; margin-bottom:16px; }}
  .form-row {{ margin-bottom:12px; }}
  .form-row label {{ display:block; font-size:12px; margin-bottom:4px; color:#555; }}
  .form-row input, .form-row textarea {{ width:100%; border:1px solid #ccc; border-radius:4px; padding:7px 10px; font-size:13px; }}
  .modal-btns {{ display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }}
  .btn-cancel {{ padding:6px 16px; border:1px solid #ccc; border-radius:4px; background:#fff; cursor:pointer; }}
  .btn-save {{ padding:6px 16px; background:#1a56db; color:#fff; border:none; border-radius:4px; cursor:pointer; }}

  /* 識別番号マスク表示 */
  .masked-value-wrap {{ display:flex; align-items:center; gap:6px; }}
  .masked-value {{ font-family:monospace; font-size:13px; cursor:pointer; user-select:none; }}
  .masked-value:hover {{ color:#1a56db; }}
  .copy-btn {{ border:none; background:none; cursor:pointer; font-size:11px; padding:1px 3px; opacity:.5; line-height:1; }}
  .copy-btn:hover {{ opacity:.9; }}
</style>
</head>
<body>

<header>
  <a class="back-link" href="../index.html">← カレンダーへ戻る</a>
  <h1>{name}</h1>
</header>

<div class="client-info">
  <div class="info-item">
    <div class="info-label">正式名称</div>
    <div class="info-value">{formal}</div>
  </div>
  <div class="info-item">
    <div class="info-label">区分</div>
    <div class="info-value">{category}</div>
  </div>
  <div class="info-item">
    <div class="info-label">決算月</div>
    <div class="info-value">{f'{fiscal}月' if fiscal else '未設定'}</div>
  </div>
  <div class="info-item">
    <div class="info-label">会計ソフト</div>
    <div class="info-value">{software}</div>
  </div>
  <div class="info-item">
    <div class="info-label">年額顧問料</div>
    <div class="info-value">{fee_str}</div>
  </div>
  <div class="info-item">
    <div class="info-label">ステータス</div>
    <div class="info-value">{status}</div>
  </div>
  <div class="info-item" style="min-width:300px;">
    <div class="info-label">住所</div>
    <div class="info-value" style="font-size:12px;">{address}</div>
  </div>
  {f'<div class="info-item"><div class="info-label">代表者</div><div class="info-value">{representative}</div></div>' if representative else ''}
  {masked_id_field_html('利用者識別番号（e-Tax）', etax_id) if etax_id else ''}
  {masked_id_field_html('納税用確認番号', taxnote_id) if taxnote_id else ''}
  {masked_id_field_html('eLTAX 利用者ID', eltax_id) if eltax_id else ''}
</div>

<div class="main-cols">
  <div>
    <div class="col-header">年間カレンダー <button class="add-spot-btn" onclick="openModal()">＋スポットタスク追加</button></div>
    <div class="tasks-wrap" id="tasks-wrap"></div>
  </div>
  <div class="meetings-wrap" id="meetings-wrap">
    <div class="meetings-header">議事録 <span class="count" id="meetings-count"></span></div>
    <div id="meetings-list"></div>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal">
    <h2>スポットタスク追加</h2>
    <div class="form-row">
      <label>タスク名</label>
      <input type="text" id="modal-title" placeholder="例: 書類提出" />
    </div>
    <div class="form-row">
      <label>月 (1-12)</label>
      <input type="number" id="modal-month" min="1" max="12" value="1" />
    </div>
    <div class="form-row">
      <label>メモ</label>
      <textarea id="modal-note" rows="2" placeholder="備考など"></textarea>
    </div>
    <div class="modal-btns">
      <button class="btn-cancel" onclick="closeModal()">キャンセル</button>
      <button class="btn-save" onclick="saveSpot()">追加</button>
    </div>
  </div>
</div>

<script>
const CLIENT_ID = '{client_id}';
const TYPE_COLOR = {{
  kessan_mark: '#1a56db',
  kessan: '#93c5fd',
  yotei: '#16a34a',
  gensen: '#fb923c',
  nencho: 'purple',
  spot: '#888',
}};
const MONTH_LABELS = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
// dashboard server.py (port 3460)。task_statuses/spot_tasksはここへ永続化する（calendar-tasks.json、全顧問先分を全量保存）
const SYNC_SERVER = 'http://localhost:3460';

let tasks = {tasks_json};
let calendarTaskStatuses = {{}};  // 全顧問先分のtask_statuses（サーバー保存の全量）
let calendarSpotTasks = [];       // 全顧問先分のspot_tasks（サーバー保存の全量）

// task_statuses・spot_tasksをサーバー（calendar-tasks.json）とlocalStorageからマージして読み込む。
// task_statusesはキー単位の和集合（サーバー優先）、spot_tasksはID単位の和集合。
// マージ結果がサーバーの内容と異なる場合はサーバーへ書き戻す（初回マイグレーション）。
// サーバー不達時はlocalStorageのみで動作する（劣化フォールバック）。
async function loadAndMergeCalendarTasks() {{
  const localSpots = JSON.parse(localStorage.getItem('spot_tasks') || '[]');
  const localStatuses = JSON.parse(localStorage.getItem('task_statuses') || '{{}}');

  let serverData = null;
  try {{
    const res = await fetch(SYNC_SERVER + '/api/calendar-tasks');
    if (res.ok) serverData = await res.json();
  }} catch (e) {{
    // dashboard server.py不達時はlocalStorageのみで動作
  }}

  if (!serverData) {{
    calendarTaskStatuses = localStatuses;
    calendarSpotTasks = localSpots;
    applyTasksFromCalendarState();
    return;
  }}

  const serverStatuses = serverData.task_statuses || {{}};
  const serverSpots = serverData.spot_tasks || [];

  const mergedStatuses = {{ ...localStatuses, ...serverStatuses }};
  const spotMap = new Map();
  localSpots.forEach(s => spotMap.set(s.id, s));
  serverSpots.forEach(s => spotMap.set(s.id, s));
  const mergedSpots = Array.from(spotMap.values());

  calendarTaskStatuses = mergedStatuses;
  calendarSpotTasks = mergedSpots;
  localStorage.setItem('task_statuses', JSON.stringify(mergedStatuses));
  localStorage.setItem('spot_tasks', JSON.stringify(mergedSpots));

  const changed = JSON.stringify(mergedStatuses) !== JSON.stringify(serverStatuses)
    || JSON.stringify(mergedSpots) !== JSON.stringify(serverSpots);
  if (changed) persistCalendarTasks();

  applyTasksFromCalendarState();
}}

function applyTasksFromCalendarState() {{
  // スポットタスクを追加
  calendarSpotTasks.filter(s => s.client_id === CLIENT_ID).forEach(s => {{
    if (!tasks.some(t => t.id === s.id)) tasks.push(s);
  }});
  // ステータス上書き
  tasks.forEach(t => {{
    const key = CLIENT_ID + ':' + t.id;
    if (calendarTaskStatuses[key]) t.status = calendarTaskStatuses[key];
  }});
}}

// localStorage更新＋サーバーへ保存（fire-and-forget。失敗してもUIは止めない）
function persistCalendarTasks() {{
  localStorage.setItem('task_statuses', JSON.stringify(calendarTaskStatuses));
  localStorage.setItem('spot_tasks', JSON.stringify(calendarSpotTasks));
  fetch(SYNC_SERVER + '/api/calendar-tasks', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify({{ task_statuses: calendarTaskStatuses, spot_tasks: calendarSpotTasks }}),
  }}).catch(() => {{
    console.warn('calendar-tasks: サーバーへの保存に失敗しました（ローカルには保存済み）');
  }});
}}

function renderTasks() {{
  const wrap = document.getElementById('tasks-wrap');
  wrap.innerHTML = '';

  for (let m = 1; m <= 12; m++) {{
    const monthTasks = tasks.filter(t => t.month === m);
    const section = document.createElement('div');
    section.className = 'month-section';

    const header = document.createElement('div');
    header.className = 'month-header';
    header.innerHTML = `${{MONTH_LABELS[m-1]}} <span class="count">${{monthTasks.length}}件</span>`;
    header.onclick = () => {{
      const list = section.querySelector('.task-list');
      list.style.display = list.style.display === 'none' ? '' : 'none';
    }};
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'task-list';
    if (monthTasks.length === 0) {{
      list.style.display = 'none';
    }}

    monthTasks.forEach(task => {{
      const item = document.createElement('div');
      item.className = 'task-item';
      const color = TYPE_COLOR[task.type] || task.color || '#aaa';
      const isDone = task.status === 'done';
      item.innerHTML = `
        <span class="task-dot" style="background:${{color}}"></span>
        <div style="flex:1">
          <div class="task-title" style="${{isDone ? 'text-decoration:line-through;color:#aaa' : ''}}">${{task.title}}</div>
          ${{task.note ? `<div class="task-note">${{task.note}}</div>` : ''}}
        </div>
        <button class="task-status-btn ${{isDone ? 'done' : ''}}"
          onclick="toggleStatus('${{task.id}}', this)"
        >${{isDone ? '完了済 ✓' : '未完了'}}</button>
      `;
      list.appendChild(item);
    }});

    section.appendChild(list);
    wrap.appendChild(section);
  }}
}}

function toggleStatus(taskId, btn) {{
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.status = task.status === 'done' ? 'todo' : 'done';
  calendarTaskStatuses[CLIENT_ID + ':' + taskId] = task.status;
  persistCalendarTasks();
  renderTasks();
}}

function escapeHtml(s) {{
  return String(s).replace(/[&<>"']/g, ch => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch]));
}}

// 識別番号のマスク表示切替（クリックで全桁表示⇔マスク表示）
function toggleMaskedValue(el) {{
  const showingFull = el.textContent === el.dataset.full;
  el.textContent = showingFull ? el.dataset.maskedText : el.dataset.full;
}}

// 識別番号の全桁をクリップボードへコピー（ボタンの見た目で成否を一時表示）
function copyMaskedValue(btn) {{
  const span = btn.previousElementSibling;
  const value = span.dataset.full;
  navigator.clipboard.writeText(value).then(() => {{
    btn.textContent = '✓';
    setTimeout(() => {{ btn.textContent = '📋'; }}, 1200);
  }}).catch(() => {{
    btn.textContent = '×';
    setTimeout(() => {{ btn.textContent = '📋'; }}, 1200);
  }});
}}

function renderMeetingSummary(summary) {{
  if (!summary || summary.length === 0) return '<div class="meeting-empty">要約なし</div>';
  let html = '';
  let inList = false;
  summary.forEach(block => {{
    if (block.t === 'li') {{
      if (!inList) {{ html += '<ul>'; inList = true; }}
      html += `<li>${{escapeHtml(block.text)}}</li>`;
    }} else {{
      if (inList) {{ html += '</ul>'; inList = false; }}
      if (block.t === 'h') html += `<h4>${{escapeHtml(block.text)}}</h4>`;
      else if (block.t === 'todo') html += `<p>☐ ${{escapeHtml(block.text)}}</p>`;
      else if (block.t === 'p') html += `<p>${{escapeHtml(block.text)}}</p>`;
    }}
  }});
  if (inList) html += '</ul>';
  return html;
}}

function loadMeetings() {{
  fetch('../meetings.json')
    .then(r => {{ if (!r.ok) throw new Error('meetings.json not found'); return r.json(); }})
    .then(data => {{
      const list = (data.meetings && data.meetings[CLIENT_ID]) || [];
      const listEl = document.getElementById('meetings-list');
      const countEl = document.getElementById('meetings-count');
      countEl.textContent = list.length + '件';

      if (list.length === 0) {{
        listEl.innerHTML = '<div class="meeting-empty">議事録なし</div>';
        return;
      }}

      listEl.innerHTML = '';
      list.forEach(m => {{
        const item = document.createElement('div');
        item.className = 'meeting-item';
        const badge = m.matched_by === 'title' ? '<span class="meeting-badge">タイトル一致</span>' : '';
        item.innerHTML = `
          <div class="meeting-row">
            <span class="meeting-date">${{escapeHtml(m.date || '')}}</span>
            <span class="meeting-title">${{escapeHtml(m.title || '')}}</span>
            ${{badge}}
          </div>
          <div class="meeting-body">
            ${{renderMeetingSummary(m.summary)}}
            <a class="meeting-link" href="${{escapeHtml(m.url || '#')}}" target="_blank">Notionで開く ↗</a>
          </div>
        `;
        const row = item.querySelector('.meeting-row');
        const body = item.querySelector('.meeting-body');
        row.onclick = () => {{ body.classList.toggle('open'); }};
        listEl.appendChild(item);
      }});
    }})
    .catch(() => {{
      document.getElementById('meetings-count').textContent = '';
      document.getElementById('meetings-list').innerHTML = '<div class="meeting-empty">議事録データ未同期（Notion側の共有設定待ち）</div>';
    }});
}}

function openModal() {{
  document.getElementById('modal').classList.add('open');
}}
function closeModal() {{
  document.getElementById('modal').classList.remove('open');
}}
function saveSpot() {{
  const title = document.getElementById('modal-title').value.trim();
  const month = parseInt(document.getElementById('modal-month').value);
  const note = document.getElementById('modal-note').value.trim();
  if (!title || !month) {{ alert('タスク名と月を入力してください'); return; }}

  const spot = {{
    id: 'spot-' + Date.now(),
    client_id: CLIENT_ID,
    title, month, note,
    type: 'spot', color: '#888', status: 'todo',
  }};

  calendarSpotTasks.push(spot);
  persistCalendarTasks();
  tasks.push(spot);
  renderTasks();
  closeModal();
}}

loadAndMergeCalendarTasks().then(() => {{ renderTasks(); }});
loadMeetings();
</script>
</body>
</html>
"""
    return html


# ---- メイン処理 ----

def main():
    print("=== client-calendar generate.py 開始 ===")

    if not NOTION_DB_ID:
        raise RuntimeError("NOTION_DB_ID 環境変数が未設定です。Notionの顧問先DBのIDを設定してください")

    # STEP1: Notion APIから全顧問先取得
    print("[STEP1] Notionから顧問先を取得中...")
    pages = fetch_all_pages(NOTION_DB_ID)
    clients = extract_clients_from_notion(pages)
    print(f"[STEP1] {len(clients)} 件取得 (アーカイブ除く)")

    # STEP2: 定期タスク生成
    clients, total_tasks = generate_tasks(clients)
    print(f"[STEP2] 定期タスク生成完了: {total_tasks} 件")

    # data.json保存（申告期限＝決算月+2ヶ月が近い順。表示時の並びはindex.htmlのfiscalSortKeyが担当）
    base_month = datetime.now().month
    data = {
        "generated_at": datetime.now().strftime("%Y-%m-%d"),
        "has_more": False,
        "next_cursor": None,
        "clients": sorted(clients, key=lambda c: (c["fiscal_month"] - base_month + 2) % 12 if c.get("fiscal_month") else 99),
    }
    with open(DATA_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"[STEP2] data.json 保存完了 (顧問先 {len(clients)} 件)")

    # STEP2.5: 議事録同期
    meetings_data = sync_meetings(data["clients"])
    with open(MEETINGS_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(meetings_data, f, ensure_ascii=False, indent=2)
    print(f"[STEP2.5] meetings.json 保存完了 (紐づけ顧問先 {len(meetings_data.get('meetings', {}))} 件)")

    # STEP2.6: 議事録 未紐づけ候補の更新（relation_suggestions.json）。
    # 失敗しても同期全体は止めない（NOTION_TOKEN未設定・DB未共有等でも生成は継続する）
    try:
        import suggest_relations
        suggestions = suggest_relations.build_suggestions()
        print(f"[STEP2.6] relation_suggestions.json 更新完了 ({len(suggestions)} 件)")
    except Exception as e:
        print(f"[STEP2.6] WARN: 議事録未紐づけ候補の更新に失敗しました（スキップ）: {e}")

    # STEP3: 個別HTML生成（index.htmlは手動管理のため生成しない）
    CLIENTS_DIR.mkdir(parents=True, exist_ok=True)
    html_count = 0
    for client in data["clients"]:
        html = generate_client_html(client, data["clients"])
        out_path = CLIENTS_DIR / f"{client['id']}.html"
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(html)
        html_count += 1

    print(f"[STEP3] 個別HTML生成完了: {html_count} ファイル (clients/)")

    # STEP4: index.html の DATA_FALLBACK をインライン更新
    INDEX_HTML = BASE_DIR / "index.html"
    if INDEX_HTML.exists():
        html_text = INDEX_HTML.read_text(encoding="utf-8")
        marker_start = "const DATA_FALLBACK = "
        marker_end = "\n};"
        idx_s = html_text.find(marker_start)
        idx_e = html_text.find(marker_end, idx_s)
        if idx_s != -1 and idx_e != -1:
            new_json = json.dumps(data, ensure_ascii=False, indent=2)
            # idx_e は "\n};" の先頭位置。new_json 末尾の "}" の後に ";" を付け、"\n};" をスキップして続ける
            new_html = html_text[:idx_s] + marker_start + new_json + ";" + html_text[idx_e + len(marker_end):]
            INDEX_HTML.write_text(new_html, encoding="utf-8")
            print(f"[STEP4] index.html DATA_FALLBACK 更新完了")
        else:
            print(f"[STEP4] 警告: index.html の DATA_FALLBACK マーカーが見つかりません")
    else:
        print(f"[STEP4] index.html が見つかりません（スキップ）")

    print(f"=== 完了 ===")
    print(f"  総顧問先数: {len(clients)}")
    print(f"  定期タスク生成数: {total_tasks}")


if __name__ == "__main__":
    main()
