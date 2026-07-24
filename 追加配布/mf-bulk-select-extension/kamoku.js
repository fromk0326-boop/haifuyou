// MF会計「連携サービスから入力」科目ボタンパネル＋「これ、何費？」検索
// 対応ページ: /transaction_journals（通帳・カード他）, /journalable_dists（ビジネスカテゴリ）
//
// 使い方:
//   1. 明細行の勘定科目ボタンをクリック（ドロップダウンが開く）
//   2. パネルの科目ボタンをクリック → その科目を選択して確定
//   ドロップダウンが閉じてしまっていても、直前にクリックした勘定科目ボタンを
//   覚えているので、自動で開き直してから選択する。
//
// 実装メモ:
// - MFの勘定科目はコンボボックスでなくReact製ドロップダウン。
//   ボタンclick → body直下のポータルに [class*="dropDownListItems"] が出現し、
//   その子要素（.isSelectable）をclickすると選択・確定される（実機検証済み）。
// - パネルのボタンはmousedownでpreventDefault+stopPropagationし、
//   ページの選択テキスト解除とドロップダウンの外側クリック閉じを極力防ぐ。
//   それでも閉じた場合は lastAccountBtn から開き直すフォールバックが働く。
// - 科目リスト・パネル位置・折りたたみ状態は chrome.storage.local に保存。
//   popup.html から科目リストを編集でき、保存すると即時反映される。

