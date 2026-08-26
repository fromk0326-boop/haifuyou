/*
 * freee人事労務 年調一覧表ボタン - content script（ISOLATEDワールド）
 *
 * freee人事労務（p.secure.freee.co.jp）の年末調整の画面に「年調一覧表」ボタンを注入し、
 * ページ自身が内部APIから取得した年末調整データ（capture.jsが観測したJSON）を
 * 一覧表に組み立ててCSV出力する。
 *
 * 設計方針（freee-shinkoku-support と同じ）:
 * - 読み取り専用。freeeへの書き込みAPIは呼ばない（内部APIへの能動アクセスもGETのみ）
 * - 外部への送信は一切しない。保存先は chrome.storage.local（このPCのChrome内）だけ
 *
 * v0.2 で使う内部API（2026-08-26 実画面キャプチャで確定）:
 * - GET /api/p/nemmatsu_chosei/nemmatsu_choseis?year={year}
 *     従業員一覧（id・氏名・従業員番号・ステータス・年調対象/対象外・退職）
 * - GET /api/p/yearend_adjustments/{year}/employees/{emp_id}
 *     従業員別の計算結果（給与収入・各控除・課税給与所得・年調年税額・過不足額。
 *     withholding_tax_statement=源泉徴収票、extra_data.withholding_tax_register=源泉徴収簿、
 *     adjustment_amounts=年調計算サマリー）
 * 上記が使えないときは v0.1 の汎用方式（受動キャプチャ＋画面テーブル読み取り）にフォールバックする
 */
