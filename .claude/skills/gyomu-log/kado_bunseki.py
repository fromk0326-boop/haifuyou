# -*- coding: utf-8 -*-
"""業務ログ（業務ログ/log.jsonl）を集計して、稼働分析ダッシュボード（HTML1枚）を生成する。

使い方（キットの一番上のフォルダで実行）:
    python .claude/skills/gyomu-log/kado_bunseki.py
    python .claude/skills/gyomu-log/kado_bunseki.py 別の場所/log.jsonl  # 置き場所を変えている場合

出力: 業務ログ/稼働分析.html （ブラウザで開くだけ。外部送信は一切しない）
"""
import collections
import datetime
import json
import sys
from pathlib import Path

# ログの置き場所（キットの一番上からの相対パス）
BASE = Path(__file__).resolve().parents[3]
LOG = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / "業務ログ" / "log.jsonl"
OUT = LOG.parent / "稼働分析.html"

DOW_LABELS = ["月", "火", "水", "木", "金", "土", "日"]


def load_rows(path):
    rows = []
    skipped = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            datetime.date.fromisoformat(r["date"])
            rows.append(r)
        except (json.JSONDecodeError, KeyError, ValueError):
            skipped += 1
    return rows, skipped


def minutes(r, key):
    v = r.get(key, 0)
    return v if isinstance(v, (int, float)) and v >= 0 else 0


def hours(m):
    return round(m / 60, 1)


def aggregate(rows):
    total_manual = sum(minutes(r, "manual_minutes") for r in rows)
    total_auto = sum(minutes(r, "auto_minutes") for r in rows)
    total_saved = sum(minutes(r, "saved_minutes") for r in rows)

    monthly = collections.defaultdict(float)
    weekly = collections.defaultdict(float)
    dows = [0.0] * 7
    cats = collections.defaultdict(lambda: {"count": 0, "saved": 0, "manual": 0, "auto": 0})
    for r in rows:
        d = datetime.date.fromisoformat(r["date"])
        saved = minutes(r, "saved_minutes")
        monthly[r["date"][:7]] += saved
        monday = d - datetime.timedelta(days=d.weekday())
        weekly[monday.isoformat()] += saved
        dows[d.weekday()] += saved
        c = cats[r.get("category") or "未分類"]
        c["count"] += 1
        c["saved"] += saved
        c["manual"] += minutes(r, "manual_minutes")
        c["auto"] += minutes(r, "auto_minutes")

    cat_rows = []
    for name, c in sorted(cats.items(), key=lambda kv: -kv[1]["saved"]):
        lev = round(c["manual"] / c["auto"], 1) if c["auto"] > 0 else None
        cat_rows.append({"cat": name, "count": c["count"], "saved_h": hours(c["saved"]), "leverage": lev})

    top = [r for r in rows if minutes(r, "manual_minutes") > 0]
    top.sort(key=lambda r: -minutes(r, "saved_minutes"))
    top_rows = [{
        "date": r["date"][5:],
        "cat": r.get("category") or "未分類",
        "task": str(r.get("task", ""))[:70],
        "manual": minutes(r, "manual_minutes"),
        "auto": minutes(r, "auto_minutes"),
        "saved": minutes(r, "saved_minutes"),
    } for r in top[:8]]

    return {
        "count": len(rows),
        "active_days": len({r["date"] for r in rows}),
        "manual_h": round(total_manual / 60),
        "auto_h": round(total_auto / 60),
        "saved_h": round(total_saved / 60),
        "leverage": round(total_manual / total_auto, 1) if total_auto > 0 else None,
        "first": min(r["date"] for r in rows),
        "last": max(r["date"] for r in rows),
        "monthly": [{"label": k[5:7].lstrip("0") + "月", "v": hours(v)} for k, v in sorted(monthly.items())][-12:],
        "weekly": [{"label": f"{int(k[5:7])}/{int(k[8:10])}", "v": hours(v)} for k, v in sorted(weekly.items())][-12:],
        "dows": [{"label": DOW_LABELS[i], "v": hours(dows[i])} for i in range(7)],
        "cats": cat_rows,
        "top": top_rows,
    }


