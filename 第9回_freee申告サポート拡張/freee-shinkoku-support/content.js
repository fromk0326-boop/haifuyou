/*
 * freee申告サポートボタン
 * freee申告（https://secure.freee.co.jp/ctax/）の法人税・消費税画面に
 * 「前年比較」「予定納税試算」の2ボタンを追加する。
 *
 * 方針:
 * - 読み取り専用。freeeへの書き込みAPIは一切呼ばない（年度切替のPUTも呼ばない）。外部送信もしない
 * - v0.3: 消費税は内部API（GETのみ）で当期・前期データを取得してボタン1発比較＋予定納税プレフィル。
 *   ボタンはfreee画面内の既存ボタン列にインライン配置（見つからない画面はフローティングにフォールバック）
 * - v0.4: 法人税も内部API対応（前年比較・予定納税プレフィル）。
 *   「申告書チェック」は拡張から削除し、Claude Code側の一次レビュー（shinkoku-reviewスキル）に一本化
 * - APIが使えない画面はv0.2の汎用スクレイプ方式（DOM収集）にフォールバック
 * - ⚙開発情報タブでAPIキャプチャ・画面データをコピーできる
 *   （実画面の構造を回収して次バージョンの精緻化に使うため）
 * - 税務判断はしない。表示する結果はすべて「確認事項」として扱う
 */