(function () {
  'use strict';

  var SOURCE = 'freee-nencho-ichiran';
  var ROOT_ID = 'fnl-root';
  var PANEL_ID = 'fnl-panel';
  var CAP_KEY = 'fnl:api-captures';   // 年調関連キャプチャの永続保存（画面遷移をまたいで使う）
  var PANEL_W_KEY = 'fnl:panel-width';
  var MAX_CAPTURES = 300;             // メモリ上の全APIキャプチャ保持上限
  var MAX_SAVED = 120;                // storageに残す年調関連キャプチャの上限
  var MAX_ROWS_DISPLAY = 100;         // パネル内の表示行数上限（CSVは全行）

  var DEBUG = false;
  function log() {
    if (DEBUG && window.console) console.log.apply(console, ['[fnl]'].concat([].slice.call(arguments)));
  }

  /* ===================== 汎用ヘルパー ===================== */

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') e.textContent = attrs[k];
        else if (k === 'onclick') e.addEventListener('click', attrs[k]);
        else if (k === 'onchange') e.addEventListener('change', attrs[k]);
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(function () {
      var orig = btn.textContent;
      btn.textContent = '✓ コピーしたよ';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    }, function () {
      btn.textContent = 'コピー失敗…';
    });
  }

  function note(text) {
    return el('p', { class: 'fnl-note', text: text });
  }

  function fmtCell(v) {
    if (v == null) return '';
    if (typeof v === 'number') return v.toLocaleString('ja-JP');
    return String(v);
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  }

  /* ===================== 年調ページ判定 ===================== */

  // URLかページ見出しに年末調整の気配があるときだけボタンを出す
  // （人事労務の他画面ではUIを出さない。キャプチャの観測自体は裏で続ける）
  function isNenchoPage() {
    var path = location.pathname + location.search;
    if (/year_?end|nencho|yearend_adjustment/i.test(path)) return true;
    if (/年末調整/.test(document.title || '')) return true;
    var hs = document.querySelectorAll('h1, h2');
    for (var i = 0; i < hs.length; i++) {
      if (/年末調整/.test(hs[i].textContent || '')) return true;
    }
    return false;
  }

  function isNenchoUrl(url) {
    // nemmatsu_chosei = 人事労務内部の一覧API（/api/p/nemmatsu_chosei/nemmatsu_choseis）
    return /year_?end|nencho|nemmatsu|yearend_adjustment/i.test(String(url || ''));
  }

  /* ===================== APIキャプチャの受信・保存 ===================== */

  var captures = [];       // このタブで観測した全JSONレスポンス（メモリのみ）
  var savedCaptures = [];  // 年調関連の永続保存分（storageと同期）

  function urlPattern(url) {
    var path = String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    return path.replace(/\/\d+(?=\/|$)/g, '/{id}');
  }

  function loadSavedCaptures(cb) {
    chrome.storage.local.get([CAP_KEY], function (res) {
      savedCaptures = (res && res[CAP_KEY]) || [];
      if (cb) cb(savedCaptures);
    });
  }

  function persistCapture(entry) {
    // 同じURLパターンの古い分は置き換えて、最新の状態だけを残す
    var key = entry.method + ' ' + urlPattern(entry.url);
    savedCaptures = savedCaptures.filter(function (c) {
      return (c.method + ' ' + urlPattern(c.url)) !== key;
    });
    savedCaptures.push(entry);
    if (savedCaptures.length > MAX_SAVED) savedCaptures = savedCaptures.slice(-MAX_SAVED);
    var obj = {};
    obj[CAP_KEY] = savedCaptures;
    chrome.storage.local.set(obj);
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.source !== SOURCE || d.type !== 'capture' || !d.entry) return;
    captures.push(d.entry);
    if (captures.length > MAX_CAPTURES) captures = captures.slice(-MAX_CAPTURES);
    if (d.entry.method === 'GET' && isNenchoUrl(d.entry.url) && d.entry.status === 200) {
      persistCapture(d.entry);
      showToast('🌸 年調データを読み取ったよ', urlPattern(d.entry.url));
    }
  });

  /* ===================== データセット抽出（汎用JSON→表） ===================== */

  // JSONの中から「オブジェクトの配列」を探す（従業員一覧らしきものを推定するための材料）
  function findObjectArrays(node, path, out, depth) {
    if (depth > 6 || node == null) return;
    if (Array.isArray(node)) {
      var objs = node.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); });
      if (objs.length > 0) out.push({ path: path, rows: objs });
      // 配列の中の配列は追わない（明細行は行内で潰す）
      return;
    }
    if (typeof node === 'object') {
      Object.keys(node).forEach(function (k) {
        findObjectArrays(node[k], path ? path + '.' + k : k, out, depth + 1);
      });
    }
  }

  var NAME_KEY_RE = /(last_name|first_name|full_name|display_name|employee_name|^name$|氏名)/i;

  function scoreDataset(ds) {
    // 行数 ＋ 名前らしきキーがあれば加点（従業員一覧を最優先で拾うため）
    var keys = Object.keys(ds.rows[0] || {});
    var nameBonus = keys.some(function (k) { return NAME_KEY_RE.test(k); }) ? 1000 : 0;
    return ds.rows.length + nameBonus;
  }

  // ネストを1〜2段だけ平坦化して「1行=1従業員」の表にする
  function flattenRow(obj, prefix, out, depth) {
    out = out || {};
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      var key = prefix ? prefix + '.' + k : k;
      if (v == null) {
        out[key] = '';
      } else if (Array.isArray(v)) {
        var scalars = v.filter(function (x) { return x == null || typeof x !== 'object'; });
        if (scalars.length === v.length) out[key] = scalars.join('、');
        else out[key] = v.length + '件';
      } else if (typeof v === 'object') {
        if (depth < 2) flattenRow(v, key, out, depth + 1);
        else out[key] = JSON.stringify(v).slice(0, 60);
      } else {
        out[key] = v;
      }
    });
    return out;
  }

  function buildTableData(rows) {
    var flat = rows.map(function (r) { return flattenRow(r, '', {}, 0); });
    var cols = [];
    var seen = {};
    flat.forEach(function (r) {
      Object.keys(r).forEach(function (k) {
        if (!seen[k]) { seen[k] = true; cols.push(k); }
      });
    });
    // 名前らしき列を先頭へ
    cols.sort(function (a, b) {
      var an = NAME_KEY_RE.test(a) ? 0 : 1;
      var bn = NAME_KEY_RE.test(b) ? 0 : 1;
      if (an !== bn) return an - bn;
      return 0; // 同格なら元の出現順（sortは安定）
    });
    return { cols: cols, rows: flat };
  }

  // メモリ＋storageの年調関連キャプチャから、表にできるデータセット候補を集める
  function collectDatasets() {
    var byKey = {};
    savedCaptures.concat(captures).forEach(function (c) {
      if (c.method !== 'GET' || c.status !== 200) return;
      if (!isNenchoUrl(c.url)) return;
      byKey[c.method + ' ' + urlPattern(c.url)] = c; // 後勝ち＝新しい方
    });
    var datasets = [];
    Object.keys(byKey).forEach(function (key) {
      var c = byKey[key];
      var data;
      try { data = JSON.parse(c.body); } catch (e) { return; }
      var arrays = [];
      findObjectArrays(data, '', arrays, 0);
      arrays.forEach(function (a) {
        if (a.rows.length < 1) return;
        datasets.push({
          label: urlPattern(c.url) + (a.path ? ' › ' + a.path : '') + '（' + a.rows.length + '行・' + String(c.at).slice(11, 19) + '）',
          source: 'api',
          rows: a.rows,
          at: c.at
        });
      });
    });
    datasets.sort(function (a, b) { return scoreDataset(b) - scoreDataset(a); });
    return datasets;
  }

  /* ===================== 画面テーブル読み取り（フォールバック） ===================== */

  function scrapeDomTables() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('table'), function (table, ti) {
      var root = document.getElementById(ROOT_ID);
      if (root && root.contains(table)) return;
      var trs = table.querySelectorAll('tr');
      if (trs.length < 2) return;
      var header = [];
      Array.prototype.forEach.call(trs[0].querySelectorAll('th, td'), function (c) {
        header.push((c.textContent || '').trim());
      });
      if (header.filter(Boolean).length < 2) return;
      var rows = [];
      for (var i = 1; i < trs.length; i++) {
        var cells = trs[i].querySelectorAll('th, td');
        if (!cells.length) continue;
        var row = {};
        for (var j = 0; j < cells.length; j++) {
          var name = header[j] || ('列' + (j + 1));
          row[name] = (cells[j].textContent || '').trim();
        }
        rows.push(row);
      }
      if (rows.length > 0) {
        out.push({
          label: '画面の表' + (ti + 1) + '（' + rows.length + '行）',
          source: 'dom',
          rows: rows,
          at: new Date().toISOString()
        });
      }
    });
    out.sort(function (a, b) { return b.rows.length - a.rows.length; });
    return out;
  }

  /* ===================== CSV/TSV出力 ===================== */

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCsv(table) {
    var lines = [table.cols.map(csvEscape).join(',')];
    table.rows.forEach(function (r) {
      lines.push(table.cols.map(function (c) { return csvEscape(r[c]); }).join(','));
    });
    return lines.join('\r\n');
  }

  function toTsv(table) {
    var lines = [table.cols.join('\t')];
    table.rows.forEach(function (r) {
      lines.push(table.cols.map(function (c) {
        return String(r[c] == null ? '' : r[c]).replace(/[\t\n\r]/g, ' ');
      }).join('\t'));
    });
    return lines.join('\n');
  }

  function downloadCsv(table, baseName) {
    // BOM付きUTF-8にするとExcelがそのまま文字化けせずに開ける
    var blob = new Blob(['\ufeff' + toCsv(table)], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (baseName || '年末調整データ一覧') + '_' + today() + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  /* ===================== PDF出力（印刷用ウィンドウ） ===================== */

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 合計行の計算。番号・氏名・ステータス系の列は合計しない
  var NO_TOTAL_COL_RE = /番号|氏名|対象|退職|ステータス|備考|名前|name/i;

  function sectionTotals(cols, rows) {
    var sums = {};
    var any = false;
    cols.forEach(function (c) {
      if (NO_TOTAL_COL_RE.test(c)) return;
      var s = 0;
      var has = false;
      rows.forEach(function (r) {
        if (typeof r[c] === 'number') { s += r[c]; has = true; }
      });
      if (has) { sums[c] = s; any = true; }
    });
    return any ? sums : null;
  }

  // 印刷用の自己完結HTML（A4横向き・背景色の印刷抜け防止・青系アクセントのモノトーン）
  function buildPrintHtml(table, opts) {
    var sections = (opts && opts.sections) || [{ heading: '', cols: table.cols }];
    var h = [];
    h.push('<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">');
    h.push('<title>' + escapeHtml(opts.title) + '</title>');
    h.push('<style>');
    h.push('@page { size: A4 landscape; margin: 0; }');
    h.push('* { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }');
    h.push('html, body { margin: 0; background: #ffffff; color: #1a1a1a; font-family: "Meiryo UI", Meiryo, "Hiragino Kaku Gothic ProN", sans-serif; }');
    h.push('.sheet { padding: 10mm 12mm 8mm; page-break-after: always; }');
    h.push('.sheet:last-of-type { page-break-after: auto; }');
    h.push('.head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #2b6cb0; padding-bottom: 6px; }');
    h.push('h1 { margin: 0; font-size: 22px; }');
    h.push('h1 .sec { font-size: 16px; font-weight: normal; color: #2b6cb0; margin-left: 14px; }');
    h.push('.meta { font-size: 14px; color: #555555; text-align: right; }');
    h.push('.stats { display: flex; gap: 10px; margin: 10px 0 0; }');
    h.push('.stat { border: 1px solid #cccccc; border-left: 4px solid #2b6cb0; padding: 6px 14px; font-size: 14px; background: #f7f9fb; }');
    h.push('.stat b { font-size: 17px; margin-left: 8px; }');
    h.push('table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }');
    h.push('th { background: #eef1f5; border: 1px solid #bbbbbb; padding: 4px 6px; font-size: 14px; }');
    h.push('td { border: 1px solid #bbbbbb; padding: 4px 6px; }');
    h.push('td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }');
    h.push('tr.total td { background: #e7effa; font-weight: bold; }');
    h.push('.foot { margin-top: 8px; font-size: 14px; color: #777777; display: flex; justify-content: space-between; }');
    h.push('</style></head><body>');

    sections.forEach(function (sec, si) {
      h.push('<section class="sheet">');
      h.push('<div class="head"><h1>' + escapeHtml(opts.title)
        + (sec.heading ? '<span class="sec">' + escapeHtml(sec.heading) + '</span>' : '')
        + '</h1><div class="meta">' + escapeHtml(opts.subtitle || '') + '</div></div>');
      if (si === 0 && opts.stats && opts.stats.length) {
        h.push('<div class="stats">' + opts.stats.map(function (s) {
          return '<div class="stat">' + escapeHtml(s.label) + '<b>' + escapeHtml(s.value) + '</b></div>';
        }).join('') + '</div>');
      }
      h.push('<table><thead><tr>' + sec.cols.map(function (c) {
        return '<th>' + escapeHtml(c) + '</th>';
      }).join('') + '</tr></thead><tbody>');
      table.rows.forEach(function (r) {
        h.push('<tr>' + sec.cols.map(function (c) {
          var v = r[c];
          var isNum = typeof v === 'number';
          return '<td' + (isNum ? ' class="num"' : '') + '>' + escapeHtml(fmtCell(v)) + '</td>';
        }).join('') + '</tr>');
      });
      var sums = sectionTotals(sec.cols, table.rows);
      if (sums) {
        var labelDone = false;
        h.push('<tr class="total">' + sec.cols.map(function (c) {
          if (sums[c] != null) return '<td class="num">' + escapeHtml(sums[c].toLocaleString('ja-JP')) + '</td>';
          if (!labelDone) { labelDone = true; return '<td>合計</td>'; }
          return '<td></td>';
        }).join('') + '</tr>');
      }
      h.push('</tbody></table>');
      h.push('<div class="foot"><span>' + escapeHtml(opts.footNote || '') + '</span>'
        + '<span>作成：はな（AI秘書）／freee人事労務 年調一覧表ボタン　' + (si + 1) + ' / ' + sections.length + '</span></div>');
      h.push('</section>');
    });

    h.push('</body></html>');
    return h.join('\n');
  }

  function openPrintView(table, opts) {
    var w = window.open('', '_blank');
    if (!w) {
      showToast('ポップアップがブロックされたみたい。このサイトのポップアップを許可してね');
      return;
    }
    w.document.open();
    w.document.write(buildPrintHtml(table, opts));
    w.document.close();
    // 描画が終わってから印刷ダイアログを開く（保存先で「PDFに保存」を選べばPDFになる）
    setTimeout(function () {
      try { w.focus(); w.print(); } catch (e) { /* ユーザーが閉じた場合など */ }
    }, 400);
  }

  /* ===================== トースト ===================== */

  var toastShownAt = {};

  function showToast(msg, dedupeKey) {
    var now = Date.now();
    if (dedupeKey) {
      if (toastShownAt[dedupeKey] && now - toastShownAt[dedupeKey] < 15000) return;
      toastShownAt[dedupeKey] = now;
    }
    if (!isNenchoPage()) return; // 年調画面以外ではトーストも出さない
    ensureRoot();
    var root = document.getElementById(ROOT_ID);
    if (!root) return;
    var box = document.getElementById('fnl-toasts');
    if (!box) {
      box = el('div', { id: 'fnl-toasts' });
      root.appendChild(box);
    }
    var t = el('div', { class: 'fnl-toast', text: msg });
    box.appendChild(t);
    setTimeout(function () { t.className = 'fnl-toast fnl-toast-show'; }, 30);
    setTimeout(function () {
      t.className = 'fnl-toast';
      setTimeout(function () { if (t.parentNode) t.remove(); }, 400);
    }, 3500);
  }

  /* ===================== パネル共通 ===================== */

  var currentTab = 'list';

  function enablePanelResize(panel) {
    var handle = panel.querySelector('.fnl-resize');
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

    var body = el('div', { class: 'fnl-panel-body' });
    var tabs = [
      { id: 'list', label: '年調一覧表' },
      { id: 'dev', label: '⚙ 開発情報' }
    ];
    var nav = el('div', { class: 'fnl-tabs' }, tabs.map(function (t) {
      return el('button', {
        class: 'fnl-tab' + (t.id === currentTab ? ' fnl-tab-active' : ''),
        text: t.label,
        onclick: function () { openPanel(t.id); }
      });
    }));

    var panel = el('div', { id: PANEL_ID }, [
      el('div', { class: 'fnl-resize', title: 'ドラッグで幅を調整' }),
      el('div', { class: 'fnl-panel-header' }, [
        el('span', { class: 'fnl-panel-title', text: '年調一覧表' }),
        el('button', { class: 'fnl-close', text: '×', onclick: closePanel })
      ]),
      nav,
      body
    ]);
    document.getElementById(ROOT_ID).appendChild(panel);

    chrome.storage.local.get([PANEL_W_KEY], function (res) {
      var w = res && res[PANEL_W_KEY];
      if (w) panel.style.width = Math.min(w, Math.floor(window.innerWidth * 0.95)) + 'px';
    });
    enablePanelResize(panel);

    if (currentTab === 'list') renderList(body);
    else renderDev(body);
  }

  /* ===================== ① 年調一覧表（v0.2 年調専用ビルダー） ===================== */

  // 対象年の推定: URLハッシュ（#/2025 形式）→ パス → 時期から推定
  function detectYear() {
    var m = (location.hash || '').match(/(20\d{2})/);
    if (m) return Number(m[1]);
    var m2 = (location.pathname + location.search).match(/(20\d{2})/);
    if (m2) return Number(m2[1]);
    var d = new Date();
    // 年調シーズン（11月〜）は当年分、それ以外は前年分を見ることが多い
    return d.getMonth() >= 10 ? d.getFullYear() : d.getFullYear() - 1;
  }

  function apiGet(path) {
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
      return res.json();
    });
  }

  // 従業員一覧本体
  function fetchNenchoList(year) {
    return apiGet('/api/p/nemmatsu_chosei/nemmatsu_choseis?year=' + year);
  }

  // 法人名（PDFヘッダー用）のフォールバック。切替可能事業所一覧から「現在の事業所」を特定できたときだけ返す。
  // ※実環境のauth_companiesには現在事業所フラグがなく通常は空文字になる。
  //   第一ソースは従業員別詳細の company_information.name（renderList側・v0.4.1）
  // スキーマが想定と違っても一覧表本体には影響させない（失敗したら空文字）
  function fetchCompanyName() {
    return apiGet('/api/p/auth_companies').then(function (data) {
      var arr = (data && (data.companies || data.auth_companies)) ||
        (Array.isArray(data) ? data : []);
      if (!Array.isArray(arr)) return '';
      var cur = null;
      for (var i = 0; i < arr.length; i++) {
        var c = arr[i];
        if (c && (c.is_current === true || c.current === true || c.selected === true)) { cur = c; break; }
      }
      var curId = data && (data.current_company_id || data.company_id);
      if (!cur && curId != null) {
        for (var j = 0; j < arr.length; j++) {
          if (arr[j] && arr[j].id === curId) { cur = arr[j]; break; }
        }
      }
      if (!cur && arr.length === 1) cur = arr[0];
      return (cur && (cur.display_name || cur.name)) || '';
    }).catch(function () { return ''; });
  }

  var detailCache = {}; // 'year:empId' -> 従業員別の計算結果（タブを閉じるまでのメモリキャッシュ）

  function fetchEmployeeDetail(year, empId) {
    var key = year + ':' + empId;
    if (detailCache[key]) return Promise.resolve(detailCache[key]);
    return apiGet('/api/p/yearend_adjustments/' + year + '/employees/' + empId).then(function (d) {
      detailCache[key] = d;
      return d;
    });
  }

  // 3並列で全員分の詳細を取得する（失敗した従業員はnullのまま続行）
  function fetchAllDetails(year, emps, onProgress) {
    var results = new Array(emps.length);
    var next = 0;
    var done = 0;
    return new Promise(function (resolve) {
      if (emps.length === 0) { resolve(results); return; }
      function pump() {
        if (next >= emps.length) return;
        var i = next++;
        fetchEmployeeDetail(year, emps[i].id).then(
          function (d) { results[i] = d; },
          function () { results[i] = null; }
        ).then(function () {
          done++;
          if (onProgress) onProgress(done, emps.length);
          if (done === emps.length) resolve(results);
          else pump();
        });
      }
      for (var k = 0; k < Math.min(3, emps.length); k++) pump();
    });
  }

  // freee申告「年末調整データ一覧表」ふうの列構成
  var NENCHO_COLS = [
    '従業員番号', '氏名', '年調対象', '退職', 'ステータス',
    '給与収入', '給与所得控除後', '社会保険料控除', '生命保険料控除', '地震保険料控除',
    '配偶者控除等', '扶養控除等', '基礎控除', '所得控除合計',
    '課税給与所得', '算出所得税', '住宅ローン控除', '年調年税額', '過不足額', '備考'
  ];

  // PDFは20列を1枚に詰めず、A4横2シートに分けて文字サイズを確保する（design.mdの極小文字禁止）
  var PDF_MAIN_COLS = [
    '従業員番号', '氏名', '年調対象', '退職',
    '給与収入', '給与所得控除後', '所得控除合計', '課税給与所得',
    '算出所得税', '住宅ローン控除', '年調年税額', '過不足額'
  ];
  var PDF_DETAIL_COLS = [
    '従業員番号', '氏名',
    '社会保険料控除', '生命保険料控除', '地震保険料控除',
    '配偶者控除等', '扶養控除等', '基礎控除', '所得控除合計',
    'ステータス', '備考'
  ];

  // 数値化（"1,234" のようなカンマ入り文字列も許容。数値にならないものは null）
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.replace(/[,\s]/g, '') !== '') {
      var n = Number(v.replace(/,/g, ''));
      return isFinite(n) ? n : null;
    }
    return null;
  }

  // 候補を順に見て、最初に数値になったものを返す（0は有効値として採用）
  function pickNum() {
    for (var i = 0; i < arguments.length; i++) {
      var n = toNum(arguments[i]);
      if (n != null) return n;
    }
    return null;
  }

  // v0.4: 対象外の従業員に埋めない年調計算列（freee申告の一覧表と同じく空欄にする）
  var NENCHO_CALC_COLS = [
    '給与所得控除後', '社会保険料控除', '生命保険料控除', '地震保険料控除',
    '配偶者控除等', '扶養控除等', '基礎控除', '所得控除合計',
    '課税給与所得', '算出所得税', '住宅ローン控除', '年調年税額', '過不足額'
  ];

  function buildNenchoRow(emp, d) {
    // 金額ソースの優先順位（v0.4で変更）:
    //   控除系 … 源泉徴収簿（field_XX）を第一に
    //   税額系 … adjustment_amounts を第一に（balanceの符号=マイナス還付が確定済みのため）
    //   源泉徴収票（withholding_tax_statement）は未発行だと空になるので最後の補完に回す
    // v0.4.1: extra_data は adjustment_amounts の中にネストしている（実キャプチャのJSONパースで確定。
    // v0.4はトップレベルを見ていたため源泉徴収簿が常に空扱いだった）。トップレベルにも念のため対応
    var adj = (d && d.adjustment_amounts) || {};
    var extra = adj.extra_data || (d && d.extra_data) || {};
    var reg = (extra.withholding_tax_register && extra.withholding_tax_register.data) || {};
    var wts = (extra.withholding_tax_statement && extra.withholding_tax_statement.data) ||
      (d && d.withholding_tax_statement && d.withholding_tax_statement.data) || {};
    var kojoList = (d && d.calculation_results && d.calculation_results.kojo &&
      d.calculation_results.kojo.haigusha_kojo_fuyo_kojo) || [];
    var spouseKojo = 0;
    var fuyoKojo = 0;
    kojoList.forEach(function (k) {
      if (k.tsuzukigara === 'spouse') spouseKojo += k.kojo_gaku || 0;
      else fuyoKojo += k.kojo_gaku || 0;
    });
    var isTaisho = !!emp.is_taisho;
    var remark = '';
    if (!d && isTaisho) remark = '計算結果の取得に失敗';

    var row = {
      '従業員番号': emp.employee_number || '',
      '氏名': emp.name || '',
      '年調対象': isTaisho ? '対象' : '対象外',
      '退職': emp.is_retired ? '退職' : '',
      'ステータス': (emp.statuses || []).join('・'),
      '給与収入': pickNum(d && d.total_payment, reg.field_01, wts.payment_amount)
    };

    if (isTaisho) {
      // 社会保険料控除 = 給与等からの控除分(field_12) + 申告による控除分(field_13)
      var shakaiKyuyo = toNum(reg.field_12);
      var shakaiShinkoku = toNum(reg.field_13);
      row['給与所得控除後'] = pickNum(reg.field_09, wts.employment_income_amount);
      row['社会保険料控除'] = (shakaiKyuyo != null || shakaiShinkoku != null)
        ? (shakaiKyuyo || 0) + (shakaiShinkoku || 0)
        : pickNum(wts.social_insurance_deduction_amount);
      row['生命保険料控除'] = pickNum(reg.field_15, adj.life_insurance_deduction, wts.life_insurance_deduction_amount);
      row['地震保険料控除'] = pickNum(reg.field_16, adj.earthquake_insurance_deduction, wts.earthquake_insurance_deduction_amount);
      // adj.spouse_deduction / adj.dependents_deduction は実データで（控除があるのに）0が入ることが
      // 確認済みのため候補に入れない（v0.4.1。v0.4でここの0が採用されて配偶者控除が0になる退行が出た）
      row['配偶者控除等'] = pickNum(reg.field_17, spouseKojo || null, wts.spouse_special_deduction_amount);
      row['扶養控除等'] = pickNum(reg.field_18, fuyoKojo || null);
      row['基礎控除'] = pickNum(reg.field_20, d && d.basic_deduction, wts.basic_deduction_amount);
      row['所得控除合計'] = pickNum(reg.field_21, wts.deduction_amount);
      row['課税給与所得'] = pickNum(adj.taxable_earned_income, reg.field_22);
      row['算出所得税'] = pickNum(adj.calculated_income_tax, reg.field_23);
      row['住宅ローン控除'] = pickNum(adj.housing_loan_deduction, reg.field_24);
      row['年調年税額'] = pickNum(adj.adjusted_annual_tax, reg.field_26, wts.withheld_tax_amount);
      row['過不足額'] = pickNum(adj.balance, reg.field_27);
    } else {
      // 対象外: freeeが内部に持つ試算値を表に出さない（freee申告の一覧表も対象外の年調欄は空欄）
      NENCHO_CALC_COLS.forEach(function (c) { row[c] = null; });
    }

    row['備考'] = remark;
    return row;
  }

  function renderList(body) {
    var year = detectYear();
    var status = el('p', { class: 'fnl-summary', text: year + '年分の対象者一覧を取得中…' });
    var area = el('div', {});
    body.appendChild(status);
    body.appendChild(area);

    Promise.all([fetchNenchoList(year), fetchCompanyName()]).then(function (resArr) {
      var list = resArr[0];
      var companyName = resArr[1] || '';
      var emps = (list && list.employees) || [];
      if (emps.length === 0) {
        status.textContent = year + '年分の従業員が0名だったよ。年をまたいでいたら年末調整の画面で対象年を開き直してみてね。';
        return;
      }
      status.textContent = '従業員 ' + emps.length + ' 名の計算結果を取得中… (0/' + emps.length + ')';
      fetchAllDetails(year, emps, function (done, total) {
        status.textContent = '従業員 ' + total + ' 名の計算結果を取得中… (' + done + '/' + total + ')';
      }).then(function (details) {
        var rows = emps.map(function (emp, i) { return buildNenchoRow(emp, details[i]); });
        // v0.4.1: 法人名は従業員別詳細のトップレベル company_information.name が確実
        // （auth_companiesには現在事業所を示すフラグがなく特定できないため、こちらを第一ソースにする）
        for (var di = 0; di < details.length; di++) {
          var ci = details[di] && details[di].company_information;
          if (ci && ci.name) { companyName = ci.name; break; }
        }
        var failed = 0;
        emps.forEach(function (emp, i) { if (!details[i] && emp.is_taisho) failed++; });
        var taisho = emps.filter(function (e) { return e.is_taisho; }).length;
        // v0.4: 対象外の行は過不足額がnullなので、合計は自然と年調対象者のみになる
        var totalBalance = 0;
        rows.forEach(function (r) {
          if (typeof r['過不足額'] === 'number') totalBalance += r['過不足額'];
        });
        status.textContent = year + '年分・全 ' + emps.length + ' 名（年調対象 ' + taisho + ' 名）'
          + '　過不足額合計（対象者のみ） ' + totalBalance.toLocaleString('ja-JP') + ' 円'
          + (failed ? '　※対象者 ' + failed + ' 名の計算結果が取得できなかったよ' : '');
        var reiwa = year - 2018; // 令和N年 = 西暦 - 2018（2025年 → 令和7年）
        var printOpts = {
          title: '令和' + reiwa + '年分（' + year + '年分）年末調整データ一覧表',
          subtitle: (companyName ? companyName + '　' : '')
            + '出力日 ' + today().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
          stats: [
            { label: '従業員数', value: emps.length + ' 名' },
            { label: '年調対象', value: taisho + ' 名' },
            { label: '過不足額合計（対象者のみ）', value: totalBalance.toLocaleString('ja-JP') + ' 円' }
          ],
          footNote: '過不足額はマイナス＝還付。金額は源泉徴収簿ベース（freee人事労務の内部データ・読み取りのみ）。年調対象外の従業員は年調計算列を空欄にしている',
          sections: [
            { heading: '① 税額サマリー', cols: PDF_MAIN_COLS },
            { heading: '② 所得控除の内訳', cols: PDF_DETAIL_COLS }
          ]
        };
        renderExportableTable(area, { cols: NENCHO_COLS, rows: rows }, '年末調整データ一覧_' + year + '年分', printOpts);
        area.appendChild(note('過不足額はマイナス＝還付だよ。金額は源泉徴収簿ベース（freee内部APIの読み取りのみ・書き込みなし）。年調対象外の従業員は給与収入だけ表示して、年調計算列は空欄にしてるよ。PDF出力は印刷ダイアログで「PDFに保存」を選んでね。'));
      });
    }).catch(function (e) {
      log('nencho list fetch failed', e);
      status.textContent = '一覧API（' + year + '年分）が取得できなかったから、キャプチャ済みデータ・画面の表から組み立てるね。';
      renderGenericList(area);
    });
  }

  // 表＋CSV/TSV/PDFボタンの共通描画
  function renderExportableTable(area, table, csvBaseName, printOpts) {
    var buttons = [
      el('button', {
        class: 'fnl-btn fnl-btn-primary', text: '📥 CSVダウンロード',
        onclick: function () { downloadCsv(table, csvBaseName); }
      }),
      el('button', {
        class: 'fnl-btn', text: 'TSVコピー（Excel貼り付け用）',
        onclick: function (ev) { copyText(toTsv(table), ev.target); }
      })
    ];
    if (printOpts) {
      buttons.push(el('button', {
        class: 'fnl-btn', text: '🖨 PDF出力',
        onclick: function () { openPrintView(table, printOpts); }
      }));
    }
    area.appendChild(el('div', { class: 'fnl-row' }, buttons));
    var t = el('table', { class: 'fnl-table' });
    t.appendChild(el('tr', {}, table.cols.map(function (c) {
      return el('th', { text: c });
    })));
    table.rows.slice(0, MAX_ROWS_DISPLAY).forEach(function (r) {
      t.appendChild(el('tr', {}, table.cols.map(function (c) {
        var v = r[c];
        var isNum = typeof v === 'number';
        return el('td', { class: isNum ? 'fnl-num' : '', text: fmtCell(v) });
      })));
    });
    area.appendChild(el('div', { class: 'fnl-table-wrap' }, [t]));
    if (table.rows.length > MAX_ROWS_DISPLAY) {
      area.appendChild(note('表示は先頭' + MAX_ROWS_DISPLAY + '行まで（CSVには全' + table.rows.length + '行入るよ）。'));
    }
  }

  /* ---- 汎用フォールバック（v0.1方式: 受動キャプチャ＋画面テーブル読み取り） ---- */

  function renderGenericList(body) {
    loadSavedCaptures(function () {
      var datasets = collectDatasets();
      var domSets = scrapeDomTables();
      var all = datasets.concat(domSets);

      if (all.length === 0) {
        body.appendChild(note('まだ一覧にできるデータがないよ。年末調整の対象者一覧の画面を一度開き直して（再読み込みして）から、もう一度このボタンを押してね。'));
        body.appendChild(note('それでも出ないときは「⚙ 開発情報」タブのAPIキャプチャをコピーして、ローカルのClaude Code（はな）に貼ってくれたら専用対応するよ。'));
        return;
      }

      var selected = 0;
      var area = el('div', {});

      var options = all.map(function (d, i) {
        var tag = d.source === 'api' ? 'API' : '画面';
        return el('option', { value: String(i), text: '[' + tag + '] ' + d.label });
      });
      var select = el('select', { class: 'fnl-input' }, options);
      select.addEventListener('change', function () {
        selected = Number(select.value) || 0;
        renderTable();
      });

      body.appendChild(note('データの出どころを選んでCSVに出せるよ。従業員一覧らしきものを自動で先頭に選んでるよ。'));
      body.appendChild(el('div', { class: 'fnl-row' }, [select]));
      body.appendChild(area);

      function renderTable() {
        area.textContent = '';
        var ds = all[selected];
        if (!ds) return;
        var table = buildTableData(ds.rows);

        area.appendChild(el('p', {
          class: 'fnl-summary',
          text: ds.rows.length + ' 行 × ' + table.cols.length + ' 列'
            + (ds.source === 'api' ? '（freee内部APIの読み取り・' + String(ds.at).slice(0, 10) + ' 取得）' : '（画面の表の読み取り）')
        }));

        area.appendChild(el('div', { class: 'fnl-row' }, [
          el('button', {
            class: 'fnl-btn fnl-btn-primary', text: '📥 CSVダウンロード',
            onclick: function () { downloadCsv(table); }
          }),
          el('button', {
            class: 'fnl-btn', text: 'TSVコピー（Excel貼り付け用）',
            onclick: function (ev) { copyText(toTsv(table), ev.target); }
          }),
          el('button', {
            class: 'fnl-btn', text: '🖨 PDF出力',
            onclick: function () {
              openPrintView(table, {
                title: '年末調整データ一覧表',
                subtitle: '出力日 ' + today().replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
                footNote: ds.label + '（汎用読み取り方式）'
              });
            }
          })
        ]));

        var t = el('table', { class: 'fnl-table' });
        t.appendChild(el('tr', {}, table.cols.map(function (c) {
          return el('th', { text: c });
        })));
        table.rows.slice(0, MAX_ROWS_DISPLAY).forEach(function (r) {
          t.appendChild(el('tr', {}, table.cols.map(function (c) {
            var v = r[c];
            var isNum = typeof v === 'number';
            return el('td', { class: isNum ? 'fnl-num' : '', text: fmtCell(v) });
          })));
        });
        area.appendChild(el('div', { class: 'fnl-table-wrap' }, [t]));
        if (table.rows.length > MAX_ROWS_DISPLAY) {
          area.appendChild(note('表示は先頭' + MAX_ROWS_DISPLAY + '行まで（CSVには全' + table.rows.length + '行入るよ）。'));
        }
        area.appendChild(note('（フォールバック表示）一覧APIが使えなかったから汎用の読み取り方式で出してるよ。列名は内部APIの項目名のまま。⚙開発情報のキャプチャをはなに貼ってくれたら調整するね。'));
      }

      renderTable();
    });
  }

  /* ===================== ② 開発情報 ===================== */

  function renderDev(body) {
    body.appendChild(note('この画面の構造を回収して拡張を精緻化するためのタブだよ。下のボタンでコピーして、ローカルのClaude Code（はな）のチャットに貼ってね。従業員の個人情報が含まれるから、外部サービスには絶対貼らないでね。'));

    loadSavedCaptures(function () {
      var merged = savedCaptures.concat(captures);
      body.appendChild(el('p', {
        class: 'fnl-summary',
        text: 'このタブのAPIキャプチャ: ' + captures.length + ' 件 ／ 保存済み年調キャプチャ: ' + savedCaptures.length + ' 件'
      }));

      body.appendChild(el('div', { class: 'fnl-row' }, [
        el('button', {
          class: 'fnl-btn fnl-btn-primary', text: '年調APIキャプチャをコピー',
          onclick: function (ev) {
            var slim = merged.filter(function (c) { return isNenchoUrl(c.url); }).map(function (c) {
              return { method: c.method, url: c.url, status: c.status, at: c.at, truncated: c.truncated, body: c.body };
            });
            copyText(JSON.stringify(slim, null, 1), ev.target);
          }
        }),
        el('button', {
          class: 'fnl-btn', text: '全APIキャプチャをコピー',
          onclick: function (ev) {
            var slim = captures.map(function (c) {
              return { method: c.method, url: c.url, status: c.status, at: c.at, truncated: c.truncated, body: c.body };
            });
            copyText(JSON.stringify(slim, null, 1), ev.target);
          }
        }),
        el('button', {
          class: 'fnl-btn', text: '保存済みキャプチャを消す',
          onclick: function (ev) {
            chrome.storage.local.remove([CAP_KEY], function () {
              savedCaptures = [];
              ev.target.textContent = '✓ 消したよ';
            });
          }
        })
      ]));

      if (captures.length > 0 || savedCaptures.length > 0) {
        var table = el('table', { class: 'fnl-table' });
        table.appendChild(el('tr', {}, [el('th', { text: 'メソッド' }), el('th', { text: 'URL' }), el('th', { text: 'サイズ' })]));
        merged.slice(-40).reverse().forEach(function (c) {
          var path = c.url.replace(/^https?:\/\/[^/]+/, '');
          table.appendChild(el('tr', {}, [
            el('td', { text: c.method + ' ' + c.status }),
            el('td', { text: path.slice(0, 80) }),
            el('td', { class: 'fnl-num', text: (c.body || '').length.toLocaleString() })
          ]));
        });
        body.appendChild(el('div', { class: 'fnl-table-wrap' }, [table]));
      } else {
        body.appendChild(note('APIキャプチャがまだ0件だよ。ページを再読み込みしてから画面を操作すると、freeeが呼ぶAPIが記録されるよ。'));
      }
    });
  }

  /* ===================== ボタン注入（インライン優先） ===================== */

  var INLINE_ID = 'fnl-inline';

  function ensureRoot() {
    if (!document.getElementById(ROOT_ID)) {
      (document.body || document.documentElement).appendChild(el('div', { id: ROOT_ID }));
    }
  }

  function buildButtons(cls, devCls) {
    return [
      el('button', { class: cls, text: '年調一覧表', onclick: function () { openPanel('list'); } }),
      el('button', { class: cls + ' ' + devCls, text: '⚙', title: '開発情報', onclick: function () { openPanel('dev'); } })
    ];
  }

  // freee画面の既存ボタン列を探す（shinkoku-supportと同じヒューリスティック）
  function findInlineAnchor() {
    var root = document.getElementById(ROOT_ID);
    var inline = document.getElementById(INLINE_ID);
    var groups = [];
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (root && root.contains(b)) continue;
      if (inline && inline.contains(b)) continue;
      if (!b.offsetParent) continue;
      var r = b.getBoundingClientRect();
      if (r.width === 0 || r.top < 40 || r.top > 420) continue;
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

  function removeUi() {
    var inline = document.getElementById(INLINE_ID);
    if (inline) inline.remove();
    var floatBar = document.getElementById('fnl-float');
    if (floatBar) floatBar.remove();
  }

  function injectToolbar() {
    if (!isNenchoPage()) {
      removeUi(); // SPAで年調以外の画面に移ったらボタンを引っ込める
      return;
    }
    ensureRoot();

    if (!document.getElementById(INLINE_ID)) {
      var anchor = findInlineAnchor();
      if (anchor) {
        anchor.appendChild(el('span', { id: INLINE_ID }, [
          el('span', { class: 'fnl-inline-logo', text: '🌸' })
        ].concat(buildButtons('fnl-inline-btn', 'fnl-inline-dev'))));
        log('inline buttons injected');
      }
    }

    var hasInline = !!document.getElementById(INLINE_ID);
    var floatBar = document.getElementById('fnl-float');
    if (hasInline) {
      if (floatBar) floatBar.remove();
    } else if (!floatBar) {
      document.getElementById(ROOT_ID).appendChild(
        el('div', { id: 'fnl-float', class: 'fnl-toolbar' }, [
          el('span', { class: 'fnl-toolbar-logo', text: '🌸' })
        ].concat(buildButtons('fnl-tbtn', 'fnl-tbtn-dev')))
      );
      log('floating toolbar injected');
    }
  }

  loadSavedCaptures();
  injectToolbar();

  // SPAの再描画でツールバーが消えたら復元する
  var scheduled = false;
  new MutationObserver(function () {
    if (!scheduled) {
      scheduled = true;
      setTimeout(function () {
        scheduled = false;
        injectToolbar();
      }, 500);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