TEMPLATE = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>業務ログ 稼働分析</title>
<style>
:root { --bg:#ffffff; --surface:#f6f7f8; --ink:#1a1d21; --ink2:#555b63; --ink3:#8a9099;
  --line:#e2e5e8; --accent:#2b6cb0; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#16181c; --surface:#1f2329; --ink:#e8eaed; --ink2:#aab1b9; --ink3:#7d848d;
    --line:#33383f; --accent:#7fb0e0; }
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:"Meiryo UI",Meiryo,"Yu Gothic UI",sans-serif; background:var(--bg); color:var(--ink);
  font-size:15px; line-height:1.7; padding:32px 20px 60px; }
.wrap { max-width:960px; margin:0 auto; }
header { margin-bottom:24px; border-bottom:1px solid var(--line); padding-bottom:16px;
  display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
h1 { font-size:24px; }
.pdfbtn { flex-shrink:0; font-family:inherit; font-size:14px; padding:8px 14px; cursor:pointer;
  border:1px solid var(--accent); color:var(--accent); background:transparent; border-radius:8px; }
.pdfbtn:hover { background:var(--accent); color:var(--bg); }
.cover, .ptitle { display:none; }
.sub { color:var(--ink2); font-size:14px; margin-top:4px; }
h2 { font-size:18px; margin:38px 0 6px; padding-left:10px; border-left:4px solid var(--accent); }
.note { color:var(--ink2); font-size:14px; margin-bottom:12px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-top:18px; }
.stat { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.stat .v { font-size:26px; font-weight:700; line-height:1.2; }
.stat .v small { font-size:15px; font-weight:400; color:var(--ink2); }
.stat .k { font-size:14px; color:var(--ink2); margin-top:4px; }
.stat.hero .v { color:var(--accent); }
.caveat { background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--ink3);
  border-radius:6px; padding:12px 16px; font-size:14px; color:var(--ink2); margin-top:20px; }
.vchart { display:flex; align-items:flex-end; gap:8px; height:180px; margin:16px 0 4px; }
.vcol { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:100%; min-width:0; }
.vbar { width:100%; max-width:56px; background:var(--accent); border-radius:4px 4px 0 0; min-height:2px; }
.vval { font-size:14px; color:var(--ink2); margin-bottom:4px; white-space:nowrap; }
.vlab { font-size:14px; color:var(--ink3); margin-top:6px; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; max-width:100%; }
.hrow { display:grid; grid-template-columns:minmax(90px,130px) 1fr 130px; gap:10px; align-items:center; margin:7px 0; }
.hlab { font-size:14px; text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.htrack { background:var(--surface); border-radius:4px; height:22px; position:relative; }
.hbar { position:absolute; left:0; top:0; bottom:0; background:var(--accent); border-radius:4px; min-width:2px; }
.hmeta { font-size:14px; color:var(--ink2); white-space:nowrap; }
.tblwrap { overflow-x:auto; border:1px solid var(--line); border-radius:8px; margin-top:12px; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th,td { padding:8px 12px; text-align:left; border-bottom:1px solid var(--line); white-space:nowrap; }
td.task { white-space:normal; min-width:260px; }
th { background:var(--surface); color:var(--ink2); font-weight:600; }
tr:last-child td { border-bottom:none; }
td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
td.num.acc { color:var(--accent); font-weight:700; }
footer { margin-top:44px; padding-top:12px; border-top:1px solid var(--line); color:var(--ink3); font-size:14px; }

/* ===== 印刷（PDF）時はスライド形式に変形: A4横・表紙つき・1ページ=1テーマ ===== */
@page { size: A4 landscape; margin: 12mm; }
@media print {
  :root { --bg:#ffffff; --surface:#f6f7f8; --ink:#1a1d21; --ink2:#555b63; --ink3:#8a9099;
    --line:#e2e5e8; --accent:#2b6cb0; }
  body { padding:0; font-size:15pt; }
  .wrap { max-width:none; }
  .pdfbtn { display:none; }
  header { display:none; }
  .cover { display:flex; flex-direction:column; justify-content:center; height:175mm;
    page-break-after:always; break-after:page; }
  .cover .ct { font-size:34pt; font-weight:700; line-height:1.3; }
  .cover .cs { font-size:16pt; color:var(--ink2); margin-top:16pt; }
  .cover .cn { font-size:14pt; color:var(--ink3); margin-top:40pt; }
  .ptitle { display:block; font-size:24pt; font-weight:700; margin:0 0 10pt; padding-top:6mm;
    padding-left:14px; border-left:6px solid var(--accent); }
  h2 { page-break-before:always; break-before:page; font-size:24pt; margin:0 0 10pt;
    padding-top:6mm; padding-left:14px; border-left-width:6px; }
  .note { font-size:14pt; margin-bottom:14pt; }
  .stats { gap:16px; margin-top:10mm; }
  .stat { break-inside:avoid; padding:18px 20px; }
  .stat .v { font-size:30pt; }
  .stat .v small { font-size:15pt; }
  .stat .k { font-size:14pt; }
  .caveat { font-size:14pt; margin-top:10mm; break-inside:avoid; }
  .vchart { height:230px; break-inside:avoid; }
  .vbar { max-width:80px; }
  .vval, .vlab, .hlab, .hmeta { font-size:14pt; }
  .hrow { grid-template-columns:minmax(120px,180px) 1fr 180px; break-inside:avoid; }
  .htrack { height:26px; }
  table { font-size:14pt; }
  th, td { padding:8px 10px; }
  td.task { min-width:0; }
  footer { font-size:14pt; }
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div>
    <h1>業務ログ 稼働分析ダッシュボード</h1>
    <div class="sub">集計期間: __FIRST__ 〜 __LAST__ ｜ このファイルはPCの中だけで完結しています（外部送信なし）</div>
  </div>
  <button class="pdfbtn" onclick="window.print()" title="印刷ダイアログで「PDFに保存」を選ぶと、表紙つきの横長スライドPDFになります">📄 PDFで保存</button>
</header>

<!-- 印刷（PDF）のときだけ表示される表紙 -->
<div class="cover">
  <div class="ct">業務ログ 稼働分析</div>
  <div class="cs">集計期間: __FIRST__ 〜 __LAST__</div>
  <div class="cn">gyomu-log スキルによる機械集計 ｜ 生成日: __TODAY__ ｜ 事務所内資料</div>
</div>

<div class="ptitle">全体サマリー</div>
<div class="stats">
  <div class="stat hero"><div class="v">__SAVED_H__<small> 時間</small></div><div class="k">削減時間の累計（自己申告）</div></div>
  <div class="stat"><div class="v">__COUNT__<small> 件</small></div><div class="k">記録タスク数</div></div>
  <div class="stat"><div class="v">__AUTO_H__<small> 時間</small></div><div class="k">AI実働時間</div></div>
  <div class="stat"><div class="v">__LEVERAGE__</div><div class="k">レバレッジ（手作業想定÷AI実働）</div></div>
  <div class="stat"><div class="v">__DAYS__<small> 日</small></div><div class="k">記録のある稼働日</div></div>
</div>

<div class="caveat">⚖ <b>数字の読み方:</b> 「手作業なら何分かかったか」はAIの見積もりで、甘め（大きめ）に出ます。
絶対値を成果として使うのではなく、<b>傾向・カテゴリの構成・月ごとの推移</b>を見るのが正しい使い方です。</div>

<h2>月別の削減時間</h2>
<p class="note">記録を始めてからの推移です。続けるほど「AIに任せる量」の変化が見えてきます。</p>
<div class="vchart" id="monthly"></div>

<h2>週別の削減時間（直近12週）</h2>
<p class="note">週ごとの波。少ない週は「AIに頼まなかった週」か「記録を忘れた週」のどちらかです。</p>
<div class="vchart" id="weekly"></div>

<h2>カテゴリ別の削減時間とレバレッジ</h2>
<p class="note">どの業務でAIが効いているかの配分。右の数字は「件数 / レバレッジ倍率（手作業想定÷AI実働）」。
倍率が高いカテゴリほど、AIに任せる価値が大きい仕事です。</p>
<div id="cats"></div>

<h2>曜日別の削減時間</h2>
<p class="note">自分の仕事のリズムが見えます。</p>
<div class="vchart" id="dows"></div>

<h2>削減時間トップのタスク</h2>
<p class="note">「AIに任せて一番得したのは何か」ランキング。（手作業想定が未記録の行は除外）</p>
<div class="tblwrap">
<table>
  <thead><tr><th>日付</th><th>カテゴリ</th><th>タスク</th><th class="num">手作業想定</th><th class="num">AI実働</th><th class="num">削減</th></tr></thead>
  <tbody id="toptbl"></tbody>
</table>
</div>

<footer>業務ログ 稼働分析 ｜ gyomu-log スキルによる機械集計 ｜ 生成日: __TODAY__</footer>
</div>

<script>
const DATA = __DATA__;

function vchart(id, data) {
  const max = Math.max(...data.map(d => d.v), 0.1);
  const host = document.getElementById(id);
  data.forEach(d => {
    const col = document.createElement("div");
    col.className = "vcol";
    col.title = d.label + ": " + d.v + "h";
    const val = document.createElement("div");
    val.className = "vval";
    val.textContent = d.v >= 100 ? Math.round(d.v) : d.v;
    const bar = document.createElement("div");
    bar.className = "vbar";
    bar.style.height = Math.max(2, d.v / max * 120) + "px";
    const lab = document.createElement("div");
    lab.className = "vlab";
    lab.textContent = d.label;
    col.append(val, bar, lab);
    host.append(col);
  });
}
vchart("monthly", DATA.monthly);
vchart("weekly", DATA.weekly);
vchart("dows", DATA.dows);

const catHost = document.getElementById("cats");
const catMax = Math.max(...DATA.cats.map(c => c.saved_h), 0.1);
DATA.cats.forEach(c => {
  const row = document.createElement("div");
  row.className = "hrow";
  const lev = c.leverage == null ? "—" : "×" + c.leverage.toFixed(1);
  row.title = c.cat + ": 削減" + c.saved_h + "h / " + c.count + "件 / レバレッジ" + lev;
  row.innerHTML = '<div class="hlab"></div>' +
    '<div class="htrack"><div class="hbar" style="width:' + (c.saved_h / catMax * 100) + '%"></div></div>' +
    '<div class="hmeta">' + Math.round(c.saved_h) + 'h ｜ ' + c.count + '件 / ' + lev + '</div>';
  row.querySelector(".hlab").textContent = c.cat;
  catHost.append(row);
});

const fmt = m => m >= 60 ? (m / 60).toFixed(1).replace(/\\.0$/, "") + "h" : m + "分";
const tb = document.getElementById("toptbl");
DATA.top.forEach(t => {
  const tr = document.createElement("tr");
  tr.innerHTML = '<td>' + t.date + '</td><td></td><td class="task"></td>' +
    '<td class="num">' + fmt(t.manual) + '</td><td class="num">' + fmt(t.auto) + '</td>' +
    '<td class="num acc">' + fmt(t.saved) + '</td>';
  tr.children[1].textContent = t.cat;
  tr.children[2].textContent = t.task;
  tb.append(tr);
});
</script>
</body>
</html>
"""


def main():
    if not LOG.exists():
        print(f"ログファイルが見つかりません: {LOG}")
        print("まだ記録が無い場合は、第7回_業務ログ/README.md の手順で記録を始めてください。")
        sys.exit(1)

    rows, skipped = load_rows(LOG)
    if not rows:
        print(f"ログは見つかりましたが、読める記録が0件でした: {LOG}")
        sys.exit(1)

    agg = aggregate(rows)
    lev = "—" if agg["leverage"] is None else f"{agg['leverage']}<small> 倍</small>"
    html = (TEMPLATE
            .replace("__DATA__", json.dumps(agg, ensure_ascii=False))
            .replace("__FIRST__", agg["first"]).replace("__LAST__", agg["last"])
            .replace("__SAVED_H__", f"{agg['saved_h']:,}").replace("__COUNT__", f"{agg['count']:,}")
            .replace("__AUTO_H__", f"{agg['auto_h']:,}").replace("__LEVERAGE__", lev)
            .replace("__DAYS__", str(agg["active_days"]))
            .replace("__TODAY__", datetime.date.today().isoformat()))
    OUT.write_text(html, encoding="utf-8")

    print(f"稼働分析を生成しました: {OUT}")
    print(f"  記録 {agg['count']}件 / 稼働 {agg['active_days']}日 / 削減累計 {agg['saved_h']}時間（自己申告）")
    if skipped:
        print(f"  ※ 形式が読めなかった行を {skipped} 行スキップしました")


if __name__ == "__main__":
    main()