(function () {
  'use strict';

  var SOURCE = 'freee-shinkoku-support';
  var ROOT_ID = 'fss-root';
  var PANEL_ID = 'fss-panel';
  var SNAP_KEY = 'fss:snapshots';
  var AUTO_KEY = 'fss:auto-snapshots';
  var MAX_SNAPSHOTS = 30;
  var MAX_AUTO_SNAPSHOTS = 60;
  var MAX_ITEMS = 1200;      // 1画面あたりのスクレイプ上限
  var MAX_CAPTURES = 300;    // APIキャプチャの保持上限

  var captures = [];         // MAINワールドから届いたAPIレスポンス（メモリのみ）
  var currentTab = 'compare';

  /* ===================== ユーティリティ ===================== */

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[fss]');
    console.log.apply(console, args);
  }

  // 全角数字→半角
  function toHalfWidth(s) {
    return String(s).replace(/[０-９．，－]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
  }

  // 「1,234」「△1,234」「(1,234)」「-1,234円」等を数値に。数値でなければnull
  function parseNum(raw) {
    if (raw == null) return null;
    var s = toHalfWidth(String(raw)).trim();
    if (s === '') return null;
    var neg = false;
    if (/^[△▲]/.test(s)) { neg = true; s = s.slice(1); }
    var m = s.match(/^\((.*)\)$/);
    if (m) { neg = true; s = m[1]; }
    s = s.replace(/[,，\s]/g, '').replace(/円$/, '').replace(/^[¥￥]/, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    var n = Number(s);
    if (!isFinite(n)) return null;
    if (neg) n = -Math.abs(n);
    return n;
  }

  function fmt(n) {
    if (n == null || !isFinite(n)) return '-';
    var v = Math.round(n);
    return (v < 0 ? '△' : '') + Math.abs(v).toLocaleString('ja-JP');
  }

  function floor100(n) {
    return Math.floor(n / 100) * 100;
  }

  function normKey(s) {
    return String(s || '').replace(/\s+/g, ' ').replace(/[：:]\s*$/, '').trim();
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') e.textContent = attrs[k];
        else if (k === 'class') e.className = attrs[k];
        else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var orig = btn.textContent;
      btn.textContent = 'コピーしました';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    }, function () {
      btn.textContent = 'コピー失敗（手動で選択してください）';
    });
  }

  /* ===================== APIキャプチャ受信 ===================== */

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== SOURCE || d.type !== 'capture' || !d.entry) return;
    captures.push(d.entry);
    if (captures.length > MAX_CAPTURES) captures.shift();
    ingestCapture(d.entry);
  });

  /* ===================== 画面スクレイプ ===================== */

  // 画面から事業年度（例: 2025-10-01 〜 2026-09-30）を拾う。見つからなければ ''
  function getPeriod() {
    var text = (document.body ? document.body.textContent : '').slice(0, 30000);
    var m = text.match(/(\d{4}-\d{2}-\d{2})\s*[〜~～]\s*(\d{4}-\d{2}-\d{2})/);
    return m ? (m[1] + ' 〜 ' + m[2]) : '';
  }

  // いま開いている帳票名（例: 別表四（簡易様式））を拾う。見つからなければ ''
  function getSheetName() {
    var root = document.getElementById(ROOT_ID);
    // 1) ナビの選択中項目（選択状態のクラス/属性は環境依存なので広めに拾って絞る)
    var sels = document.querySelectorAll('[aria-selected="true"], [aria-current], [class*="selected"], [class*="active"], [class*="current"]');
    for (var i = 0; i < sels.length; i++) {
      if (root && root.contains(sels[i])) continue;
      var t = normKey(sels[i].textContent);
      if (t && t.length <= 40 && /別表|様式|付表|明細書|内訳|決算書|概況|納付書|申告書/.test(t)) return t;
    }
    // 2) プレビュー内の見出し
    var heads = document.querySelectorAll('h1, h2, h3');
    for (var j = 0; j < heads.length; j++) {
      if (root && root.contains(heads[j])) continue;
      var h = normKey(heads[j].textContent);
      if (h && h.length <= 60 && /別表|様式|付表|明細書|計算書|内訳|決算書|概況/.test(h)) return h;
    }
    return '';
  }

  // 現在の画面から「ラベル + 値」のペアを汎用収集する
  function scrapeScreen() {
    var items = [];
    var keyCount = {};

    function add(key, raw) {
      if (items.length >= MAX_ITEMS) return;
      key = normKey(key);
      raw = String(raw == null ? '' : raw).trim();
      if (!key || key.length > 120 || raw === '') return;
      keyCount[key] = (keyCount[key] || 0) + 1;
      var finalKey = keyCount[key] > 1 ? key + ' (' + keyCount[key] + ')' : key;
      items.push({ k: finalKey, v: raw, n: parseNum(raw) });
    }

    function labelFor(input) {
      if (input.labels && input.labels.length) return input.labels[0].textContent;
      var aria = input.getAttribute('aria-label');
      if (aria) return aria;
      var lb = input.getAttribute('aria-labelledby');
      if (lb) {
        var t = lb.split(/\s+/).map(function (id) {
          var n = document.getElementById(id);
          return n ? n.textContent : '';
        }).join(' ').trim();
        if (t) return t;
      }
      // 同じ行(tr)の見出しセルを探す
      var tr = input.closest('tr');
      if (tr) {
        var th = tr.querySelector('th');
        if (th && th.textContent.trim()) return th.textContent;
        var firstTd = tr.querySelector('td');
        if (firstTd && !firstTd.contains(input) && firstTd.textContent.trim()) return firstTd.textContent;
      }
      return input.getAttribute('placeholder') || input.getAttribute('name') || '';
    }

    var root = document.getElementById(ROOT_ID);

    // 1) 入力欄（申告書の編集画面）
    var inputs = document.querySelectorAll('input:not([type=hidden]):not([type=password]), textarea, select');
    Array.prototype.forEach.call(inputs, function (input) {
      if (root && root.contains(input)) return;
      var v;
      if (input.tagName === 'SELECT') {
        v = input.selectedOptions && input.selectedOptions[0] ? input.selectedOptions[0].textContent : '';
      } else if (input.type === 'checkbox' || input.type === 'radio') {
        if (!input.checked) return;
        v = input.value === 'on' ? 'checked' : input.value;
      } else {
        v = input.value;
      }
      if (v == null || String(v).trim() === '') return;
      add(labelFor(input), v);
    });

    // 2) 表のセル（プレビュー・一覧画面）
    Array.prototype.forEach.call(document.querySelectorAll('table tr'), function (tr) {
      if (root && root.contains(tr)) return;
      if (tr.querySelector('input, textarea, select')) return; // 入力行は1)で拾済み
      var cells = tr.querySelectorAll('th, td');
      if (cells.length < 2) return;
      var label = '';
      var values = [];
      Array.prototype.forEach.call(cells, function (cell) {
        var text = cell.textContent.trim();
        if (text === '') return;
        if (parseNum(text) == null && !label) label = text;
        else if (parseNum(text) != null) values.push(text);
      });
      if (!label || values.length === 0) return;
      values.forEach(function (v, i) {
        add(values.length > 1 ? label + ' [' + (i + 1) + ']' : label, v);
      });
    });

    // 3) 定義リスト（dl/dt/dd）
    Array.prototype.forEach.call(document.querySelectorAll('dl'), function (dl) {
      if (root && root.contains(dl)) return;
      var dts = dl.querySelectorAll('dt');
      Array.prototype.forEach.call(dts, function (dt) {
        var dd = dt.nextElementSibling;
        if (dd && dd.tagName === 'DD' && dd.textContent.trim()) add(dt.textContent, dd.textContent);
      });
    });

    return {
      url: location.href,
      title: document.title,
      sheet: getSheetName(),
      period: getPeriod(),
      savedAt: new Date().toISOString(),
      items: items
    };
  }

  /* ===================== スナップショット保存 ===================== */

  function loadSnapshots(cb) {
    chrome.storage.local.get([SNAP_KEY], function (res) {
      cb((res && res[SNAP_KEY]) || []);
    });
  }

  function saveSnapshots(snaps, cb) {
    var obj = {};
    obj[SNAP_KEY] = snaps.slice(-MAX_SNAPSHOTS);
    chrome.storage.local.set(obj, cb || function () {});
  }

  // 手動保存＋自動保存をまとめて取得
  function loadAllSnapshots(cb) {
    chrome.storage.local.get([SNAP_KEY, AUTO_KEY], function (res) {
      var manual = (res && res[SNAP_KEY]) || [];
      var auto = (res && res[AUTO_KEY]) || [];
      cb(manual.concat(auto));
    });
  }

  function sheetKeyOf(s) {
    return normKey(s.sheet || s.title || '');
  }

  // 同じ帳票 × 前の事業年度のスナップショットを自動で探す（直前期・最新保存を優先）
  function findPrevSnapshot(cur, snaps) {
    if (!cur.period) return null;
    var key = sheetKeyOf(cur);
    if (!key) return null;
    var cands = snaps.filter(function (s) {
      return sheetKeyOf(s) === key && s.period && s.period < cur.period;
    });
    if (cands.length === 0) return null;
    cands.sort(function (a, b) {
      if (a.period !== b.period) return a.period < b.period ? -1 : 1;
      return (a.savedAt || '') < (b.savedAt || '') ? -1 : 1;
    });
    return cands[cands.length - 1];
  }

  // 画面を開くだけで裏で自動保存（帳票名×事業年度をキーに上書き）
  function autoSnapshot() {
    var snap;
    try {
      snap = scrapeScreen();
    } catch (e) {
      return;
    }
    if (!snap.period) return;
    var numeric = snap.items.filter(function (it) { return it.n != null; }).length;
    if (numeric < 3) return;
    var akey = sheetKeyOf(snap) + '|' + snap.period;
    if (!sheetKeyOf(snap)) return;
    snap.auto = true;
    snap.id = 'auto_' + Date.now();
    snap.name = '自動保存_' + (snap.sheet || snap.title).slice(0, 40);
    chrome.storage.local.get([AUTO_KEY], function (res) {
      var list = (res && res[AUTO_KEY]) || [];
      list = list.filter(function (s) { return (sheetKeyOf(s) + '|' + s.period) !== akey; });
      list.push(snap);
      var obj = {};
      obj[AUTO_KEY] = list.slice(-MAX_AUTO_SNAPSHOTS);
      chrome.storage.local.set(obj, function () {
        showToast('🌸 読み取り完了: ' + (snap.sheet || snap.title) + '（' + snap.period + '）', 'auto|' + akey);
      });
    });
  }

  /* ===================== 内部API（読み取り専用・GETのみ） ===================== */
  // freee申告の内部APIをGETだけで使う。書き込み（PUT/POST/DELETE）は一切しない。
  // 年度切替（PUT ctax_return_current）も呼ばない設計。前期データは
  //   (a) 前期画面を開いたときの受動キャプチャ解析（ingestCapture）
  //   (b) 前期IDつきGETの試行（probePriorSheet。期間検証に合格したときだけ採用）
  // の2経路で手に入れる。
  // v0.4: 消費税（consumption）と法人税（corporate）の両方に対応。
  //   消費税: sheets/{code} に item_def が同梱。values は default_group 主体
  //   法人税: sheets/{code} は値のみ（values は「グループ名→{itemName:値}」の入れ子）。
  //           項目定義は sheets/{code}/item_defs を別途取得。itemKey は「グループ__itemName」

  var API_KEY = 'fss:api-sheets';
  var MAX_API_SNAPSHOTS = 120;
  var CONS = 'consumption';
  var CORP = 'corporate';

  function apiBase(kind) {
    return '/ctax/api/p/' + kind + '/';
  }

  // sheets系エンドポイントは「選択中の申告ID」を x-ctax-return-id ヘッダーで要求する
  // （無いと500。IDがサーバー側の選択中申告と食い違うと400「選択している申告が切り替わっています」。2026-08-26実測）
  function apiGet(path, ctaxReturnId) {
    var headers = { 'Accept': 'application/json' };
    if (ctaxReturnId != null) headers['x-ctax-return-id'] = String(ctaxReturnId);
    return fetch(path, { credentials: 'same-origin', headers: headers })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
  }

  function fetchCurrentReturnK(kind) {
    return apiGet(apiBase(kind) + 'ctax_return_current').then(function (d) {
      return (d && d.ctax_return) || d;
    });
  }

  function fetchReturnsListK(kind) {
    return apiGet(apiBase(kind) + 'ctax_returns?page=1&limit=50').then(function (d) {
      if (d && Array.isArray(d.ctax_returns)) return d.ctax_returns;
      return Array.isArray(d) ? d : [];
    });
  }

  function fetchSheetList(ctaxReturnId) {
    return apiGet('/ctax/api/p/consumption/sheets', ctaxReturnId).then(function (d) {
      var arr = Array.isArray(d) ? d : ((d && d.sheets) || []);
      return arr.filter(function (s) {
        var cat = s && s.sheet_master && s.sheet_master.category;
        return typeof cat === 'string' && cat.indexOf('consumption_tax') === 0;
      });
    });
  }

  function fetchSheetRaw(code, ctaxReturnId) {
    return apiGet('/ctax/api/p/consumption/sheets/' + code, ctaxReturnId);
  }

  // 法人税の有効帳票コード一覧。realtime_schema_errors が有効帳票のぶんだけ返るのを利用する。
  // 比較対象は別表類（1xxxxxxx）と地方税様式（2xxxxxxxx）のみ。内訳書・納付書・概況書・委任状は除外
  function fetchCorpSheetCodes(ctaxReturnId) {
    return apiGet(apiBase(CORP) + 'realtime_schema_errors', ctaxReturnId).then(function (d) {
      var arr = Array.isArray(d) ? d : ((d && d.realtime_schema_errors) || []);
      return arr.map(function (x) { return x && x.sheet_code; }).filter(function (c) {
        var n = Number(c);
        return (n >= 10000000 && n < 100000000) || (n >= 200000000 && n < 300000000);
      });
    });
  }

  // 法人税の項目定義（itemKey→def）。ページをまたいで1つのマップへ統合する。ラベル表示専用
  function fetchCorpDefs(code, ctaxReturnId) {
    return apiGet(apiBase(CORP) + 'sheets/' + code + '/item_defs?start_page=0&end_page=19', ctaxReturnId).then(function (d) {
      var map = {};
      var pages = (d && d.item_defs) || {};
      Object.keys(pages).forEach(function (p) {
        var defs = pages[p] || {};
        Object.keys(defs).forEach(function (k) {
          if (!map[k]) map[k] = defs[k];
        });
      });
      return map;
    }).catch(function () { return {}; });
  }

  // 消費税は tax_period_*、法人税は start_date/end_date（時刻つきISO）と項目名が違う
  function returnPeriodOf(ret) {
    if (!ret) return '';
    var s = ret.tax_period_start_date || (ret.start_date ? String(ret.start_date).slice(0, 10) : '');
    var e = ret.tax_period_end_date || (ret.end_date ? String(ret.end_date).slice(0, 10) : '');
    return (s && e) ? (s + ' 〜 ' + e) : '';
  }

  function pad2(v) {
    var s = String(Number(v));
    return s.length < 2 ? '0' + s : s;
  }

  // 令和yy年→西暦。申告書の期間欄（yy/mm/dd分割項目）から期間文字列を組み立てる
  function reiwaDate(yy, mm, dd) {
    if (yy == null || yy === '' || mm == null || mm === '' || dd == null || dd === '') return null;
    return (2018 + Number(yy)) + '-' + pad2(mm) + '-' + pad2(dd);
  }

  // 元号コードつき和暦→西暦（3=昭和 / 4=平成 / 5=令和。法人税の fiscal_year_items 用）
  function eraDate(era, yy, mm, dd) {
    var bases = { 3: 1925, 4: 1988, 5: 2018 };
    var base = bases[Number(era)];
    if (!base || yy == null || yy === '' || mm == null || mm === '' || dd == null || dd === '') return null;
    return (base + Number(yy)) + '-' + pad2(mm) + '-' + pad2(dd);
  }

  // 法人税帳票の事業年度欄（fiscal_year_items）から期間文字列を組み立てる。無い帳票は ''
  function periodFromCorpValues(values) {
    var f = values && values.fiscal_year_items;
    if (!f) return '';
    var s = eraDate(f.fiscal_start_era, f.fiscal_start_year, f.fiscal_start_month, f.fiscal_start_day);
    var e = eraDate(f.fiscal_end_era, f.fiscal_end_year, f.fiscal_end_month, f.fiscal_end_day);
    return (s && e) ? (s + ' 〜 ' + e) : '';
  }

  // 第一表（aai00130〜aai00140）または第二表（aan00100〜aan00110）の課税期間欄から
  // 「YYYY-MM-DD 〜 YYYY-MM-DD」を組み立てる。読めなければ ''
  function periodFromSheetValues(values) {
    var g = (values && values.default_group) || {};
    var pairs = [['aai00130', 'aai00140'], ['aan00100', 'aan00110']];
    for (var i = 0; i < pairs.length; i++) {
      var s = reiwaDate(g[pairs[i][0] + '_yy'], g[pairs[i][0] + '_mm'], g[pairs[i][0] + '_dd']);
      var e = reiwaDate(g[pairs[i][1] + '_yy'], g[pairs[i][1] + '_mm'], g[pairs[i][1] + '_dd']);
      if (s && e) return s + ' 〜 ' + e;
    }
    return '';
  }

  // sheets/{code} のレスポンスを「itemKey→値」の比較用スナップショットへ変換
  function parseSheetApi(data, codeFallback) {
    if (!data || !data.sheet_master || !data.sheet_pages) return null;
    var values = data.values || {};
    var items = [];
    (data.sheet_pages || []).forEach(function (page) {
      var defs = page.item_def || {};
      var pageCode = page.page_code || 0;
      Object.keys(defs).forEach(function (itemKey) {
        var def = defs[itemKey];
        if (!def || def.columnGroup === 'timestamp') return;
        var group = values[def.columnGroup];
        if (!group) return;
        var v = group[def.itemName];
        if (v == null || v === '') return;
        if ((def.itemType === 'radioBtn' || def.itemType === 'checkBox') && Number(v) === 0) return;
        items.push({
          k: itemKey + '@p' + pageCode,
          label: (def.itemTitle || def.itemName || itemKey) + (pageCode ? ' [p' + (pageCode + 1) + ']' : ''),
          v: String(v),
          n: (typeof v === 'number') ? v : parseNum(v)
        });
      });
    });
    return {
      taxKind: 'consumption',
      sheetCode: data.sheet_master.sheet_code || codeFallback,
      sheetTitle: data.sheet_master.title || '',
      sheetName: data.sheet_master.name || '',
      period: periodFromSheetValues(values),
      items: items,
      savedAt: new Date().toISOString()
    };
  }

  // 法人税 sheets/{code} のレスポンスを比較用スナップショットへ変換。
  // values は「グループ名→{itemName:値}」の入れ子（明細行はグループが配列になることがある）。
  // itemKey は「グループ__itemName」= item_defs のキーと同じ形式にそろえる
  function parseCorpSheetApi(data, codeFallback) {
    if (!data || !data.sheet_master || !data.values) return null;
    var items = [];
    var values = data.values;
    function pushItem(key, v) {
      if (v == null || v === '' || typeof v === 'object') return;
      if (typeof v === 'boolean') v = v ? 1 : 0;
      items.push({ k: key, label: '', v: String(v), n: (typeof v === 'number') ? v : parseNum(v) });
    }
    Object.keys(values).forEach(function (group) {
      if (group === 'timestamp') return;
      var g = values[group];
      if (!g || typeof g !== 'object') return;
      if (Array.isArray(g)) {
        g.forEach(function (row, idx) {
          if (!row || typeof row !== 'object') return;
          Object.keys(row).forEach(function (name) {
            pushItem(group + '[' + (idx + 1) + ']__' + name, row[name]);
          });
        });
        return;
      }
      Object.keys(g).forEach(function (name) { pushItem(group + '__' + name, g[name]); });
    });
    return {
      taxKind: CORP,
      sheetCode: data.sheet_master.sheet_code || codeFallback,
      sheetTitle: data.sheet_master.title || '',
      sheetName: data.sheet_master.name || '',
      period: periodFromCorpValues(values),
      items: items,
      savedAt: new Date().toISOString()
    };
  }

  // item_defs の itemTitle でスナップショットの表示ラベルを埋める（明細行は行番号つき）
  function fillCorpLabels(snap, defsMap) {
    if (!snap || !snap.items || !defsMap) return;
    snap.items.forEach(function (it) {
      if (it.label) return;
      var m = it.k.match(/^(.+?)\[(\d+)\]__(.+)$/);
      var def = m ? defsMap[m[1] + '__' + m[3]] : defsMap[it.k];
      if (def && def.itemTitle) it.label = def.itemTitle + (m ? '（' + m[2] + '行目）' : '');
    });
  }

  // itemTitle が正規表現に合う項目の値を探す（別表一の税額欄などをタイトルで特定する用）
  function findCorpValueByTitle(snap, defsMap, includeRe, excludeRe) {
    var byKey = {};
    (snap && snap.items || []).forEach(function (it) { byKey[it.k] = it; });
    var keys = Object.keys(defsMap || {});
    for (var i = 0; i < keys.length; i++) {
      var def = defsMap[keys[i]];
      var title = def && def.itemTitle;
      if (!title || !includeRe.test(title)) continue;
      if (excludeRe && excludeRe.test(title)) continue;
      var it = byKey[keys[i]];
      if (it && it.n != null) return { key: keys[i], title: title, n: it.n };
    }
    return null;
  }

  // itemKey 直指定で値を取る（実キャプチャで確認済みのキー用）
  function corpItemN(snap, key) {
    var arr = (snap && snap.items) || [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].k === key) return arr[i].n;
    }
    return null;
  }

  function apiSnapKey(s) {
    return s.taxKind + '|' + s.sheetCode + '|' + s.period;
  }

  function loadApiSnaps(cb) {
    chrome.storage.local.get([API_KEY], function (res) {
      cb((res && res[API_KEY]) || []);
    });
  }

  function saveApiSnap(snap) {
    if (!snap || !snap.sheetCode || !snap.period) return;
    var key = apiSnapKey(snap);
    chrome.storage.local.get([API_KEY], function (res) {
      var list = (res && res[API_KEY]) || [];
      list = list.filter(function (s) { return apiSnapKey(s) !== key; });
      list.push(snap);
      var obj = {};
      obj[API_KEY] = list.slice(-MAX_API_SNAPSHOTS);
      chrome.storage.local.set(obj);
    });
  }

  // 受動キャプチャ: ページ自身が呼んだ sheets/{code} レスポンスを構造化して保存する。
  // 前期に切り替えて帳票を開くだけで前期データが手に入る（拡張からの追加リクエストなし）。
  // v0.4: 消費税・法人税の両方を観測する
  var lastKnownReturnPeriod = { consumption: '', corporate: '' };

  function ingestCapture(entry) {
    try {
      if (!entry || entry.status !== 200 || !entry.body || entry.truncated) return;
      var path = String(entry.url || '').replace(/^https?:\/\/[^/]+/, '');
      var mc = path.match(/^\/ctax\/api\/p\/(consumption|corporate)\/ctax_return_current(?:\?|$)/);
      if (mc) {
        var cur = JSON.parse(entry.body);
        cur = (cur && cur.ctax_return) || cur;
        var p = returnPeriodOf(cur);
        if (p) lastKnownReturnPeriod[mc[1]] = p;
        return;
      }
      if (entry.method !== 'GET') return;
      var m = path.match(/^\/ctax\/api\/p\/(consumption|corporate)\/sheets\/(\d+)(?:\?|$)/);
      if (!m) return;
      var kind = m[1];
      var snap = (kind === CORP)
        ? parseCorpSheetApi(JSON.parse(entry.body), m[2])
        : parseSheetApi(JSON.parse(entry.body), m[2]);
      if (!snap || snap.items.length === 0) return;
      if (!snap.period) snap.period = lastKnownReturnPeriod[kind];
      if (!snap.period) return;
      snap.source = 'passive';
      saveApiSnap(snap);
      showToast('🌸 読み取り完了(API): ' + (snap.sheetTitle || snap.sheetName || snap.sheetCode) + '（' + snap.period + '）', 'api|' + apiSnapKey(snap));
    } catch (e) { /* 解析できないレスポンスは無視 */ }
  }

  // 前期データの能動取得を試す（読み取りGETのみ・年度切替のPUTはしない）。
  // freee側は x-ctax-return-id と「選択中の申告」の一致を検証していて、前期IDは通常400で弾かれる
  // （= 年度切替なしの能動取得は不可。2026-08-26実測）。通った環境でだけ、期間検証に合格したら採用する
  function probePriorSheet(kind, priorReturn, code) {
    var priorPeriod = returnPeriodOf(priorReturn);
    if (!priorPeriod || !priorReturn.id) return Promise.resolve(null);
    return apiGet(apiBase(kind) + 'sheets/' + code, priorReturn.id).then(function (data) {
      var snap = (kind === CORP) ? parseCorpSheetApi(data, code) : parseSheetApi(data, code);
      if (snap && snap.items.length > 0 && snap.period === priorPeriod) {
        snap.source = 'probe';
        saveApiSnap(snap);
        return snap;
      }
      return null;
    }).catch(function () { return null; });
  }

  // 課税期間の月数を概算（12ヶ月決算かどうかの判定用）
  function monthsBetween(startDate, endDate) {
    if (!startDate || !endDate) return null;
    var s = new Date(startDate);
    var e = new Date(endDate);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return null;
    return Math.round((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24 * 30.4));
  }

  function describeTaxMethod(method) {
    var map = {
      full_deduction: '本則課税（全額控除）',
      individual: '本則課税（個別対応方式）',
      proportional: '本則課税（一括比例配分方式）',
      simplified: '簡易課税',
      simple: '簡易課税',
      general_special_20: '2割特例'
    };
    return map[method] || method || '不明';
  }

  /* ===================== トースト通知 ===================== */
  // 読み取り（自動保存）が成功したことを画面右下に一瞬表示する。
  // 同じ帳票×期間の連続保存では出さない（15秒デデュープ）
  var toastShownAt = {};

  function showToast(msg, dedupeKey) {
    var now = Date.now();
    if (dedupeKey) {
      if (toastShownAt[dedupeKey] && now - toastShownAt[dedupeKey] < 15000) return;
      toastShownAt[dedupeKey] = now;
    }
    ensureRoot();
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    var box = document.getElementById('fss-toasts');
    if (!box) {
      box = el('div', { id: 'fss-toasts' });
      root.appendChild(box);
    }
    var t = el('div', { class: 'fss-toast', text: msg });
    box.appendChild(t);
    setTimeout(function () { t.className = 'fss-toast fss-toast-show'; }, 30);
    setTimeout(function () {
      t.className = 'fss-toast';
      setTimeout(function () { if (t.parentNode) t.remove(); }, 400);
    }, 3500);
  }

  /* ===================== パネル共通 ===================== */

  var PANEL_W_KEY = 'fss:panel-width';

  // パネル左端のドラッグで幅を変えられるようにする（決めた幅は保存して次回も使う）
  function enablePanelResize(panel) {
    var handle = panel.querySelector('.fss-resize');
    if (!handle) return;
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startX = e.clientX;
      var startW = panel.getBoundingClientRect().width;
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        var w = startW + (startX - ev.clientX);
        var max = Math.floor(window.innerWidth * 0.95);
        if (w < 380) w = 380;
        if (w > max) w = max;
        panel.style.width = w + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
        var obj = {};
        obj[PANEL_W_KEY] = Math.round(panel.getBoundingClientRect().width);
        chrome.storage.local.set(obj);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function closePanel() {
    var p = document.getElementById(PANEL_ID);
    if (p) p.remove();
  }

  function openPanel(tab) {
    currentTab = tab || currentTab;
    closePanel();

    var body = el('div', { class: 'fss-panel-body' });
    var tabs = [
      { id: 'compare', label: '前年比較' },
      { id: 'yotei', label: '予定納税試算' },
      { id: 'dev', label: '⚙ 開発情報' }
    ];
    var nav = el('div', { class: 'fss-tabs' }, tabs.map(function (t) {
      return el('button', {
        class: 'fss-tab' + (t.id === currentTab ? ' fss-tab-active' : ''),
        text: t.label,
        onclick: function () { openPanel(t.id); }
      });
    }));

    var panel = el('div', { id: PANEL_ID }, [
      el('div', { class: 'fss-resize', title: 'ドラッグで幅を調整' }),
      el('div', { class: 'fss-panel-header' }, [
        el('span', { class: 'fss-panel-title', text: 'freee申告サポート' }),
        el('button', { class: 'fss-close', text: '×', onclick: closePanel })
      ]),
      nav,
      body
    ]);
    document.getElementById(ROOT_ID).appendChild(panel);

    // 前回ドラッグで決めた幅を復元
    chrome.storage.local.get([PANEL_W_KEY], function (res) {
      var w = res && res[PANEL_W_KEY];
      if (w) panel.style.width = Math.min(w, Math.floor(window.innerWidth * 0.95)) + 'px';
    });
    enablePanelResize(panel);

    if (currentTab === 'compare') renderCompare(body);
    else if (currentTab === 'yotei') renderYotei(body);
    else renderDev(body);
  }

  function note(text) {
    return el('p', { class: 'fss-note', text: text });
  }

  /* ===================== ① 前年比較 ===================== */

  // 前期の申告を特定する。prev_ctax_return_id（法人税）があれば最優先、無ければ日付で判定
  function findPriorReturn(cur, returns) {
    var i;
    var curInList = null;
    for (i = 0; i < returns.length; i++) {
      if (returns[i] && returns[i].id === cur.id) curInList = returns[i];
    }
    var prevId = (curInList && curInList.prev_ctax_return_id) || cur.prev_ctax_return_id;
    if (prevId) {
      for (i = 0; i < returns.length; i++) {
        if (returns[i] && returns[i].id === prevId) return returns[i];
      }
    }
    var curStart = cur.tax_period_start_date || String(cur.start_date || '').slice(0, 10);
    if (!curStart) return null;
    var priors = returns.filter(function (r) {
      var end = r && (r.tax_period_end_date || String(r.end_date || '').slice(0, 10));
      return end && end < curStart;
    }).sort(function (a, b) {
      var ea = a.tax_period_end_date || String(a.end_date || '').slice(0, 10);
      var eb = b.tax_period_end_date || String(b.end_date || '').slice(0, 10);
      return ea < eb ? -1 : 1;
    });
    return priors[priors.length - 1] || null;
  }

  // 当期の比較対象帳票を [{code, title}] で返す（税目別の取得方法の差を吸収）
  function fetchComparableSheets(kind, cur) {
    if (kind === CORP) {
      return fetchCorpSheetCodes(cur.id).then(function (codes) {
        return codes.map(function (c) { return { code: c, title: '' }; });
      });
    }
    return fetchSheetList(cur.id).then(function (sheets) {
      return sheets.map(function (s) {
        return {
          code: s.sheet_code || (s.sheet_master && s.sheet_master.sheet_code),
          title: (s.sheet_master && (s.sheet_master.title || s.sheet_master.name)) || ''
        };
      });
    });
  }

  // 指定税目でのAPI比較を試す。データが無ければrejectして呼び出し側が次の税目へ進む
  function runCompareApi(kind, apiArea) {
    return Promise.all([fetchCurrentReturnK(kind), fetchReturnsListK(kind)]).then(function (res) {
      var cur = res[0];
      var returns = res[1];
      if (!cur || !cur.id) throw new Error('no current return');
      var curPeriod = returnPeriodOf(cur);
      if (!curPeriod) throw new Error('no period');
      return fetchComparableSheets(kind, cur).then(function (sheetInfos) {
        sheetInfos = sheetInfos.filter(function (s) { return s.code; });
        if (sheetInfos.length === 0) throw new Error('no sheets');
        renderCompareApiResults(kind, apiArea, cur, curPeriod, returns, sheetInfos);
      });
    });
  }

  function renderCompareApiResults(kind, apiArea, cur, curPeriod, returns, sheetInfos) {
    var kindLabel = (kind === CORP) ? '法人税' : '消費税';
    var prior = findPriorReturn(cur, returns);
    var priorPeriod = prior ? returnPeriodOf(prior) : '';

    apiArea.textContent = '';
    apiArea.appendChild(el('p', {
      class: 'fss-summary',
      text: kindLabel + '申告の前年比較（内部API）: 当期 ' + curPeriod + (prior ? ' ⇔ 前期 ' + priorPeriod : '')
    }));

    if (!prior) {
      apiArea.appendChild(note('freee申告に前期（' + curPeriod + ' より前）の申告書が見つからなかったよ。初年度はここまで！'));
      return;
    }

    if (kind === CONS) {
      var curMethod = cur.basic_info && cur.basic_info.tax_method;
      var priorMethod = prior.basic_info && prior.basic_info.tax_method;
      if (curMethod !== priorMethod) {
        apiArea.appendChild(note('課税方式が前期と変わってるよ: 前期「' + describeTaxMethod(priorMethod) + '」→ 当期「' + describeTaxMethod(curMethod) + '」。付表の構成が変わるから、増減には方式変更の影響も含まれるよ。'));
      }
    }

    loadApiSnaps(function (snaps) {
      sheetInfos.forEach(function (s) {
        var code = s.code;
        var sec = el('div');
        apiArea.appendChild(sec);
        var head = el('h3', { class: 'fss-h3', text: s.title || ('帳票 ' + code) });
        sec.appendChild(head);
        var slot = el('div');
        sec.appendChild(slot);
        slot.appendChild(note('取得中…'));

        // 法人税は項目定義（ラベル）を別エンドポイントから取り、当期・前期両方のラベルに使う
        var defsPromise = (kind === CORP) ? fetchCorpDefs(code, cur.id) : Promise.resolve(null);
        Promise.all([apiGet(apiBase(kind) + 'sheets/' + code, cur.id), defsPromise]).then(function (rr) {
          var curSnap = (kind === CORP) ? parseCorpSheetApi(rr[0], code) : parseSheetApi(rr[0], code);
          var defsMap = rr[1];
          if (!curSnap || curSnap.items.length === 0) throw new Error('empty');
          if (!curSnap.period) curSnap.period = curPeriod;
          curSnap.source = 'active';
          saveApiSnap(curSnap); // 当期分も保存 → 来期の前年比較にそのまま使える
          if (!s.title && curSnap.sheetTitle) head.textContent = curSnap.sheetTitle;
          if (defsMap) fillCorpLabels(curSnap, defsMap);

          var stored = null;
          for (var i = 0; i < snaps.length; i++) {
            var x = snaps[i];
            if (x.taxKind === kind && String(x.sheetCode) === String(code) && x.period === priorPeriod) stored = x;
          }
          var prevPromise = stored ? Promise.resolve(stored) : probePriorSheet(kind, prior, code);
          return prevPromise.then(function (prev) {
            if (prev && defsMap) fillCorpLabels(prev, defsMap);
            return { prev: prev, cur: curSnap };
          });
        }).then(function (pair) {
          slot.textContent = '';
          if (!pair.prev) {
            slot.appendChild(note('前期のこの帳票のデータがまだ手元にないよ。freee申告の年度切替で前期を開いて、この帳票を一度表示すると自動保存されて、次からはボタン1発で比較できるよ。'));
            return;
          }
          renderCompareResult(slot, pair.prev, pair.cur);
        }).catch(function () {
          slot.textContent = '';
          slot.appendChild(note('この帳票はAPIから取得できなかったよ。'));
        });
      });
    });
  }

  // v0.3: freee内部API（GETのみ）で当期・前期の申告データを取得してボタン1発比較。
  // v0.4: 法人税にも対応（画面タイトルから税目を推定→ダメならもう片方→両方ダメなら画面読み取り）
  function renderCompare(body) {
    // 別表を直したあとに読み取り直したいケース用。当期はAPI再取得、前期は最新の保存分で再比較する
    body.appendChild(el('div', { class: 'fss-row' }, [
      el('button', {
        class: 'fss-btn', text: '🔄 更新（最新データで再比較）',
        onclick: function () { body.textContent = ''; renderCompare(body); }
      })
    ]));

    var apiArea = el('div');
    body.appendChild(apiArea);
    apiArea.appendChild(note('freee内部API（読み取りのみ）から申告データを取得中…'));

    var legacyWrap = el('details', { class: 'fss-manual' }, [
      el('summary', { text: '画面読み取り方式で比較する（v0.2方式・API不調のとき用）' })
    ]);
    var legacyBody = el('div');
    legacyWrap.appendChild(legacyBody);
    body.appendChild(legacyWrap);
    var legacyLoaded = false;
    function loadLegacy() {
      if (legacyLoaded) return;
      legacyLoaded = true;
      renderCompareLegacy(legacyBody);
    }
    legacyWrap.addEventListener('toggle', function () { if (legacyWrap.open) loadLegacy(); });

    // 画面タイトルから税目を推定して、その税目→もう片方の順でAPI比較を試す
    var kinds = /消費/.test(document.title) ? [CONS, CORP] : [CORP, CONS];
    runCompareApi(kinds[0], apiArea).catch(function () {
      return runCompareApi(kinds[1], apiArea);
    }).catch(function () {
      apiArea.textContent = '';
      apiArea.appendChild(note('内部APIから申告データを取得できなかったから、画面読み取り方式（v0.2）で比較するね。'));
      legacyWrap.open = true;
      loadLegacy();
    });
  }

  // v0.2の画面読み取り方式（フォールバック・手動保存も内包）
  function renderCompareLegacy(body) {
    var current = scrapeScreen();
    var autoArea = el('div');
    body.appendChild(autoArea);

    loadAllSnapshots(function (snaps) {
      // 自動比較: 同じ帳票×前の事業年度を勝手に探して即実行
      var prev = findPrevSnapshot(current, snaps);
      if (prev) {
        autoArea.appendChild(el('p', {
          class: 'fss-summary',
          text: '前年データを自動で見つけたよ: ' + (prev.sheet || prev.name || prev.title) + '（' + prev.period + '）→ 当期（' + (current.period || '期間不明') + '）と比較'
        }));
        var resArea = el('div');
        autoArea.appendChild(resArea);
        renderCompareResult(resArea, prev, current);
      } else if (!current.period) {
        autoArea.appendChild(note('この画面から事業年度が読み取れなかったから自動比較できなかったよ。下の手動比較を使ってね。'));
      } else {
        autoArea.appendChild(note('前年（' + current.period + ' より前の事業年度）の「' + (current.sheet || current.title) + '」のデータがまだないよ。前年の申告書で同じ帳票の画面を一度開くだけで自動保存されるから、開いてからもう一度このボタンを押してね。'));
      }

      // 手動での保存・比較（フォールバック用に折りたたみで残す）
      var manual = el('details', { class: 'fss-manual' }, [
        el('summary', { text: '手動で保存・比較する（自動でうまくいかないとき用）' })
      ]);
      body.appendChild(manual);

      var saveRow = el('div', { class: 'fss-row' });
      var nameInput = el('input', { class: 'fss-input', type: 'text', value: '前年_' + current.title.slice(0, 40) });
      saveRow.appendChild(nameInput);
      saveRow.appendChild(el('button', {
        class: 'fss-btn fss-btn-primary', text: 'この画面を保存',
        onclick: function () {
          var snap = scrapeScreen();
          snap.id = 'snap_' + Date.now();
          snap.name = nameInput.value.trim() || snap.title;
          loadSnapshots(function (list) {
            list.push(snap);
            saveSnapshots(list, function () { openPanel('compare'); });
          });
        }
      }));
      manual.appendChild(saveRow);

      if (snaps.length === 0) {
        manual.appendChild(note('保存済みの画面がまだないよ。'));
        return;
      }

      var selRow = el('div', { class: 'fss-row' });
      var select = el('select', { class: 'fss-input' }, snaps.slice().reverse().map(function (s) {
        var d = (s.savedAt || '').slice(0, 10);
        var label = (s.auto ? '[自動] ' : '') + (s.name || s.title) + '（' + (s.period || d) + '・' + s.items.length + '項目）';
        return el('option', { value: s.id, text: label });
      }));
      selRow.appendChild(select);
      selRow.appendChild(el('button', {
        class: 'fss-btn', text: '削除',
        onclick: function () {
          var id = select.value;
          chrome.storage.local.get([SNAP_KEY, AUTO_KEY], function (res) {
            var obj = {};
            obj[SNAP_KEY] = ((res && res[SNAP_KEY]) || []).filter(function (s) { return s.id !== id; });
            obj[AUTO_KEY] = ((res && res[AUTO_KEY]) || []).filter(function (s) { return s.id !== id; });
            chrome.storage.local.set(obj, function () { openPanel('compare'); });
          });
        }
      }));
      manual.appendChild(selRow);

      var resultArea = el('div');
      manual.appendChild(el('div', { class: 'fss-row' }, [
        el('button', {
          class: 'fss-btn fss-btn-primary', text: '現在の画面と比較する',
          onclick: function () {
            var snap = snaps.filter(function (s) { return s.id === select.value; })[0];
            if (snap) renderCompareResult(resultArea, snap, scrapeScreen());
          }
        })
      ]));
      manual.appendChild(resultArea);
    });
  }

  /* 増減理由の推測（v0.4.1・ルールベース）。
   * 変化パターン（新規発生/消滅/符号反転/大幅増減）と項目ラベルの性質、
   * 課税標準・所得金額との増減率の連動から「見立て」を1行生成する。
   * あくまで機械的な推測なので、結果は必ず「確認事項」扱い（税務判断はしない）。 */
  function explainDiff(m, baseRate, baseLabel) {
    var label = String(m.cur.label || m.prev.label || m.k);
    var p = m.prev.n, c = m.cur.n;
    var d = (p != null && c != null) ? c - p : null;
    var rate = (d != null && p !== 0) ? d / Math.abs(p) : null;
    var big = d != null && Math.abs(d) >= 100000 && (rate == null || Math.abs(rate) >= 0.3);
    var alert = false;
    var reasons = [];

    // 変化パターン。要確認は「税務調整の抜け漏れ疑い」に絞る
    // （金額が大きく動いたこと自体は要確認にしない。2026-08-26 けんとさん指示）
    if (d == null) {
      reasons.push('数値以外の記載変更');
    } else if (p !== 0 && c === 0) {
      reasons.push('前期にあって当期ゼロ。税務調整の抜け漏れがないか');
      alert = true;
    } else if (p === 0 && c !== 0) {
      reasons.push('前年ゼロ→当期発生。今期からの新規項目かも');
    } else if (p != null && c != null && (p > 0) !== (c > 0)) {
      reasons.push('符号が反転（納付⇔還付・加算⇔減算の入替わりかも）');
      alert = true;
    }

    // 項目の性質（ラベルの正規表現で推測）
    if (/期首|期末|繰越|翌期/.test(label)) {
      // 繰越系は期首同士・期末同士の年度間比較の情報価値が低い。整合は下の繰越整合チェックで見る
      reasons.push('繰越系。年度間の増減より繰越整合（前期末↔当期期首）で確認');
      alert = (p !== 0 && c === 0) || (p != null && c != null && (p > 0) !== (c > 0));
    } else if (/中間|予定/.test(label)) {
      reasons.push('前期の確定税額に連動して毎年変わる項目');
    } else if (/均等割/.test(label)) {
      reasons.push('原則一定のはず。資本金等・従業者数・月数の変動を確認');
      alert = true;
    } else if (/課税標準|課税売上|売上/.test(label)) {
      if (d != null && d !== 0) reasons.push(d > 0 ? '売上規模の増加' : '売上規模の減少');
    } else if (/仕入|控除/.test(label)) {
      if (d != null && d !== 0) reasons.push(d > 0 ? '仕入・経費や控除の増加' : '仕入・経費や控除の減少');
    } else if (/交際費|寄附/.test(label)) {
      reasons.push('支出額の増減。限度額計算への影響を確認');
    } else if (/当期利益|所得金額|欠損/.test(label)) {
      if (d != null && d !== 0) reasons.push(d > 0 ? '業績（利益）の増加' : '業績（利益）の減少');
    } else if (baseRate != null && rate != null && Math.abs(rate - baseRate) <= 0.1) {
      reasons.push(baseLabel + 'の増減とほぼ同率（連動とみられる）');
    }

    if (reasons.length === 0) {
      reasons.push(big ? '増減が大きい。取引内容の変化を確認' : (d != null && d > 0 ? '増加' : '減少'));
    }
    return { text: reasons.join('。'), alert: alert };
  }

  function renderCompareResult(area, prev, cur) {
    area.textContent = '';

    var prevMap = {};
    prev.items.forEach(function (it) { prevMap[it.k] = it; });

    var matched = [];
    var curOnly = [];
    cur.items.forEach(function (it) {
      if (prevMap[it.k]) {
        matched.push({ k: it.k, prev: prevMap[it.k], cur: it });
        delete prevMap[it.k];
      } else {
        curOnly.push(it);
      }
    });
    var prevOnly = Object.keys(prevMap).map(function (k) { return prevMap[k]; });

    var diffs = matched.filter(function (m) { return m.prev.v !== m.cur.v; });
    var sames = matched.length - diffs.length;

    // 連動判定の基準: 課税標準額（消費税）や所得金額（法人税）の増減率
    var baseRate = null, baseLabel = '課税標準';
    diffs.forEach(function (m) {
      if (baseRate != null) return;
      var lb = String(m.cur.label || m.k);
      if (/課税標準額|所得金額/.test(lb) && m.prev.n != null && m.cur.n != null && m.prev.n !== 0) {
        baseRate = (m.cur.n - m.prev.n) / Math.abs(m.prev.n);
        baseLabel = /所得金額/.test(lb) ? '所得金額' : '課税標準';
      }
    });

    var rows = diffs.map(function (m) { return { m: m, ex: explainDiff(m, baseRate, baseLabel) }; });
    var alertCount = rows.filter(function (r) { return r.ex.alert; }).length;

    var sum = el('p', { class: 'fss-summary', text: '一致した項目 ' + matched.length + ' 件（うち差異 ' + diffs.length + ' 件・同額 ' + sames + ' 件）／当期のみ ' + curOnly.length + ' 件／前年のみ ' + prevOnly.length + ' 件' });
    if (alertCount > 0) {
      sum.appendChild(el('span', { class: 'fss-alert-badge', text: '　⚠ 要確認 ' + alertCount + ' 件' }));
    }
    area.appendChild(sum);

    if (diffs.length === 0) {
      area.appendChild(note('差異のある項目はなかったよ。画面の種類が違う場合は一致件数が少なくなるから、同じ帳票の画面同士で比較してね。'));
    } else {
      var table = el('table', { class: 'fss-table' });
      table.appendChild(el('tr', {}, [
        el('th', { text: '項目' }), el('th', { text: '前年' }), el('th', { text: '当期' }), el('th', { text: '増減' }), el('th', { text: '見立て（推測）' })
      ]));
      rows.forEach(function (r) {
        var m = r.m;
        var diffText = '-';
        var cls = '';
        if (m.prev.n != null && m.cur.n != null) {
          var d = m.cur.n - m.prev.n;
          var rate = m.prev.n !== 0 ? (d / Math.abs(m.prev.n) * 100) : null;
          diffText = fmt(d) + (rate != null ? '（' + (rate > 0 ? '+' : '') + rate.toFixed(1) + '%）' : '');
          if (Math.abs(d) >= 100000 && (rate == null || Math.abs(rate) >= 30)) cls = 'fss-warn';
        }
        var seeCell = el('td', { class: 'fss-see' });
        if (r.ex.alert) seeCell.appendChild(el('span', { class: 'fss-alert-badge', text: '⚠ 要確認' }));
        seeCell.appendChild(el('span', { text: r.ex.text }));
        table.appendChild(el('tr', { class: cls }, [
          el('td', { text: m.cur.label || m.k }),
          el('td', { class: 'fss-num', text: m.prev.n != null ? fmt(m.prev.n) : m.prev.v }),
          el('td', { class: 'fss-num', text: m.cur.n != null ? fmt(m.cur.n) : m.cur.v }),
          el('td', { class: 'fss-num', text: diffText }),
          seeCell
        ]));
      });
      var wrap = el('div', { class: 'fss-table-wrap' }, [table]);
      area.appendChild(wrap);
      area.appendChild(note('網掛け行は増減が大きい項目（差額10万円以上かつ±30%以上）。「見立て」はルールベースの機械的な推測だから、判断は必ず元帳・別表で確認してね。'));
    }

    // 片側にしかない項目（課税方式変更・新設項目の見落とし防止用）
    function miniList(title, arr) {
      if (arr.length === 0) return null;
      var d = el('details', { class: 'fss-manual' }, [
        el('summary', { text: title + '（' + arr.length + ' 件）' })
      ]);
      var ul = el('ul', { class: 'fss-findings' });
      arr.slice(0, 50).forEach(function (it) {
        ul.appendChild(el('li', { text: (it.label || it.k) + ': ' + (it.n != null ? fmt(it.n) : it.v) }));
      });
      if (arr.length > 50) ul.appendChild(el('li', { text: 'ほか ' + (arr.length - 50) + ' 件' }));
      d.appendChild(ul);
      return d;
    }
    var lCur = miniList('当期のみの項目', curOnly);
    if (lCur) area.appendChild(lCur);
    var lPrev = miniList('前年のみの項目 ⚠ 要確認（当期に無い＝計上漏れか課税方式変更の可能性）', prevOnly);
    if (lPrev) area.appendChild(lPrev);

    renderRollforwardChecks(area, prev, cur);
  }

  /* 繰越整合チェック（v0.4.2・2026-08-26 けんとさん指示）
   * 繰越系は「期首同士・期末同士の年度間増減」より「前期末→当期期首の繰越」と
   * 「前期分の解消」を見るのが本筋なので、ラベルベースで次を突合する:
   * - 納税充当金: ①前期末＝当期期首 ②期首分が当期中に全額取崩し ③当期末＝当期繰入額のみ
   * - その他の繰越項目（利益積立金・欠損金等）: 前期の翌期首/期末現在 ＝ 当期の期首現在 */
  function renderRollforwardChecks(area, prev, cur) {
    function firstByLabel(snap, re, ex) {
      for (var i = 0; i < snap.items.length; i++) {
        var it = snap.items[i];
        var lb = it.label || '';
        if (it.n != null && re.test(lb) && !(ex && ex.test(lb))) return it;
      }
      return null;
    }

    var results = [];

    // --- 納税充当金のロールフォワード（別表五(二)系のラベルが読めたときだけ動く） ---
    var prevEnd = firstByLabel(prev, /期末現在.{0,3}納税充当金|納税充当金.{0,6}期末/, /期首|翌期/);
    var curBegin = firstByLabel(cur, /期首現在.{0,3}納税充当金|納税充当金.{0,6}期首/, /期末|翌期/);
    var curEnd = firstByLabel(cur, /期末現在.{0,3}納税充当金|納税充当金.{0,6}期末/, /期首/);
    var curIn = firstByLabel(cur, /繰入額?の?計/, /取崩/) || firstByLabel(cur, /損金経理をした納税充当金/);
    var curOut = firstByLabel(cur, /取崩額?の?計/);

    if (prevEnd && curBegin) {
      if (prevEnd.n === curBegin.n) {
        results.push({ ok: true, text: '納税充当金: 前期末 ' + fmt(prevEnd.n) + ' → 当期期首 ' + fmt(curBegin.n) + '。繰越一致' });
      } else {
        results.push({ ok: false, text: '納税充当金: 前期末 ' + fmt(prevEnd.n) + ' と当期期首 ' + fmt(curBegin.n) + ' が不一致（差 ' + fmt(curBegin.n - prevEnd.n) + '）。期首残高の転記を確認' });
      }
    }
    if (curBegin && curOut) {
      if (curOut.n === curBegin.n) {
        results.push({ ok: true, text: '納税充当金: 期首分 ' + fmt(curBegin.n) + ' は当期中に全額取崩し済み' });
      } else if (curOut.n < curBegin.n) {
        results.push({ ok: false, text: '納税充当金: 取崩額計 ' + fmt(curOut.n) + ' が期首分 ' + fmt(curBegin.n) + ' に届いていない。前期分が期末に残っていないか確認' });
      } else {
        results.push({ ok: false, text: '納税充当金: 取崩額計 ' + fmt(curOut.n) + ' が期首分 ' + fmt(curBegin.n) + ' を超過。当期繰入分まで取り崩していないか（中間納付の充当等）確認' });
      }
    }
    if (curEnd && curIn) {
      if (curEnd.n === curIn.n) {
        results.push({ ok: true, text: '納税充当金: 当期末 ' + fmt(curEnd.n) + ' ＝ 当期繰入額。当期発生分のみになってる' });
      } else {
        results.push({ ok: false, text: '納税充当金: 当期末 ' + fmt(curEnd.n) + ' と当期繰入額 ' + fmt(curIn.n) + ' が不一致（差 ' + fmt(curEnd.n - curIn.n) + '）。前期分の残りか過取崩がないか確認' });
      }
    }

    // --- 汎用の繰越整合（前期の翌期首/期末現在 ↔ 当期の期首現在。別表五(一)・欠損金等） ---
    function baseOf(lb) {
      return lb.replace(/差引翌期首現在|翌期首現在|期首現在|期末現在/g, '').replace(/\s+/g, '');
    }
    var prevEnds = {};
    prev.items.forEach(function (it) {
      var lb = it.label || '';
      if (it.n == null || !/翌期首現在|期末現在/.test(lb)) return;
      var b = baseOf(lb);
      if (/納税充当金/.test(b)) return; // 上の専用チェックと重複させない
      prevEnds[b] = (prevEnds[b] === undefined) ? it.n : null; // 同名複数は曖昧なので突合しない
    });
    var rollOk = 0;
    cur.items.forEach(function (it) {
      var lb = it.label || '';
      if (it.n == null || !/期首現在/.test(lb) || /翌期首/.test(lb)) return;
      var b = baseOf(lb);
      if (/納税充当金/.test(b)) return;
      var pn = prevEnds[b];
      if (pn === undefined || pn === null) return;
      if (pn === it.n) {
        rollOk++;
      } else {
        results.push({ ok: false, text: b + ': 前期末 ' + fmt(pn) + ' → 当期期首 ' + fmt(it.n) + ' が不一致（差 ' + fmt(it.n - pn) + '）' });
      }
    });
    if (rollOk > 0) results.push({ ok: true, text: 'その他の繰越項目 ' + rollOk + ' 件は前期末→当期期首が一致' });

    if (results.length === 0) return;
    area.appendChild(el('h3', { class: 'fss-h3', text: '繰越整合チェック（前期末 → 当期期首）' }));
    var ul = el('ul', { class: 'fss-findings' });
    results.forEach(function (r) {
      var li = el('li', {});
      if (!r.ok) li.appendChild(el('span', { class: 'fss-alert-badge', text: '⚠ 要確認' }));
      li.appendChild(el('span', { text: (r.ok ? '✓ ' : '') + r.text }));
      ul.appendChild(li);
    });
    area.appendChild(ul);
    area.appendChild(note('明細行の並びが年度間で変わっていると突合できない項目が出るよ。最終確認は別表五(一)・(二)の原本で。'));
  }

  /* 「申告書チェック」機能は v0.4.0 で拡張から削除した。
   * 申告書レビューは Claude Code 側の一次レビュー（shinkoku-reviewスキル＋レビュー台帳）に一本化。 */

  /* ===================== ② 予定納税試算 ===================== */

  function renderYotei(body) {
    body.appendChild(note('今回の確定税額をもとに、来期の中間申告（予定納税）を前期実績基準で試算するよ。仮決算による中間申告や特殊ケースは対象外。最終判断はけんとさんの確認で！'));

    var mode = /消費/.test(document.title) ? 'shouhi' : 'houjin';
    var modeRow = el('div', { class: 'fss-row' });
    var btnH, btnS;
    var formArea = el('div');
    function setMode(m) {
      mode = m;
      btnH.className = 'fss-btn' + (m === 'houjin' ? ' fss-btn-primary' : '');
      btnS.className = 'fss-btn' + (m === 'shouhi' ? ' fss-btn-primary' : '');
      formArea.textContent = '';
      if (m === 'houjin') renderYoteiHoujin(formArea);
      else renderYoteiShouhi(formArea);
    }
    btnH = el('button', { class: 'fss-btn', text: '法人税・地方税', onclick: function () { setMode('houjin'); } });
    btnS = el('button', { class: 'fss-btn', text: '消費税', onclick: function () { setMode('shouhi'); } });
    modeRow.appendChild(btnH);
    modeRow.appendChild(btnS);
    body.appendChild(modeRow);
    body.appendChild(formArea);
    setMode(mode);
  }

  function numField(labelText, placeholder) {
    var input = el('input', { class: 'fss-input fss-num-input', type: 'text', inputmode: 'numeric', placeholder: placeholder || '0' });
    var row = el('div', { class: 'fss-field' }, [
      el('label', { text: labelText }),
      input
    ]);
    return { row: row, input: input, value: function () { return parseNum(input.value) || 0; } };
  }

  function renderYoteiHoujin(area) {
    var fH = numField('当期の確定法人税額（別表一の差引所得に対する法人税額）', '例: 1,234,500');
    var fLH = numField('当期の地方法人税額', '');
    var fPref = numField('当期の都道府県民税額（法人税割＋均等割）', '');
    var fCity = numField('当期の市町村民税額（法人税割＋均等割）※東京23区は0のまま', '');
    var fBiz = numField('当期の事業税＋特別法人事業税額', '');
    var fM = numField('当期の月数', '12');
    fM.input.value = '12';

    var result = el('div');
    area.appendChild(fH.row);
    area.appendChild(fLH.row);
    area.appendChild(fPref.row);
    area.appendChild(fCity.row);
    area.appendChild(fBiz.row);
    area.appendChild(fM.row);
    area.appendChild(el('div', { class: 'fss-row' }, [
      el('button', { class: 'fss-btn fss-btn-primary', text: '試算する', onclick: calc })
    ]));
    area.appendChild(result);

    // v0.4: 当期の法人税申告書（内部API・GETのみ）から確定税額を自動プレフィル。
    // 別表一（10100100）と第六号様式（206000000）の欄は itemTitle で特定する
    // （事業所ごとの様式差に強くするため。見つからない欄は手入力のまま）
    fetchCurrentReturnK(CORP).then(function (ret) {
      if (!ret || !ret.id) throw new Error('no return');
      var msgs = [];
      var mo = monthsBetween(
        ret.tax_period_start_date || String(ret.start_date || '').slice(0, 10),
        ret.tax_period_end_date || String(ret.end_date || '').slice(0, 10)
      );
      if (mo && mo >= 1 && mo <= 12) fM.input.value = String(mo);
      var jobs = [];
      jobs.push(Promise.all([apiGet(apiBase(CORP) + 'sheets/10100100', ret.id), fetchCorpDefs(10100100, ret.id)]).then(function (rr) {
        var snap = parseCorpSheetApi(rr[0], 10100100);
        if (!snap) return;
        var h = findCorpValueByTitle(snap, rr[1], /差引所得に対する法人税額/, /中間|既に|繰戻|翌期/);
        if (h) { fH.input.value = String(h.n); msgs.push('法人税 ' + fmt(h.n) + ' 円（別表一）'); }
        var lh = findCorpValueByTitle(snap, rr[1], /差引地方法人税額/, /中間|既に|翌期/);
        if (lh) { fLH.input.value = String(lh.n); msgs.push('地方法人税 ' + fmt(lh.n) + ' 円'); }
      }).catch(function () { /* 別表一が読めない場合は手入力のまま */ }));
      jobs.push(Promise.all([apiGet(apiBase(CORP) + 'sheets/206000000', ret.id), fetchCorpDefs(206000000, ret.id)]).then(function (rr) {
        var snap = parseCorpSheetApi(rr[0], 206000000);
        if (!snap) return;
        var pref = findCorpValueByTitle(snap, rr[1], /納付すべき道府県民税額/, /中間|既に|見込/);
        if (pref) { fPref.input.value = String(pref.n); msgs.push('都道府県民税 ' + fmt(pref.n) + ' 円（第六号様式）'); }
        var biz = findCorpValueByTitle(snap, rr[1], /納付すべき事業税額/, /中間|既に|見込/);
        var sbiz = findCorpValueByTitle(snap, rr[1], /納付すべき特別法人事業税額/, /中間|既に|見込/);
        if (biz || sbiz) {
          var bizTotal = (biz ? biz.n : 0) + (sbiz ? sbiz.n : 0);
          fBiz.input.value = String(bizTotal);
          msgs.push('事業税＋特別法人事業税 ' + fmt(bizTotal) + ' 円');
        }
      }).catch(function () { /* 第六号様式が無い事業所（東京都単一等）は手入力のまま */ }));
      return Promise.all(jobs).then(function () {
        if (msgs.length === 0) return;
        area.insertBefore(el('p', {
          class: 'fss-summary',
          text: '申告書から自動入力したよ: ' + msgs.join(' ／ ') + '。書き換えてもOK（市町村民税は手入力してね）'
        }), result);
        // 法人税額が入ったらそのまま試算まで実行する（タブを開くだけで結果が出る）
        if (fH.input.value !== '') calc();
      });
    }).catch(function () { /* 法人税APIが使えない事業所では手入力のまま */ });

    function calc() {
      result.textContent = '';
      var months = fM.value() || 12;
      if (months < 1 || months > 12) {
        result.appendChild(note('月数は1〜12で入れてね。'));
        return;
      }
      var h6 = floor100(fH.value() * 6 / months);
      var required = h6 > 100000;

      var rows = [
        ['法人税（中間）', h6],
        ['地方法人税（中間）', floor100(fLH.value() * 6 / months)],
        ['都道府県民税（中間）', floor100(fPref.value() * 6 / months)],
        ['市町村民税（中間）', floor100(fCity.value() * 6 / months)],
        ['事業税・特別法人事業税（中間）', floor100(fBiz.value() * 6 / months)]
      ];
      var total = rows.reduce(function (a, r) { return a + r[1]; }, 0);

      if (!required) {
        result.appendChild(el('p', { class: 'fss-summary', text: '判定: 中間申告は不要（法人税の予定申告額 ' + fmt(h6) + ' 円 ≦ 10万円）' }));
        result.appendChild(note('法人税の中間申告義務がない場合、住民税・事業税の予定申告も不要になるよ。'));
        return;
      }

      result.appendChild(el('p', { class: 'fss-summary', text: '判定: 中間申告あり（来期開始から6ヶ月経過日から2ヶ月以内に申告・納付）' }));
      var table = el('table', { class: 'fss-table' });
      table.appendChild(el('tr', {}, [el('th', { text: '税目' }), el('th', { text: '中間納付見込額' })]));
      rows.forEach(function (r) {
        table.appendChild(el('tr', {}, [el('td', { text: r[0] }), el('td', { class: 'fss-num', text: fmt(r[1]) + ' 円' })]));
      });
      table.appendChild(el('tr', { class: 'fss-total' }, [el('td', { text: '合計' }), el('td', { class: 'fss-num', text: fmt(total) + ' 円' })]));
      result.appendChild(el('div', { class: 'fss-table-wrap' }, [table]));
      result.appendChild(note('計算式: 当期の確定税額 × 6 ÷ 当期の月数（100円未満切捨て）。実際の予定申告書・納付書は自治体からの送付額と突き合わせてね。仮決算による中間申告を選ぶと納付額を抑えられる場合があるよ（要検討事項）。'));

      result.appendChild(el('button', {
        class: 'fss-btn', text: '試算結果をコピー',
        onclick: function (ev) {
          var lines = ['【来期の中間申告（予定納税）試算・前期実績基準】', '当期の確定法人税額: ' + fmt(fH.value()) + ' 円 / 月数: ' + months];
          rows.forEach(function (r) { lines.push(r[0] + ': ' + fmt(r[1]) + ' 円'); });
          lines.push('合計: ' + fmt(total) + ' 円');
          lines.push('※100円未満切捨て・前期実績基準。仮決算方式は別途検討。');
          copyText(lines.join('\n'), ev.target);
        }
      }));
    }
  }

  function renderYoteiShouhi(area) {
    var fC = numField('当期の確定消費税額（国税分・地方消費税を除く年税額）', '例: 3,456,700');
    var result = el('div');
    area.appendChild(fC.row);
    area.appendChild(note('申告書の「差引税額」（国税分）を入れてね。地方消費税込みの納付総額ではないよ。当期が12ヶ月未満の場合は年換算が必要（v0.1は12ヶ月前提）。'));
    area.appendChild(el('div', { class: 'fss-row' }, [
      el('button', { class: 'fss-btn fss-btn-primary', text: '試算する', onclick: calc })
    ]));
    area.appendChild(result);

    // v0.3: 当期の消費税申告書（内部API・GETのみ）から差引税額（aaj00100）を自動プレフィル
    fetchCurrentReturnK(CONS).then(function (ret) {
      return fetchSheetRaw(401010011, ret && ret.id).then(function (raw) {
        var g = (raw && raw.values && raw.values.default_group) || {};
        var msgs = [];
        function asNum(v) { return (typeof v === 'number') ? v : parseNum(String(v)); }
        if (g.aaj00100 != null && g.aaj00100 !== '') {
          fC.input.value = String(asNum(g.aaj00100));
          msgs.push('申告書の差引税額（国税分）' + fmt(asNum(g.aaj00100)) + ' 円を自動入力したよ。書き換えてもOK');
        } else if (g.aaj00090 != null && g.aaj00090 !== '') {
          fC.input.value = '0';
          msgs.push('当期は還付申告（控除不足還付税額 ' + fmt(asNum(g.aaj00090)) + ' 円）だから、来期の中間申告は不要見込みだよ');
        }
        var mo = monthsBetween(ret && ret.tax_period_start_date, ret && ret.tax_period_end_date);
        if (msgs.length && mo && mo !== 12) {
          msgs.push('当期は約' + mo + 'ヶ月決算だから、中間判定は年換算ベースで見てね（この試算は目安）');
        }
        if (msgs.length) area.insertBefore(el('p', { class: 'fss-summary', text: msgs.join(' ／ ') }), result);
        // プレフィルできたらそのまま試算まで実行する（タブを開くだけで結果が出る）
        if (fC.input.value !== '') calc();
      });
    }).catch(function () { /* APIが使えない画面では手入力のまま */ });

    function calc() {
      result.textContent = '';
      var c = fC.value();
      var plan;
      if (c <= 480000) {
        result.appendChild(el('p', { class: 'fss-summary', text: '判定: 中間申告は不要（確定消費税額 ' + fmt(c) + ' 円 ≦ 48万円）' }));
        result.appendChild(note('任意の中間申告（年1回・6ヶ月中間）を選択することもできるよ（要届出）。'));
        return;
      } else if (c <= 4000000) {
        plan = { count: 1, frac: 6, label: '年1回（6ヶ月中間）' };
      } else if (c <= 48000000) {
        plan = { count: 3, frac: 3, label: '年3回（3ヶ月ごと）' };
      } else {
        plan = { count: 11, frac: 1, label: '年11回（毎月）' };
      }

      var nat = floor100(c * plan.frac / 12);
      var local = floor100(nat * 22 / 78);
      var per = nat + local;
      var totalNat = nat * plan.count;
      var totalLocal = local * plan.count;

      result.appendChild(el('p', { class: 'fss-summary', text: '判定: 中間申告 ' + plan.label }));
      var table = el('table', { class: 'fss-table' });
      table.appendChild(el('tr', {}, [el('th', { text: '' }), el('th', { text: '1回あたり' }), el('th', { text: '年間合計（' + plan.count + '回）' })]));
      [['消費税（国税）', nat, totalNat], ['地方消費税', local, totalLocal], ['納付額合計', per, totalNat + totalLocal]].forEach(function (r, i) {
        table.appendChild(el('tr', { class: i === 2 ? 'fss-total' : '' }, [
          el('td', { text: r[0] }),
          el('td', { class: 'fss-num', text: fmt(r[1]) + ' 円' }),
          el('td', { class: 'fss-num', text: fmt(r[2]) + ' 円' })
        ]));
      });
      result.appendChild(el('div', { class: 'fss-table-wrap' }, [table]));
      result.appendChild(note('計算式: 確定消費税額（国税分）× ' + plan.frac + '/12（100円未満切捨て）＋ 地方消費税（国税×22/78）。実際の中間納付は税務署からの通知額が基準になるよ。仮決算方式の選択も可能（要検討事項）。'));

      result.appendChild(el('button', {
        class: 'fss-btn', text: '試算結果をコピー',
        onclick: function (ev) {
          var lines = [
            '【来期の消費税 中間申告試算】',
            '当期の確定消費税額（国税分）: ' + fmt(c) + ' 円',
            '判定: ' + plan.label,
            '1回あたり: 国税 ' + fmt(nat) + ' 円 ＋ 地方 ' + fmt(local) + ' 円 ＝ ' + fmt(per) + ' 円',
            '年間中間合計: ' + fmt(totalNat + totalLocal) + ' 円',
            '※100円未満切捨て・前期実績基準・12ヶ月決算前提。'
          ];
          copyText(lines.join('\n'), ev.target);
        }
      }));
    }
  }

  /* ===================== ④ 開発情報 ===================== */

  function renderDev(body) {
    body.appendChild(note('この画面の構造を回収して拡張を精緻化するためのタブだよ。下のボタンでコピーして、Claude Codeのチャットに貼ってね。顧問先の金額データも含まれるから、貼り先はローカルのClaude Codeだけにしてね。'));

    var cur = scrapeScreen();
    body.appendChild(el('p', { class: 'fss-summary', text: '画面読み取り: ' + cur.items.length + ' 項目 ／ APIキャプチャ: ' + captures.length + ' 件' }));

    body.appendChild(el('div', { class: 'fss-row' }, [
      el('button', {
        class: 'fss-btn fss-btn-primary', text: '画面スクレイプ結果をコピー',
        onclick: function (ev) { copyText(JSON.stringify(scrapeScreen(), null, 1), ev.target); }
      }),
      el('button', {
        class: 'fss-btn fss-btn-primary', text: 'APIキャプチャをコピー',
        onclick: function (ev) {
          var slim = captures.map(function (c) {
            return { method: c.method, url: c.url, status: c.status, at: c.at, truncated: c.truncated, body: c.body };
          });
          copyText(JSON.stringify(slim, null, 1), ev.target);
        }
      })
    ]));

    if (captures.length > 0) {
      var table = el('table', { class: 'fss-table' });
      table.appendChild(el('tr', {}, [el('th', { text: 'メソッド' }), el('th', { text: 'URL' }), el('th', { text: 'サイズ' })]));
      captures.slice(-40).reverse().forEach(function (c) {
        var path = c.url.replace(/^https?:\/\/[^/]+/, '');
        table.appendChild(el('tr', {}, [
          el('td', { text: c.method + ' ' + c.status }),
          el('td', { text: path.slice(0, 80) }),
          el('td', { class: 'fss-num', text: (c.body || '').length.toLocaleString() })
        ]));
      });
      body.appendChild(el('div', { class: 'fss-table-wrap' }, [table]));
    } else {
      body.appendChild(note('APIキャプチャがまだ0件だよ。ページを再読み込みしてから画面を操作すると、freeeが呼ぶAPIが記録されるよ。'));
    }
  }

  /* ===================== ボタン注入（インライン優先） ===================== */

  var INLINE_ID = 'fss-inline';

  function ensureRoot() {
    if (!document.getElementById(ROOT_ID)) {
      (document.body || document.documentElement).appendChild(el('div', { id: ROOT_ID }));
    }
  }

  function buildButtons(cls, devCls) {
    return [
      el('button', { class: cls, text: '前年比較', onclick: function () { openPanel('compare'); } }),
      el('button', { class: cls, text: '予定納税試算', onclick: function () { openPanel('yotei'); } }),
      el('button', { class: cls + ' ' + devCls, text: '⚙', title: '開発情報', onclick: function () { openPanel('dev'); } })
    ];
  }

  // freee画面の既存ボタン列を探す（会計freeeの試算表タブ列のように、既存UIに溶け込ませるため）。
  // 「画面上部エリアにあって、可視ボタンが2個以上並んでいる親要素」のうち一番上のものを選ぶ
  function findInlineAnchor() {
    var root = document.getElementById(ROOT_ID);
    var inline = document.getElementById(INLINE_ID);
    var groups = [];
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (root && root.contains(b)) continue;
      if (inline && inline.contains(b)) continue;
      if (!b.offsetParent) continue; // 非表示
      var r = b.getBoundingClientRect();
      if (r.width === 0 || r.top < 40 || r.top > 420) continue; // グローバルヘッダーと画面下部は除外
      var p = b.parentElement;
      if (!p) continue;
      var g = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].parent === p) { g = groups[j]; break; }
      }
      if (!g) { g = { parent: p, count: 0, top: r.top }; groups.push(g); }
      g.count++;
    }
    var best = null;
    for (var k = 0; k < groups.length; k++) {
      if (groups[k].count < 2) continue;
      if (!best || groups[k].top < best.top) best = groups[k];
    }
    if (best) return best.parent;

    // フォールバック: ボタン列がない画面（freee申告のヘッダーはボタンが1個ずつ別の親）では、
    // ページタイトルH1の親（ヘッダーのflex行）に並べる。クラス名はハッシュ付きで信頼できないためH1を目印にする
    var h1s = document.querySelectorAll('h1');
    for (var m = 0; m < h1s.length; m++) {
      var h = h1s[m];
      if (root && root.contains(h)) continue;
      if (!h.offsetParent) continue;
      var hr = h.getBoundingClientRect();
      if (hr.width === 0 || hr.top < 40 || hr.top > 300) continue;
      if (h.parentElement) return h.parentElement;
    }
    return null;
  }

  function injectToolbar() {
    ensureRoot();

    // インライン設置: 画面内の既存ボタン列の末尾に並べる（押すとその場でパネルが開いて点検開始）
    if (!document.getElementById(INLINE_ID)) {
      var anchor = findInlineAnchor();
      if (anchor) {
        anchor.appendChild(el('span', { id: INLINE_ID }, [
          el('span', { class: 'fss-inline-logo', text: '🌸' })
        ].concat(buildButtons('fss-inline-btn', 'fss-inline-dev'))));
        log('inline buttons injected');
      }
    }

    // フォールバック: ボタン列が見つからない画面では従来のフローティング🌸を出す
    var hasInline = !!document.getElementById(INLINE_ID);
    var floatBar = document.getElementById('fss-float');
    if (hasInline) {
      if (floatBar) floatBar.remove();
    } else if (!floatBar) {
      document.getElementById(ROOT_ID).appendChild(
        el('div', { id: 'fss-float', class: 'fss-toolbar' }, [
          el('span', { class: 'fss-toolbar-logo', text: '🌸' })
        ].concat(buildButtons('fss-tbtn', 'fss-tbtn-dev')))
      );
      log('floating toolbar injected');
    }
  }

  injectToolbar();

  // SPAの再描画でツールバーが消えたら復元＋画面が落ち着いたら自動スナップショット
  var scheduled = false;
  var autoTimer = null;
  new MutationObserver(function () {
    if (!scheduled) {
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        injectToolbar();
      }, 500);
    }
    // 描画が2秒止まったら「画面が表示し終わった」とみなして自動保存
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(autoSnapshot, 2000);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 初期表示分（ミューテーションが起きない静的画面）も一度保存を試す
  setTimeout(autoSnapshot, 3000);
})();
