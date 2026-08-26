// freee申告サポートボタン — バックグラウンド（v0.4.4）
// 役割は「法人基礎データ照合」用のイチサンフォームAPI（国税庁法人番号公表サイト系データ）へのGET中継だけ。
// この拡張で唯一の外部送信であり、送るのは社名または法人番号の文字列のみ。
// 金額・申告データ・顧問先の内部情報は一切扱わない（2026-08-26 けんとさん承認）
//
// API実測（2026-08-26）:
//   /form/search?name={社名}    → JSON配列 [{corporate_number, name, postal_code, location}]
//   /form/{項目}?id={13桁番号}  → プレーンテキスト1値（項目別エンドポイント。JSONではない）
'use strict';

var ICHISAN_BASE = 'https://api.ichisan.jp/form/';

// 項目別エンドポイントのホワイトリスト（これ以外のパスは中継しない）
var ICHISAN_FIELDS = [
  'company_name_half', 'company_name_kana',
  'location_full', 'location_pref', 'location_city', 'location_town', 'location_street',
  'invoice_id', 'employee_num'
];

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'fss-ichisan') return;
  var url = null;
  var asJson = false;
  if (msg.mode === 'search') {
    var name = String(msg.name || '');
    if (!name || name.length > 200) { sendResponse({ ok: false, error: 'bad name' }); return; }
    url = ICHISAN_BASE + 'search?name=' + encodeURIComponent(name);
    asJson = true;
  } else if (msg.mode === 'field') {
    var id = String(msg.id || '');
    if (ICHISAN_FIELDS.indexOf(msg.field) < 0 || !/^[0-9]{13}$/.test(id)) {
      sendResponse({ ok: false, error: 'bad field/id' });
      return;
    }
    url = ICHISAN_BASE + msg.field + '?id=' + id;
  } else {
    sendResponse({ ok: false, error: 'bad mode' });
    return;
  }
  fetch(url, { headers: { 'Accept': asJson ? 'application/json' : 'text/plain' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return asJson ? res.json() : res.text();
    })
    .then(function (data) { sendResponse({ ok: true, data: data }); })
    .catch(function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
  return true; // sendResponseを非同期で返す
});