(() => {
  'use strict';

  const PANEL_ID = 'mfkb-panel';
  const NANPI_URL = 'https://nanpi.pages.dev/';

  // デフォルト科目（この事業所のMF標準科目名で存在確認済みのもの）
  const DEFAULT_KAMOKU = [
    '会議費',
    '接待交際費',
    '旅費交通費',
    '通信費',
    '備品・消耗品費',
    '支払手数料',
    '広告宣伝費',
    '新聞図書費',
    '諸会費',
    '支払報酬',
  ];

  const storage = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)
    ? chrome.storage.local
    : {
        // テスト注入用フォールバック（拡張外で動かすときだけ使われる）
        get: (keys, cb) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            try { const v = localStorage.getItem('mfkb_' + k); if (v !== null) out[k] = JSON.parse(v); } catch (e) {}
          }
          cb(out);
        },
        set: (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            try { localStorage.setItem('mfkb_' + k, JSON.stringify(v)); } catch (e) {}
          }
        },
      };

  // localStorageミラー（拡張の入れ直し等でchrome.storageが消えても設定を復元するための二重保存。
  // MFページのオリジンに保存されるので、拡張を入れ直してもリストが残る）
  const MIRROR_KEY = 'mfkbMirror';
  function mirrorRead() {
    try { return JSON.parse(localStorage.getItem(MIRROR_KEY)) || {}; } catch (e) { return {}; }
  }
  function mirrorWrite(obj) {
    try { localStorage.setItem(MIRROR_KEY, JSON.stringify(Object.assign(mirrorRead(), obj))); } catch (e) {}
  }
  function saveSettings(obj) {
    storage.set(obj);
    mirrorWrite(obj);
  }

  let kamokuList = DEFAULT_KAMOKU.slice();
  let panelPos = null; // {left, top}
  let collapsed = false;
  let lastAccountBtn = null; // 最後にクリックされた勘定科目（or 補助科目）ボタン
  let lastRow = null; // 最後に操作した明細行（なんぴ検索の候補抽出用）

  const yieldTask = () =>
    new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });

  async function waitFor(fn, timeoutMs) {
    const t0 = performance.now();
    let v = fn();
    while (!v && performance.now() - t0 < timeoutMs) {
      await yieldTask();
      v = fn();
    }
    return v;
  }

  // 開いている科目ドロップダウン（body直下ポータル）
  const openList = () => document.querySelector('[class*="dropDownListItems"]');

  // ---- 行・ボタンの追跡（capture段階で記録） ----
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('#' + PANEL_ID)) return;
      const accBtn = e.target.closest(
        'td[class*="colLedgerAccount"] button, td[class*="itemAndSubItem"] button'
      );
      if (accBtn) {
        lastAccountBtn = accBtn;
        lastRow = accBtn.closest('tr');
        return;
      }
      const tr = e.target.closest('table tbody tr');
      if (tr) lastRow = tr;
    },
    true
  );

  // ---- 科目選択 ----
  async function applyKamoku(name, uiBtn) {
    let list = openList();
    if (!list && lastAccountBtn && lastAccountBtn.isConnected) {
      lastAccountBtn.click();
      list = await waitFor(openList, 2500);
    }
    if (!list) {
      toast('先に明細行の勘定科目ボタンをクリックしてね');
      return;
    }
    const items = [...list.children].filter((el) => /isSelectable/.test(el.className));
    const item =
      items.find((el) => el.textContent.trim() === name) ||
      items.find((el) => el.textContent.trim().startsWith(name));
    if (!item) {
      toast('候補が見つからないよ（科目名を確認してね）');
      return;
    }
    item.click();
    if (uiBtn) flash(uiBtn);
  }

  // ---- なんぴ検索 ----

  // 半角カナ→全角カナ（濁点・半濁点の合成込み）
  const KANA_MAP = {
    'ｶﾞ':'ガ','ｷﾞ':'ギ','ｸﾞ':'グ','ｹﾞ':'ゲ','ｺﾞ':'ゴ','ｻﾞ':'ザ','ｼﾞ':'ジ','ｽﾞ':'ズ','ｾﾞ':'ゼ','ｿﾞ':'ゾ',
    'ﾀﾞ':'ダ','ﾁﾞ':'ヂ','ﾂﾞ':'ヅ','ﾃﾞ':'デ','ﾄﾞ':'ド','ﾊﾞ':'バ','ﾋﾞ':'ビ','ﾌﾞ':'ブ','ﾍﾞ':'ベ','ﾎﾞ':'ボ',
    'ﾊﾟ':'パ','ﾋﾟ':'ピ','ﾌﾟ':'プ','ﾍﾟ':'ペ','ﾎﾟ':'ポ','ｳﾞ':'ヴ',
    'ｱ':'ア','ｲ':'イ','ｳ':'ウ','ｴ':'エ','ｵ':'オ','ｶ':'カ','ｷ':'キ','ｸ':'ク','ｹ':'ケ','ｺ':'コ',
    'ｻ':'サ','ｼ':'シ','ｽ':'ス','ｾ':'セ','ｿ':'ソ','ﾀ':'タ','ﾁ':'チ','ﾂ':'ツ','ﾃ':'テ','ﾄ':'ト',
    'ﾅ':'ナ','ﾆ':'ニ','ﾇ':'ヌ','ﾈ':'ネ','ﾉ':'ノ','ﾊ':'ハ','ﾋ':'ヒ','ﾌ':'フ','ﾍ':'ヘ','ﾎ':'ホ',
    'ﾏ':'マ','ﾐ':'ミ','ﾑ':'ム','ﾒ':'メ','ﾓ':'モ','ﾔ':'ヤ','ﾕ':'ユ','ﾖ':'ヨ',
    'ﾗ':'ラ','ﾘ':'リ','ﾙ':'ル','ﾚ':'レ','ﾛ':'ロ','ﾜ':'ワ','ｦ':'ヲ','ﾝ':'ン',
    'ｧ':'ァ','ｨ':'ィ','ｩ':'ゥ','ｪ':'ェ','ｫ':'ォ','ｬ':'ャ','ｭ':'ュ','ｮ':'ョ','ｯ':'ッ',
    'ｰ':'ー','｡':'。','､':'、','･':'・','｢':'「','｣':'」',
  };
  function toZenkakuKana(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const two = s.slice(i, i + 2);
      if (KANA_MAP[two]) { out += KANA_MAP[two]; i++; continue; }
      out += KANA_MAP[s[i]] || s[i];
    }
    return out;
  }

  // 摘要から検索語の候補を抽出（例:「ﾄﾘﾀｹｿｳﾎﾝﾃﾝ/NFC（TORITAKE SOHONTEN）」→「トリタケソウホンテン」）
  function nanpiCandidate() {
    if (!lastRow || !lastRow.isConnected) return '';
    const ta = lastRow.querySelector('td[class*="colRemarkArea"] textarea');
    if (!ta || !ta.value) return '';
    let t = ta.value;
    // 全角英数・記号→半角
    t = t.replace(/[Ａ-Ｚａ-ｚ０-９．＊／]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    );
    // 半角カナ→全角カナ
    t = toZenkakuKana(t);
    // カタカナ直後のハイフン類は長音（銀行データは「ﾃﾞﾆ-ｽﾞ」のようにASCIIハイフンで来る）
    t = t.replace(/([ァ-ヶー])[-−―‐]/g, '$1ー');
    // カッコ書き・スラッシュ以降を落とし、振込マーカーを除去
    t = t.split('（')[0].split('(')[0].split('/')[0];
    t = t.replace(/^(都度振込|振込入金|振込)[＊*\s]*/, '');
    return t.trim().slice(0, 30);
  }

  // 検索語の優先順: ページ上の選択テキスト → 最後に触った行の摘要 → 手入力ダイアログ
  // 小窓はウィンドウ名 "nanpi" を使い回すので、連続で調べても増えない
  function openNanpi() {
    let q = (window.getSelection() + '').trim();
    if (!q) q = nanpiCandidate();
    if (!q) q = prompt('何費か調べたい語（サービス名・店名など）') || '';
    q = q.trim();
    if (!q) return;
    window.open(
      NANPI_URL + '?q=' + encodeURIComponent(q.slice(0, 30)),
      'nanpi',
      'width=520,height=760'
    );
  }

  // ---- UI ----

  let toastTimer = null;
  function toast(msg) {
    const panel = document.getElementById(PANEL_ID);
    let el = document.getElementById(PANEL_ID + '-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = PANEL_ID + '-toast';
      el.style.cssText =
        'position:absolute;left:0;right:0;bottom:100%;margin-bottom:6px;background:#333;color:#fff;' +
        'padding:6px 10px;border-radius:6px;font-size:12px;line-height:1.4;text-align:center;';
      if (panel) panel.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 2500);
  }

  function flash(btn) {
    const orig = btn.style.background;
    const origColor = btn.style.color;
    btn.style.background = '#22a559';
    btn.style.color = '#fff';
    setTimeout(() => {
      btn.style.background = orig;
      btn.style.color = origColor;
    }, 500);
  }

  function clampIntoViewport(panel) {
    const r = panel.getBoundingClientRect();
    let left = r.left, top = r.top, moved = false;
    if (left + r.width > innerWidth) { left = innerWidth - r.width - 8; moved = true; }
    if (top + r.height > innerHeight) { top = innerHeight - r.height - 8; moved = true; }
    if (left < 0) { left = 8; moved = true; }
    if (top < 0) { top = 8; moved = true; }
    if (moved) {
      panel.style.left = left + 'px';
      panel.style.top = top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
  }

  function buildButtons(body) {
    body.textContent = '';
    for (const name of kamokuList) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = name;
      b.style.cssText =
        'padding:5px 10px;border:1px solid #2c67c8;border-radius:4px;background:#fff;color:#2c67c8;' +
        'cursor:pointer;font-size:12px;font-weight:bold;white-space:nowrap;';
      b.addEventListener('mousedown', (e) => {
        // ドロップダウンの外側クリック閉じ・選択テキスト解除を防ぐ
        e.preventDefault();
        e.stopPropagation();
      });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        applyKamoku(name, b);
      });
      body.appendChild(b);
    }
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;right:20px;bottom:80px;z-index:2147483000;background:#fff;border:1px solid #bbb;' +
      'border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);font-family:sans-serif;width:230px;' +
      'user-select:none;';

    // ヘッダー（ドラッグ・🔍・折りたたみ）
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:6px;padding:6px 8px;background:#2c67c8;color:#fff;' +
      'border-radius:7px 7px 0 0;cursor:move;font-size:12px;font-weight:bold;';
    const title = document.createElement('span');
    title.textContent = '科目ボタン';
    title.style.cssText = 'flex:1;';

    const nanpiBtn = document.createElement('button');
    nanpiBtn.type = 'button';
    nanpiBtn.textContent = '🔍';
    nanpiBtn.title = '「これ、何費？」で検索（選択テキスト→摘要の順で候補）';
    nanpiBtn.style.cssText =
      'border:none;background:rgba(255,255,255,.2);color:#fff;border-radius:4px;cursor:pointer;' +
      'padding:2px 7px;font-size:13px;';
    nanpiBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    nanpiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNanpi();
    });

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.style.cssText = nanpiBtn.style.cssText;
    collapseBtn.addEventListener('mousedown', (e) => e.stopPropagation());

    header.append(title, nanpiBtn, collapseBtn);

    // ボタン領域
    const body = document.createElement('div');
    body.id = PANEL_ID + '-body';
    body.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:8px;';
    buildButtons(body);

    const applyCollapsed = () => {
      body.style.display = collapsed ? 'none' : 'flex';
      collapseBtn.textContent = collapsed ? '＋' : '−';
      collapseBtn.title = collapsed ? '展開' : '折りたたみ';
    };
    applyCollapsed();
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      applyCollapsed();
      saveSettings({ mfkbCollapsed: collapsed });
    });

    panel.append(header, body);
    document.documentElement.appendChild(panel);

    // 保存位置の復元
    if (panelPos && typeof panelPos.left === 'number') {
      panel.style.left = panelPos.left + 'px';
      panel.style.top = panelPos.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    clampIntoViewport(panel);

    // ヘッダードラッグで移動、離したら位置を保存
    let drag = null;
    header.addEventListener('mousedown', (e) => {
      if (e.target !== header && e.target !== title) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = e.clientX - drag.dx + 'px';
      panel.style.top = e.clientY - drag.dy + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!drag) return;
      drag = null;
      clampIntoViewport(panel);
      const r = panel.getBoundingClientRect();
      panelPos = { left: r.left, top: r.top };
      saveSettings({ mfkbPos: panelPos });
    });
    window.addEventListener('resize', () => clampIntoViewport(panel));
  }

  // ---- 起動 ----
  // chrome.storageを正、localStorageミラーを副として読む。
  // chrome.storage側が空（拡張入れ直し直後など）ならミラーから復元して書き戻す。
  storage.get(['mfkbKamoku', 'mfkbPos', 'mfkbCollapsed'], (data) => {
    const mirror = mirrorRead();
    let restored = false;
    if (Array.isArray(data.mfkbKamoku) && data.mfkbKamoku.length) {
      kamokuList = data.mfkbKamoku;
    } else if (Array.isArray(mirror.mfkbKamoku) && mirror.mfkbKamoku.length) {
      kamokuList = mirror.mfkbKamoku;
      restored = true;
    }
    panelPos = data.mfkbPos || mirror.mfkbPos || null;
    collapsed = data.mfkbCollapsed !== undefined ? !!data.mfkbCollapsed : !!mirror.mfkbCollapsed;
    if (restored) storage.set({ mfkbKamoku: kamokuList });
    injectPanel();
  });

  // popupで科目リストが保存されたら即反映
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.mfkbKamoku) return;
      const v = changes.mfkbKamoku.newValue;
      if (Array.isArray(v) && v.length) {
        kamokuList = v;
        mirrorWrite({ mfkbKamoku: v }); // popupからの保存もミラーに反映
        const body = document.getElementById(PANEL_ID + '-body');
        if (body) buildButtons(body);
      }
    });
  }

  // Reactの再レンダリングでパネルが消えたら差し直す
  new MutationObserver(() => {
    if (!document.getElementById(PANEL_ID)) injectPanel();
  }).observe(document.body, { childList: true, subtree: true });
})();
