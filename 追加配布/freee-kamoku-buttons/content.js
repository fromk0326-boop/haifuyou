// freee勘定科目ボタン - content script
(function () {
  'use strict';

  const ACCOUNT_INPUT_SELECTOR =
    'input[data-testid="input-account-item"], input[id$="-account-item"], input[name="account_item"], input[placeholder="勘定科目"]';

  const PARTNER_INPUT_SELECTOR = 'input[placeholder="取引先・品目・部門・メモタグ"]';

  // 対象入力欄（勘定科目 or 取引先タグ）両方を拾うためのセレクタ
  const TARGET_INPUT_SELECTOR = `${ACCOUNT_INPUT_SELECTOR}, ${PARTNER_INPUT_SELECTOR}`;

  // 取引先名の抽出ヒューリスティックで使う法人格マーカー（全角括弧「）」の前置き）。
  // 複数文字のマーカーを先に照合する（「ゼイ）」が「イ）」に先取りされないように順序が意味を持つ）
  const PARTNER_MARKERS = [
    'シホウ）', // 司法書士法人
    'カンサ）', // 監査法人
    'ロウム）', // 社会保険労務士法人
    'ゼイ）', // 税理士法人
    'ギヨ）', // 行政書士法人
    'ベン）', // 弁護士法人
    'シヤ）', // 社団法人
    'ザイ）', // 財団法人
    'ガク）', // 学校法人
    'フク）', // 社会福祉法人
    'カ）', // 株式会社
    'ホ）', // 報酬等
    'ド）', // 合同会社
    'ユ）', // 有限会社
    'エ）', // 営業所
    'シ）', // 合資会社等
    'イ）', // 医療法人
  ];

  // 士業法人マーカー → 法人格名（漢字推定APIへのヒント）。
  // カナ名義は読みから漢字が復元しにくいため、士業法人に限りローカルの
  // ダッシュボードサーバー経由でWeb検索による漢字名の推定を行う
  const SHIGYO_ENTITY_MAP = [
    ['シホウ）', '司法書士法人'],
    ['カンサ）', '監査法人'],
    ['ロウム）', '社会保険労務士法人'],
    ['ゼイ）', '税理士法人'],
    ['ギヨ）', '行政書士法人'],
    ['ベン）', '弁護士法人'],
  ];

  // カナ名義そのものに含まれる士業キーワード → 種別名（法人格マーカーが無い振込名義用。
  // 例:「ハシモトソウゴウホウリツジムシヨ」→ 法律事務所）。全銀カナは拗音が大文字になるため
  // 「ジムシヨ」表記で照合する。長い・specificなキーワードを先に、汎用の「ジムシヨ」（事務所）は最後
  const SHIGYO_NAME_KEYWORDS = [
    ['ホウリツジムシ', '法律事務所'],
    ['カイケイジムシ', '会計事務所'],
    ['トツキヨジムシ', '特許事務所'],
    ['カンサホウジン', '監査法人'],
    ['ゼイリシ', '税理士事務所'],
    ['カイケイシ', '公認会計士事務所'],
    ['シホウシヨシ', '司法書士事務所'],
    ['ギヨウセイシヨシ', '行政書士事務所'],
    ['シヤカイホケンロウムシ', '社会保険労務士事務所'],
    ['シヤロウシ', '社会保険労務士事務所'],
    ['ベンリシ', '弁理士事務所'],
    ['ジムシヨ', '事務所'],
  ];

  // 名義の先頭に肩書きとして付く士業タイトル（例:「振込＊ベンゴシ ニシムラ アキラ」）。
  // 個人の士業への振込で使われる。候補名からは除外しつつ、漢字推定のヒントに使う。
  // 「コウニンカイケイシ」を「カイケイシ」より先に照合する（部分一致の先取り防止）
  const SHIGYO_TITLE_KEYWORDS = [
    ['コウニンカイケイシ', '公認会計士'],
    ['シヤカイホケンロウムシ', '社会保険労務士'],
    ['ギヨウセイシヨシ', '行政書士'],
    ['シホウシヨシ', '司法書士'],
    ['ベンゴシ', '弁護士'],
    ['ゼイリシ', '税理士'],
    ['カイケイシ', '公認会計士'],
    ['シヤロウシ', '社会保険労務士'],
    ['ベンリシ', '弁理士'],
  ];

  // ハタケダッシュボード（server.py）の漢字推定エンドポイント。未起動なら静かにスキップする
  const PARTNER_KANJI_API_URL = 'http://localhost:3460/api/partner-kanji';

  // AI科目点検エンドポイント（自動経理で起票済みの科目を二次点検。判定は表示のみ、書き換えはしない）
  const KEIRI_CHECK_API_URL = 'http://localhost:3460/api/keiri-check';

  // 勘定科目辞典「これ、何費？」。ヘッダーの🔍ボタンから小窓で開く
  const NANPI_URL = 'https://nanpi.pages.dev/';

  // 摘要抽出を打ち切るノイズトークンの判定
  const PARTNER_NOISE_PATTERNS = [
    /^[0-9,\-−―]+$/, // 金額・マイナス記号
    /取引登録/,
    /適格/,
    /課税売上/,
    /適切な取引内容/,
  ];

  // カタカナ・英字・長音（全角ー/半角ｰ/全角ハイフンマイナス－）・中黒・全半角スペースのみで構成されるか
  const PARTNER_NAME_LIKE_RE = /^[ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ・･\-－\s　]+$/;

  // 「自動で経理の詳細」ページ（/wallet_txns/stream/<数字ID>）の取引先タグ入力欄コンテナ
  const PARTNER_DETAIL_CONTAINER_SELECTOR = '.deal-editor-common-partner';

  // カード明細等、振込系キーワードがない摘要から取引先候補を推測する際の除外ワード（一般語）
  const PARTNER_FALLBACK_GENERIC_WORDS = [
    'オンライン',
    '備品',
    '購入',
    'カード',
    'デビット',
    '利用',
    '支払',
    '決済',
    'ショッピング',
    'サブスク',
    '一括',
    '分割',
    'リボ',
    '手数料',
    '税込',
    '税抜',
    // freee新レイアウトの詳細ページで行コンテナに混入するUIラベル・キーボード操作ヘルプ文言
    '上下左右',
    'ハイライト',
    'Enterキー',
    '勘定科目',
    '取引先',
    '税区分',
    'メモタグ',
  ];

  // 英字トークン(3文字以上)・カタカナ連続(3文字以上)を区切るための分割記号
  const PARTNER_FALLBACK_SPLIT_RE = /[*＊_\/．.\-－]+/;

  // ドメイン形式の表記（例: COMFY.ORG、AMAZON.CO.JP）。カード明細ではサービス名が
  // ドメインそのままのことがあり、ピリオドで分割すると名前が欠けるため、分割前に丸ごと候補として拾う。
  // 末尾ラベルは英字のみ2〜6文字（「NO.1」のような番号表記や「MICROSOFT 36」の数字は対象にしない）
  const PARTNER_FALLBACK_DOMAIN_RE = /[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z]{2,6})+/;

  // フォールバック抽出の名前候補: 英字・カタカナ・漢字始まりの連続3文字以上。
  // 数字・長音・中黒は2文字目以降のみ許容（WEB3AUTHが「3」で分断されないように）。
  // 漢字を含めることで「一社日本ワーケーション協会」のような名称を途中で切らず最後まで拾う
  const PARTNER_FALLBACK_NAME_RUN_RE =
    /[A-Za-zＡ-Ｚａ-ｚァ-ヶ一-龯々][A-Za-z0-9Ａ-Ｚａ-ｚ０-９ァ-ヶー一-龯々・･]{2,}/g;

  // フォールバック抽出でスペース区切りの2語目以降として認める語（丸ごと名前らしいトークン。2文字以上）。
  // 「TIMES CAR PLUS」のような複数語のサービス名・店名を途中で切らないために使う
  const PARTNER_FALLBACK_NAME_WORD_RE = /^[A-Za-zァ-ヶ一-龯々][A-Za-z0-9ァ-ヶー一-龯々・･]+$/;

  // 法人格の前後綴り。ドロップダウン検索でヒットしやすいよう候補から取り除く
  // （「一社」等の略記は登録名に含まれないことが多いため）。長い綴りを先に照合する
  const PARTNER_LEGAL_FORMS = [
    '一般社団法人',
    '一般財団法人',
    '公益社団法人',
    '公益財団法人',
    '特定非営利活動法人',
    'NPO法人',
    '株式会社',
    '有限会社',
    '合同会社',
    '合資会社',
    '合名会社',
    '一社',
    '一財',
    '公社',
    '公財',
  ];

  // 振込摘要の先頭に現れる経由銀行名。銀行口座の意味合いで表示されているだけなので
  // 取引先候補には採用しない。全銀カナの長音表記（ー/－/-）が揺れるため、
  // 正規化（長音・ハイフン・中黒・スペース除去）済みの形で持つ
  const PARTNER_BANK_NAMES = [
    'ミツビシユエフジエイ',
    'ミツイスミトモ',
    'ミズホ',
    'リソナ',
    'サイタマリソナ',
    'ユウチヨ',
    'ラクテン',
    'ペイペイ',
    'ジエムオアオゾラ',
    'スミシンエスビアイ',
    'アウジブン',
  ];
  // 〜ギンコウ/シンキン等で終わるトークンも銀行名とみなす
  const PARTNER_BANK_SUFFIX_RE = /(ギンコウ|シンキン|シンクミ|シンヨウキンコ|シンヨウクミアイ|ロウキン|ノウキヨウ)$/;

  const DEFAULT_ACCOUNTS = [
    '会議費',
    '交際費',
    '支払報酬料',
    '通信費',
    '消耗品費',
    '旅費交通費',
    '支払手数料',
    '地代家賃',
    '未払金',
    '役員借入金',
  ];

  const DEFAULT_POSITION = { bottom: 80, right: 16 };

  // 実績学習: 「明細の署名（取引先候補の正規化文字列）→ 選んだ科目」を端末内に記録する。
  // 科目ボタンを押すたびに自動で貯まり、同じ署名の明細が来たら「前回: ○○」ボタンを出す
  const LEARNED_STORAGE_KEY = 'fkb_learned_accounts';
  const LEARNED_MAX_ENTRIES = 300;

  let lastTarget = null;
  let hostEl = null;
  let shadowRoot = null;
  let panelVisible = false;
  let currentAccounts = DEFAULT_ACCOUNTS.slice();
  let learnedAccounts = {};
  let currentPosition = Object.assign({}, DEFAULT_POSITION);
  let collapsed = false;

  // ---- 対象入力欄のフォーカス監視 ----
  document.addEventListener(
    'focusin',
    (e) => {
      const target = e.target;
      if (target && target.matches && target.matches(TARGET_INPUT_SELECTOR)) {
        lastTarget = target;
        updatePartnerSuggestion();
        updateLearnedSuggestion();
      }
    },
    true
  );

  function isVisible(el) {
    return !!el && el.offsetParent !== null;
  }

  function findAllAccountInputs() {
    return Array.from(document.querySelectorAll(ACCOUNT_INPUT_SELECTOR));
  }

  // いまフォーカス中の勘定科目欄（focusinを取りこぼしても拾えるように）
  function activeAccountInput() {
    const active = document.activeElement;
    return active && active.matches && active.matches(ACCOUNT_INPUT_SELECTOR) && isVisible(active)
      ? active
      : null;
  }

  // いまフォーカス中の勘定科目欄 or 取引先タグ入力欄（行特定用。取引先候補ボタン向け）
  function activeRowInput() {
    const active = document.activeElement;
    return active && active.matches && active.matches(TARGET_INPUT_SELECTOR) && isVisible(active)
      ? active
      : null;
  }

  // 「自動で経理の詳細」ページ（明細1件の画面）か。フォームが1つしかないため、
  // フォーカスが無くても最初の勘定科目欄を行アンカーにしてよい
  function isDetailPage() {
    return /^\/wallet_txns\/stream\/\d+/.test(location.pathname);
  }

  function firstVisibleAccountInput() {
    const candidates = findAllAccountInputs();
    for (const el of candidates) {
      if (isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  // 行特定用の入力欄を解決（勘定科目欄・取引先タグ欄のどちらでもよい）
  function resolveRowInput() {
    const active = activeRowInput();
    if (active) {
      return active;
    }
    if (
      lastTarget &&
      document.contains(lastTarget) &&
      isVisible(lastTarget) &&
      lastTarget.matches &&
      lastTarget.matches(TARGET_INPUT_SELECTOR)
    ) {
      return lastTarget;
    }
    // 詳細ページはフォーカス不要で候補を出す
    if (isDetailPage()) {
      return firstVisibleAccountInput();
    }
    return null;
  }

  function resolveTargetInput() {
    const active = activeAccountInput();
    if (active) {
      return active;
    }
    if (
      lastTarget &&
      document.contains(lastTarget) &&
      isVisible(lastTarget) &&
      lastTarget.matches &&
      lastTarget.matches(ACCOUNT_INPUT_SELECTOR)
    ) {
      return lastTarget;
    }
    const candidates = findAllAccountInputs();
    for (const el of candidates) {
      if (isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  // ---- 科目の推測（ハイライト用。入力はしない） ----
  function getRowContext(input) {
    // 「自動で経理の詳細」ページ（/wallet_txns/stream/<数字ID>）は明細1件なので摘要専用要素を最優先で使う。
    // 新レイアウトでは closest が掴む行コンテナにコンボボックスのキーボード操作ヘルプ
    // （「上下左右キー…」）が混入して誤抽出するため、closest より先に見る
    if (isDetailPage()) {
      const desc = document.querySelector('.wallet-txn-descriptions');
      if (desc && desc.textContent) {
        return desc.textContent;
      }
    }
    const row =
      input.closest('tr') ||
      input.closest('li') ||
      input.closest('[class*="row" i]') ||
      input.closest('form');
    if (row) {
      return row.innerText || '';
    }
    return '';
  }

  // ---- 取引先候補の推測（あくまで推測。過剰な精緻化はしない） ----
  function isPartnerNoiseToken(tok) {
    return PARTNER_NOISE_PATTERNS.some((re) => re.test(tok));
  }

  function isPartnerNameLikeToken(tok) {
    return PARTNER_NAME_LIKE_RE.test(tok);
  }

  // 全角英数字・全角ピリオドを半角に統一する（取引先名の表記ゆれ防止。カナ・全角記号はそのまま）
  function normalizeAlnumWidth(text) {
    return String(text || '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/．/g, '.');
  }

  function normalizeBankToken(tok) {
    return String(tok || '')
      .normalize('NFKC')
      .replace(/[ー－\-･・\s　]+/g, '')
      .toUpperCase();
  }

  function isBankNameToken(tok) {
    const n = normalizeBankToken(tok);
    if (!n) return false;
    if (PARTNER_BANK_SUFFIX_RE.test(n)) return true;
    return PARTNER_BANK_NAMES.some((b) => n === b || n.startsWith(b));
  }

  // トークンが士業の肩書きそのもの（ベンゴシ・ゼイリシ等）か。氏名の一部と誤認しないよう完全一致のみ
  function isShigyoTitleToken(tok) {
    const n = normalizeBankToken(tok);
    if (!n) return false;
    return SHIGYO_TITLE_KEYWORDS.some(([keyword]) => n === keyword);
  }

  function extractPartnerCandidate(text) {
    if (!text) return null;
    const rawTokens = normalizeAlnumWidth(text)
      .split(/\r?\n/)
      .join(' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // 「振込」を含むトークンの位置を探す（都度振込/振込入金＊/振込＊/振込 等をまとめて1マーカーとして扱う）
    let furikomiIndex = -1;
    let afterInline = null; // 振込＊のように直結している場合の残り
    for (let i = 0; i < rawTokens.length; i++) {
      const tok = rawTokens[i];
      const m = tok.match(/振込(?:入金)?[＊*]?/);
      if (m) {
        furikomiIndex = i;
        const rest = tok.slice(m.index + m[0].length);
        afterInline = rest;
        break;
      }
    }
    if (furikomiIndex === -1) return null;

    const tokens = [];
    if (afterInline) {
      tokens.push(afterInline);
    }
    for (let i = furikomiIndex + 1; i < rawTokens.length; i++) {
      const tok = rawTokens[i];
      if (isPartnerNoiseToken(tok)) break;
      tokens.push(tok);
    }
    if (tokens.length === 0) return null;

    // 法人格マーカー処理（マーカーは全角「）」を含むためカタカナ判定より先に生トークンへ照合する）
    let candidateTokens = null;
    for (const marker of PARTNER_MARKERS) {
      const idx = tokens.findIndex((t) => t.includes(marker));
      if (idx !== -1) {
        const tok = tokens[idx];
        const after = tok.slice(tok.indexOf(marker) + marker.length);
        const rest = tokens.slice(idx + 1);
        candidateTokens = (after ? [after] : []).concat(rest);
        break;
      }
    }

    if (!candidateTokens) {
      // マーカーがない場合: カタカナ・英字・長音・中黒・スペースで構成されるトークンだけ
      // 先頭からの連続を採用
      const nameTokens = [];
      for (const tok of tokens) {
        if (isPartnerNameLikeToken(tok)) {
          nameTokens.push(tok);
        } else {
          break;
        }
      }
      if (nameTokens.length === 0) return null;
      // 先頭の経由銀行名・士業肩書き（ベンゴシ等）を除去
      // （銀行名は口座の意味合い、肩書きは取引先名そのものではないため）
      let start = 0;
      while (
        start < nameTokens.length &&
        (isBankNameToken(nameTokens[start]) || isShigyoTitleToken(nameTokens[start]))
      ) {
        start += 1;
      }
      if (start >= nameTokens.length) return null; // 銀行名・肩書きしか残らない場合は候補なし
      let rest = nameTokens.slice(start);
      // 銀行名を検出できなかった場合のみ、従来の「3語以上なら先頭は経由銀行とみなす」を適用
      if (start === 0 && rest.length >= 3) {
        rest = rest.slice(1);
      }
      candidateTokens = rest;
    }

    const result = candidateTokens.join(' ').trim();
    if (result.length < 2) return null;
    return result;
  }

  function isPartnerFallbackGenericWord(tok) {
    return PARTNER_FALLBACK_GENERIC_WORDS.some((w) => tok.includes(w));
  }

  // 法人格の綴りを前後から1つずつ取り除く。剥がした結果が短すぎる場合は元のまま返す
  function stripLegalForm(name) {
    let n = String(name || '');
    for (const form of PARTNER_LEGAL_FORMS) {
      if (n.startsWith(form) && n.length - form.length >= 2) {
        n = n.slice(form.length);
        break;
      }
    }
    for (const form of PARTNER_LEGAL_FORMS) {
      if (n.endsWith(form) && n.length - form.length >= 2) {
        n = n.slice(0, n.length - form.length);
        break;
      }
    }
    return n;
  }

  // カード明細等、「振込」を含まない摘要向けのフォールバック抽出。
  // 記号(*_/.－-)で区切ったうえで、英字・カタカナ・漢字始まりの連続(3文字以上)を候補として拾い、
  // 一般語・法人格のみの語を除外し、最初に見つかったものを採用する
  // （MICROSOFT*MICROSOFTのような重複は1つにまとめる）
  function extractPartnerCandidateFallback(text) {
    if (!text) return null;
    const normalized = normalizeAlnumWidth(text);
    // ドメイン形式（COMFY.ORG等）は分割記号のピリオドで欠ける前に丸ごと採用する
    const domainMatch = normalized.match(PARTNER_FALLBACK_DOMAIN_RE);
    if (domainMatch && !isPartnerFallbackGenericWord(domainMatch[0])) {
      return domainMatch[0];
    }
    const parts = normalized
      .split(/\r?\n/)
      .join(' ')
      .split(PARTNER_FALLBACK_SPLIT_RE)
      .map((s) => s.trim())
      .filter(Boolean);

    const seen = new Set();
    for (const part of parts) {
      const subTokens = part.split(/[\s　]+/).filter(Boolean);
      for (let i = 0; i < subTokens.length; i++) {
        const runs = subTokens[i].match(PARTNER_FALLBACK_NAME_RUN_RE) || [];
        for (const m of runs) {
          if (isPartnerFallbackGenericWord(m)) continue;
          if (PARTNER_LEGAL_FORMS.includes(m)) continue;
          const key = m.toUpperCase();
          if (seen.has(key)) continue;
          seen.add(key);
          // スペース区切りの2語目以降も、名前らしいトークンが続く限り取り込む
          // （複数語のサービス名・店名を先頭語だけで切らない。一般語・法人格・数字始まりで打ち切り）
          const words = [stripLegalForm(m)];
          for (let j = i + 1; j < subTokens.length; j++) {
            const next = subTokens[j];
            if (!PARTNER_FALLBACK_NAME_WORD_RE.test(next)) break;
            if (isPartnerFallbackGenericWord(next)) break;
            if (PARTNER_LEGAL_FORMS.includes(next)) break;
            words.push(next);
          }
          return words.join(' ');
        }
      }
    }
    return null;
  }

  // 明細テキストに士業法人マーカーが含まれるとき、その法人格名を返す（漢字推定のヒント用）
  function detectShigyoEntity(text) {
    if (!text) return null;
    const s = String(text);
    for (const [marker, entity] of SHIGYO_ENTITY_MAP) {
      if (s.includes(marker)) return entity;
    }
    return null;
  }

  // カナ候補名そのものに士業キーワードが含まれるとき、その種別名を返す
  // （「ベン）」等のマーカーが付かない振込名義でも漢字推定を発動させるため）
  function detectShigyoNameEntity(name) {
    if (!name) return null;
    const s = String(name).normalize('NFKC');
    for (const [keyword, entity] of SHIGYO_NAME_KEYWORDS) {
      if (s.includes(keyword)) return entity;
    }
    return null;
  }

  // 明細テキストに士業の肩書き（ベンゴシ等）が含まれるとき、その資格名を返す
  // （個人の士業への振込。例:「振込＊ベンゴシ ニシムラ アキラ」→ 弁護士）
  function detectShigyoTitleEntity(text) {
    if (!text) return null;
    const s = String(text).normalize('NFKC');
    for (const [keyword, entity] of SHIGYO_TITLE_KEYWORDS) {
      if (s.includes(keyword)) return entity;
    }
    return null;
  }

  // ---- 口座名からの取引先フォールバック（年会費・手数料など摘要に店名が無いカード明細用） ----

  // 詳細ページのヘッダー行「ステータス 口座名 日付 出金 摘要 金額」の日付にマッチさせる
  const ACCOUNT_HEADER_DATE_RE = /\d{4}[-/年]\s?\d{1,2}[-/月]\s?\d{1,2}/;
  const ACCOUNT_HEADER_STATUS_WORDS = ['未処理', '処理済み', '処理済', '対応完了', '無視'];

  // ヘッダーテキストから口座名を取り出し、カード口座なら取引先候補を返す
  // （例:「未処理 JCBカード 2026-06-15 出金 法人カード年会費…」→「JCB」）。
  // 年会費・手数料はカード会社自身が取引先になるため。銀行口座名は振込先と無関係なので対象外
  function extractAccountPartnerFromHeader(headerText) {
    if (!headerText) return null;
    const text = normalizeAlnumWidth(String(headerText).replace(/[\r\n]+/g, ' '));
    const dateMatch = text.match(ACCOUNT_HEADER_DATE_RE);
    if (!dateMatch) return null;
    let name = text.slice(0, dateMatch.index);
    for (const w of ACCOUNT_HEADER_STATUS_WORDS) {
      name = name.split(w).join(' ');
    }
    name = name.replace(/[\s　]+/g, ' ').trim();
    // ヘッダー行でなく大きなコンテナを拾ったときの誤検出防止（口座名にしては長すぎる）
    if (!name || name.length > 24) return null;
    if (!name.includes('カード')) return null;
    // 末尾の「カード」を除いて部分一致のヒット率を上げる（JCBカード→JCB）
    const candidate = name.replace(/カード$/, '').trim();
    return candidate.length >= 2 ? candidate : null;
  }

  // 詳細ページで口座名を含むヘッダー行のテキストを取る。摘要要素から親をたどり、
  // 日付を含む最初のコンテナ（口座名・日付・摘要が同居する行）を採用する。クラス名に依存しない
  function getDetailHeaderText() {
    const desc = document.querySelector('.wallet-txn-descriptions');
    if (!desc) return null;
    let node = desc.parentElement;
    for (let depth = 0; node && depth < 6; depth++) {
      const text = node.innerText || '';
      if (ACCOUNT_HEADER_DATE_RE.test(text)) return text;
      node = node.parentElement;
    }
    return null;
  }

  function computePartnerSuggestion(input) {
    const text = getRowContext(input);
    if (!text) return null;
    return extractPartnerCandidate(text) || extractPartnerCandidateFallback(text);
  }

  function updatePartnerSuggestion() {
    if (!shadowRoot) return;
    const input = resolveRowInput();
    const text = input ? getRowContext(input) : null;
    let suggested = text
      ? extractPartnerCandidate(text) || extractPartnerCandidateFallback(text)
      : null;
    // 摘要から候補が取れないカード口座の明細（年会費・手数料等）は、口座名のカード会社を候補にする
    if (!suggested && input && isDetailPage()) {
      suggested = extractAccountPartnerFromHeader(getDetailHeaderText());
    }
    // それでも候補が無い詳細ページ（デビットの承認番号のみ等、freeeに店名が来ていない明細）は、
    // 取引先が未選択のときだけ「情報が無い」ことを案内する（拡張の不具合と区別がつくように）
    let noneNote = null;
    if (!suggested && input && isDetailPage()) {
      const container = getPartnerDetailContainer();
      const tagged =
        isPartnerVibesAlreadyTagged() || !!(container && isPartnerDetailAlreadyTagged(container));
      if (!tagged) {
        noneNote = '摘要に取引先名が無い明細だよ（デビットの承認番号だけ等）';
      }
    }
    renderPartnerSection(suggested, noneNote);
    updatePartnerKanjiSuggestion(
      suggested,
      suggested
        ? detectShigyoEntity(text) || detectShigyoTitleEntity(text) || detectShigyoNameEntity(suggested)
        : null
    );
  }

  // ---- 士業カナ名義の漢字推定（ローカルのダッシュボードサーバー経由） ----

  // カナ候補名 → { status: 'pending'|'done'|'failed', kanji } のセッション内キャッシュ。
  // failedは再試行しない（サーバー未起動時に毎秒fetchが飛ばないように）
  const partnerKanjiLookups = new Map();

  function updatePartnerKanjiSuggestion(kanaName, entity) {
    if (!kanaName || !entity) {
      renderPartnerKanjiButton(null);
      return;
    }
    const rec = partnerKanjiLookups.get(kanaName);
    if (rec) {
      renderPartnerKanjiButton(rec.status === 'done' ? rec.kanji : null, rec.confidence);
      return;
    }
    partnerKanjiLookups.set(kanaName, { status: 'pending', kanji: null, confidence: null });
    renderPartnerKanjiButton(null);
    // Content-Typeヘッダーを付けない（simple requestにしてCORSプリフライトを避ける。サーバーは本文をJSONとして読む）
    fetch(PARTNER_KANJI_API_URL, {
      method: 'POST',
      body: JSON.stringify({ kana: kanaName, entity: entity }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const kanji =
          data && typeof data.kanji === 'string' && data.kanji.trim() ? data.kanji.trim() : null;
        const confidence = data && data.confidence === 'high' ? 'high' : 'low';
        partnerKanjiLookups.set(kanaName, { status: 'done', kanji, confidence });
        // 取得完了時点でも同じ候補を表示中なら漢字ボタンを出す（別の明細に移っていたら出さない）
        const btn = shadowRoot && shadowRoot.getElementById('fkb-partner-btn');
        if (kanji && btn && btn.dataset.partnerName === kanaName) {
          renderPartnerKanjiButton(kanji, confidence);
        }
      })
      .catch(() => {
        partnerKanjiLookups.set(kanaName, { status: 'failed', kanji: null, confidence: null });
      });
  }

  // ---- 実績学習（科目ボタンの押下履歴から「前回の科目」を出す） ----

  // 明細の署名。金額や日付のノイズに影響されないよう、取引先候補の抽出結果を正規化して使う
  function computeRowSignature(input) {
    const text = getRowContext(input);
    if (!text) return null;
    const candidate = extractPartnerCandidate(text) || extractPartnerCandidateFallback(text);
    if (!candidate) return null;
    const sig = normalizePartnerText(candidate);
    return sig || null;
  }

  function recordLearnedAccount(input, accountName) {
    const sig = input ? computeRowSignature(input) : null;
    if (!sig) return;
    const prev = learnedAccounts[sig];
    learnedAccounts[sig] = {
      account: accountName,
      count: prev && prev.account === accountName ? (prev.count || 0) + 1 : 1,
      ts: Date.now(),
    };
    // 上限を超えたら古い署名から削除（LRU）
    const keys = Object.keys(learnedAccounts);
    if (keys.length > LEARNED_MAX_ENTRIES) {
      keys.sort((a, b) => (learnedAccounts[a].ts || 0) - (learnedAccounts[b].ts || 0));
      const excess = keys.length - LEARNED_MAX_ENTRIES;
      for (let i = 0; i < excess; i++) {
        delete learnedAccounts[keys[i]];
      }
    }
    chrome.storage.local.set({ [LEARNED_STORAGE_KEY]: learnedAccounts });
  }

  function updateLearnedSuggestion() {
    if (!shadowRoot) return;
    const input = resolveRowInput();
    const sig = input ? computeRowSignature(input) : null;
    const entry = sig ? learnedAccounts[sig] : null;
    renderLearnedSection(entry ? entry.account : null);
  }

  // ---- 入力確定処理 ----
  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    setter.call(input, value);
  }

  function waitForOption(accountName, timeoutMs) {
    return new Promise((resolve) => {
      const intervalMs = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        const options = document.querySelectorAll('li[role="option"]');
        for (const opt of options) {
          if (!isVisible(opt)) continue;
          const text = (opt.textContent || '').trim();
          if (text.startsWith(accountName)) {
            clearInterval(timer);
            resolve(opt);
            return;
          }
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  function dispatchMouseSequence(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  async function fillAccount(accountName, buttonEl) {
    const input = resolveTargetInput();
    if (!input) {
      showToast('勘定科目の入力欄が見つからないよ');
      return;
    }

    input.focus();
    setNativeValue(input, accountName);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const option = await waitForOption(accountName, 2500);
    if (!option) {
      showToast('候補が見つからないよ（科目名を確認してね）');
      return;
    }

    dispatchMouseSequence(option);
    recordLearnedAccount(input, accountName);
    updateLearnedSuggestion();
    if (buttonEl) {
      flashButton(buttonEl);
    }
  }

  function flashButton(buttonEl) {
    buttonEl.classList.add('fkb-flash');
    setTimeout(() => {
      buttonEl.classList.remove('fkb-flash');
    }, 400);
  }

  // ---- 取引先セルへの入力確定処理 ----

  // 対象行内の取引先タグ入力欄を探す（一覧ページ用。行特定用のinputと同じ行から探索）
  function findPartnerInputInRow(input) {
    if (input && input.matches && input.matches(PARTNER_INPUT_SELECTOR)) {
      return input;
    }
    const row =
      (input && input.closest && input.closest('tr')) ||
      (input && input.closest && input.closest('li')) ||
      (input && input.closest && input.closest('[class*="row" i]')) ||
      (input && input.closest && input.closest('form'));
    if (row) {
      const found = row.querySelector(PARTNER_INPUT_SELECTOR);
      if (found) return found;
    }
    return null;
  }

  // 「自動で経理の詳細」ページ（/wallet_txns/stream/<数字ID>）の取引先コンテナを取得
  function getPartnerDetailContainer() {
    const container = document.querySelector(PARTNER_DETAIL_CONTAINER_SELECTOR);
    return container && isVisible(container) ? container : null;
  }

  // 詳細ページで既に取引先タグが設定済みかどうか
  function isPartnerDetailAlreadyTagged(container) {
    return !!container.querySelector('span.tags-combobox__tagify-tag');
  }

  // 詳細ページの取引先タグ入力コンテナ（クリックするとinputが出現する）
  function getPartnerDetailTagContainer(container) {
    return container.querySelector('.tags-combobox__tagify-tag-container');
  }

  function getPartnerDetailInput(container) {
    const found = container.querySelector('input.tags-combobox__tag-input');
    return found && isVisible(found) ? found : null;
  }

  // タグコンテナをクリックしてinputを出現させる（pointerdown/mousedown/pointerup/mouseup/click順次dispatch）
  function clickPartnerDetailTagContainer(tagContainer) {
    const opts = { bubbles: true, cancelable: true, view: window };
    tagContainer.dispatchEvent(new PointerEvent('pointerdown', opts));
    tagContainer.dispatchEvent(new MouseEvent('mousedown', opts));
    tagContainer.dispatchEvent(new PointerEvent('pointerup', opts));
    tagContainer.dispatchEvent(new MouseEvent('mouseup', opts));
    tagContainer.dispatchEvent(new MouseEvent('click', opts));
  }

  // ---- 新レイアウト（vibesデザインシステム）詳細ページの取引先combobox ----
  // 旧レイアウトの .deal-editor-common-partner / tags-combobox 系が存在せず、
  // 取引先欄は input[data-testid="partner-field"]（role=combobox）になっている

  function getPartnerVibesInput() {
    const found = document.querySelector('input[data-testid="partner-field"]');
    return found && isVisible(found) ? found : null;
  }

  // 「取引先」ラベルを持つfieldset（vibesのフォームコントロール単位）
  function getPartnerVibesFieldset() {
    const labels = document.querySelectorAll('span.vb-formControlLabel__text');
    for (const label of labels) {
      if ((label.textContent || '').trim() === '取引先') {
        return label.closest('fieldset');
      }
    }
    return null;
  }

  // 選択済みだとcombobox inputが消えて .vb-miniTag のタグ表示に置き換わる
  function isPartnerVibesAlreadyTagged() {
    const fieldset = getPartnerVibesFieldset();
    return !!(fieldset && fieldset.querySelector('.vb-miniTag'));
  }

  // ドロップダウンのul。aria-controls参照が基本だが、遅延マウント直後に
  // getElementByIdが空振りすることがあるため可視の listBox をフォールバックで探す
  function getPartnerVibesListbox(input) {
    const controlsId = input.getAttribute('aria-controls');
    const byId = controlsId ? document.getElementById(controlsId) : null;
    if (byId) return byId;
    const candidates = document.querySelectorAll('ul[id$="-listBox"]');
    for (const ul of candidates) {
      if (ul.getBoundingClientRect().width > 0) return ul;
    }
    return null;
  }

  // vibes listboxの候補判定。
  // 戻り値: { kind: 'registered', el } | { kind: 'unregistered' } | null（描画・絞り込み待ち）
  function readPartnerVibesListState(listbox, partnerName) {
    const items = Array.from(listbox.children).filter(
      (li) => li.getBoundingClientRect().width > 0
    );
    if (items.length === 0) return null;
    if (
      items.some((li) => (li.textContent || '').includes('該当の項目がありませんでした'))
    ) {
      return { kind: 'unregistered' };
    }
    // テキスト未描画の行がある間は判定待ち（旧レイアウトと同じstale要素対策）
    if (items.some((li) => (li.textContent || '').trim().length === 0)) return null;
    const registered = items.find(
      (li) =>
        li.getAttribute('role') === 'option' &&
        partnerLineMatches(li.textContent, partnerName)
    );
    if (registered) {
      return { kind: 'registered', el: registered };
    }
    // 一致しない候補しか無い間は絞り込み待ち
    return null;
  }

  function waitForPartnerVibesResult(input, timeoutMs, partnerName) {
    return new Promise((resolve) => {
      const intervalMs = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        if (input.getAttribute('aria-expanded') === 'true') {
          const listbox = getPartnerVibesListbox(input);
          if (listbox) {
            const state = readPartnerVibesListState(listbox, partnerName);
            if (state) {
              clearInterval(timer);
              resolve(state);
              return;
            }
          }
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  function dispatchPointerClickSequence(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // vibes comboboxへの入力→候補選択。クリック→focus→少し待つ→keydown込みの入力、
  // の順でないとドロップダウンが開かない（実機で確認済み）
  async function fillPartnerVibes(input, partnerName, buttonEl) {
    dispatchPointerClickSequence(input);
    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focus'));

    await new Promise((r) => setTimeout(r, 200));

    const lastChar = partnerName[partnerName.length - 1];
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: lastChar, bubbles: true, cancelable: true })
    );
    setNativeValue(input, partnerName);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keyup', { key: lastChar, bubbles: true, cancelable: true })
    );

    const state = await waitForPartnerVibesResult(input, 4000, partnerName);
    if (!state) {
      showToast('候補が見つからないよ（取引先名を確認してね）');
      return;
    }
    if (state.kind === 'registered') {
      dispatchPointerClickSequence(state.el);
      if (buttonEl) flashButton(buttonEl);
      showToast('取引先を入れたよ');
      return;
    }
    // 未登録: この画面のドロップダウンには（新規登録）候補が出ないため案内のみ
    showToast('freeeに未登録の取引先みたい。先に取引先を登録してね');
  }

  function waitForPartnerDetailInput(container, timeoutMs) {
    return new Promise((resolve) => {
      const intervalMs = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        const found = getPartnerDetailInput(container);
        if (found) {
          clearInterval(timer);
          resolve(found);
          return;
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  // 取引先入力欄の解決: (a) 行内の一覧ページ用input、(b) 新レイアウト詳細ページのvibes combobox、
  // (c) 旧レイアウト詳細ページの独立フィールド、の順で探す。
  // 戻り値: { kind: 'input', el } | { kind: 'vibes', el } | { kind: 'already_tagged' } | null
  async function resolvePartnerTarget(rowInput) {
    const rowFound = findPartnerInputInRow(rowInput);
    if (rowFound) {
      return { kind: 'input', el: rowFound };
    }

    // 新レイアウト（vibes）: comboboxがあれば未選択、無くてもminiTagがあれば選択済み
    const vibesInput = getPartnerVibesInput();
    if (vibesInput) {
      return { kind: 'vibes', el: vibesInput };
    }
    if (isDetailPage() && isPartnerVibesAlreadyTagged()) {
      return { kind: 'already_tagged' };
    }

    const container = getPartnerDetailContainer();
    if (!container) {
      return null;
    }
    if (isPartnerDetailAlreadyTagged(container)) {
      return { kind: 'already_tagged' };
    }
    // 既にinputが出ている場合はそのまま使う
    const existingInput = getPartnerDetailInput(container);
    if (existingInput) {
      return { kind: 'input', el: existingInput };
    }
    // 空の場合: タグコンテナをクリックしてinputの出現を待つ
    const tagContainer = getPartnerDetailTagContainer(container);
    if (!tagContainer) {
      return null;
    }
    clickPartnerDetailTagContainer(tagContainer);
    const appearedInput = await waitForPartnerDetailInput(container, 2500);
    return appearedInput ? { kind: 'input', el: appearedInput } : null;
  }

  function getPartnerDropdown() {
    // 詳細ページはドロップダウンが遅延マウントされ、複数存在しうるため querySelectorAll で可視のものを探す
    const dropdowns = document.querySelectorAll('.tags-combobox__dropdown-result-area');
    for (const dropdown of dropdowns) {
      const rect = dropdown.getBoundingClientRect();
      if (rect.width > 0) return dropdown;
    }
    return null;
  }

  function getPartnerTab(dropdown) {
    return dropdown ? dropdown.querySelector('.tags-combobox__tab--partner a') : null;
  }

  function isPartnerTabActive(dropdown) {
    const tab = getPartnerTab(dropdown);
    if (!tab) return false;
    const tabLi = tab.closest('.tags-combobox__tab--partner');
    // freee実機のアクティブタブクラスは tags-combobox__tab--act（activeではない）
    return !!tabLi && /tags-combobox__tab--act\b|active|selected/i.test(tabLi.className || '');
  }

  // 「取引先」タブへ切替（mousedown/mouseup/clickを順次dispatch）
  function switchToPartnerTab(dropdown) {
    const tab = getPartnerTab(dropdown);
    if (!tab) return false;
    dispatchMouseSequence(tab);
    return true;
  }

  // 取引先名の比較用正規化（全半角・カナ幅・スペース・大文字小文字の揺れを吸収）
  function normalizePartnerText(s) {
    return String(s || '')
      .normalize('NFKC')
      .replace(/[\s　]+/g, '')
      .toUpperCase();
  }

  // 候補名と行テキストが同一取引先とみなせるか（行末の「取引先」suffixは除いて比較）
  function partnerLineMatches(lineText, partnerName) {
    const lineName = normalizePartnerText(String(lineText || '').replace(/取引先$/, ''));
    const want = normalizePartnerText(partnerName);
    if (!lineName || !want) return false;
    if (lineName.includes(want)) return true;
    // 候補側に余分なトークンが付くケース（例: 経由名の残り）を許容
    return lineName.length >= 3 && want.includes(lineName);
  }

  // 取引先タブ内の候補行を判定する。
  // 戻り値: { kind: 'registered', el } | { kind: 'unregistered' } | null（まだ判定できない）
  function readPartnerTabState(dropdown, partnerName) {
    const lines = Array.from(dropdown.querySelectorAll('li.tags-combobox__line')).filter(isVisible);
    if (lines.length === 0) return null;
    // テキスト描画前の空行を「登録済み」と誤判定してクリックすると、React再描画後の
    // stale要素への空振りになる（実機で確認）。全行のテキストが埋まるまで判定待ちに倒す
    if (lines.some((li) => (li.textContent || '').trim().length === 0)) return null;
    // 入力直後は絞り込み前の「最近の取引先」リストが一瞬表示される（実機で誤選択を確認）。
    // 候補名と一致する行だけを「登録済み」として採用する
    const registered = lines.find((li) => {
      const text = li.textContent || '';
      return !text.includes('（新規登録）') && partnerLineMatches(text, partnerName);
    });
    if (registered) {
      return { kind: 'registered', el: registered };
    }
    // 「（新規登録）」行が出ていれば絞り込み済み＝未登録と確定
    if (lines.some((li) => (li.textContent || '').includes('（新規登録）'))) {
      return { kind: 'unregistered' };
    }
    // 一致しない登録済み行しか無い間は絞り込み待ち
    return null;
  }

  function waitForPartnerTabResult(timeoutMs, partnerName) {
    return new Promise((resolve) => {
      const intervalMs = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        const dropdown = getPartnerDropdown();
        if (dropdown && isPartnerTabActive(dropdown)) {
          const state = readPartnerTabState(dropdown, partnerName);
          if (state) {
            clearInterval(timer);
            resolve(state);
            return;
          }
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  function waitForPartnerDropdown(timeoutMs) {
    return new Promise((resolve) => {
      const intervalMs = 100;
      let elapsed = 0;
      const timer = setInterval(() => {
        elapsed += intervalMs;
        const dropdown = getPartnerDropdown();
        if (dropdown) {
          clearInterval(timer);
          resolve(dropdown);
          return;
        }
        if (elapsed >= timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, intervalMs);
    });
  }

  // 取引先タグ入力欄への入力シーケンス。一覧ページ・詳細ページ共通で使えるよう、
  // 詳細ページの実測（クリック列→focus→FocusEvent→ネイティブセッター→keydown→input→keyup）に合わせたフルシーケンスにする
  function dispatchPartnerInputSequence(input, value) {
    const mouseOpts = { bubbles: true, cancelable: true, view: window };
    input.dispatchEvent(new PointerEvent('pointerdown', mouseOpts));
    input.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
    input.dispatchEvent(new PointerEvent('pointerup', mouseOpts));
    input.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
    input.dispatchEvent(new MouseEvent('click', mouseOpts));

    input.focus();
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.dispatchEvent(new FocusEvent('focus'));

    setNativeValue(input, value);

    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
  }

  async function fillPartner(partnerName, buttonEl) {
    const rowInput = resolveRowInput();
    const target = await resolvePartnerTarget(rowInput);
    if (!target) {
      showToast('取引先の入力欄が見つからないよ');
      return;
    }
    if (target.kind === 'already_tagged') {
      showToast('もう取引先が入ってるよ');
      return;
    }
    if (target.kind === 'vibes') {
      await fillPartnerVibes(target.el, partnerName, buttonEl);
      return;
    }

    const input = target.el;
    dispatchPartnerInputSequence(input, partnerName);

    const dropdown = await waitForPartnerDropdown(2500);
    if (!dropdown) {
      showToast('候補が見つからないよ（取引先名を確認してね）');
      return;
    }

    if (!isPartnerTabActive(dropdown)) {
      switchToPartnerTab(dropdown);
    }

    const state = await waitForPartnerTabResult(2500, partnerName);
    if (!state) {
      showToast('候補が見つからないよ（取引先名を確認してね）');
      return;
    }

    if (state.kind === 'registered') {
      dispatchMouseSequence(state.el);
      if (buttonEl) flashButton(buttonEl);
      showToast('取引先を入れたよ');
      return;
    }

    // 未登録: 自動登録はせず、ドロップダウンの（新規登録）候補が見える状態のまま案内する
    showToast('未登録だよ。登録するならドロップダウンの（新規登録）をクリックしてね');
  }

  // ---- 「これ、何費？」検索（ヘッダーの🔍ボタン） ----
  // 検索語の優先順: ページ上の選択テキスト → パネルの取引先候補 → 手入力ダイアログ。
  // 小窓はウィンドウ名 "nanpi" を使い回すので、連続で調べても増えない
  function openNanpi() {
    let q = (window.getSelection() + '').trim();
    if (!q && shadowRoot) {
      const partnerBtn = shadowRoot.getElementById('fkb-partner-btn');
      q = (partnerBtn && partnerBtn.dataset.partnerName) || '';
    }
    if (!q) {
      q = prompt('何費か調べたい語（サービス名・店名など）') || '';
    }
    q = q.trim();
    if (!q) return;
    window.open(
      NANPI_URL + '?q=' + encodeURIComponent(q.slice(0, 30)),
      'nanpi',
      'width=520,height=760'
    );
  }

  let toastTimer = null;
  function showToast(message) {
    if (!shadowRoot) return;
    const toast = shadowRoot.getElementById('fkb-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('fkb-toast-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('fkb-toast-visible');
    }, 2000);
  }

  // ---- パネル構築 ----
  function buildPanel() {
    hostEl = document.createElement('div');
    hostEl.id = 'freee-kamoku-buttons-host';
    hostEl.style.all = 'initial';
    document.documentElement.appendChild(hostEl);

    shadowRoot = hostEl.attachShadow({ mode: 'open' });

    // freee会計（vibesデザインシステム）の実測トークンに合わせた配色:
    // プライマリ #285ac8 / 枠線 #dcdcdc / 文字 #323232 / 角丸 8px / ボタンは太字
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .fkb-panel {
        position: fixed;
        z-index: 2147483000;
        font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "ヒラギノ角ゴ ProN", "Hiragino Kaku Gothic ProN", Arial, メイリオ, Meiryo, sans-serif;
        background: #ffffff;
        border: 1px solid #dcdcdc;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        width: 200px;
        user-select: none;
        display: none;
      }
      .fkb-panel.fkb-shown {
        display: block;
      }
      .fkb-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: #285ac8;
        color: #fff;
        border-radius: 7px 7px 0 0;
        cursor: move;
        font-size: 13px;
        font-weight: 700;
      }
      .fkb-toggle {
        cursor: pointer;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.2);
        font-size: 14px;
        line-height: 1;
      }
      .fkb-toggle:hover {
        background: rgba(255, 255, 255, 0.35);
      }
      .fkb-header-btns {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #fkb-nanpi {
        font-size: 12px;
      }
      .fkb-body {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        padding: 10px;
      }
      .fkb-panel.fkb-collapsed .fkb-body {
        display: none;
      }
      .fkb-btn {
        font-family: inherit;
        font-size: 12px;
        font-weight: 700;
        padding: 8px 4px;
        border: 1px solid #dcdcdc;
        border-radius: 8px;
        background: #ffffff;
        color: #323232;
        cursor: pointer;
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fkb-btn:hover {
        background: #f0f4fc;
        border-color: #285ac8;
        color: #285ac8;
      }
      .fkb-btn.fkb-flash {
        background: #285ac8;
        border-color: #285ac8;
        color: #ffffff;
      }
      .fkb-toast {
        position: fixed;
        z-index: 2147483001;
        bottom: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(50, 50, 50, 0.9);
        color: #fff;
        padding: 8px 14px;
        border-radius: 8px;
        font-size: 12px;
        font-family: inherit;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s;
      }
      .fkb-toast-visible {
        opacity: 1;
      }
      .fkb-partner-section {
        display: none;
        padding: 0 10px 10px;
      }
      .fkb-partner-section.fkb-shown {
        display: block;
      }
      .fkb-panel.fkb-collapsed .fkb-partner-section {
        display: none;
      }
      .fkb-partner-divider {
        border: none;
        border-top: 1px solid #dcdcdc;
        margin: 0 0 8px;
      }
      .fkb-partner-label {
        display: block;
        font-size: 11px;
        font-weight: 700;
        color: #323232;
        margin-bottom: 6px;
      }
      .fkb-btn-partner {
        width: 100%;
        border-style: dashed;
        background: #f7f9fd;
      }
      .fkb-btn-partner:hover {
        background: #e8f0fe;
      }
      .fkb-partner-none {
        display: none;
        font-size: 11px;
        color: #888;
        line-height: 1.5;
      }
      .fkb-partner-none.fkb-shown {
        display: block;
      }
      .fkb-keiri-summary {
        display: none;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 700;
        color: #323232;
        border-bottom: 1px solid #dcdcdc;
        background: #f7f9fd;
      }
      .fkb-keiri-summary.fkb-shown {
        display: block;
      }
      .fkb-keiri-summary.fkb-keiri-warn {
        color: #b45309;
        background: #fef3c7;
      }
      .fkb-panel.fkb-collapsed .fkb-keiri-summary {
        display: none;
      }
    `;
    shadowRoot.appendChild(style);

    const panel = document.createElement('div');
    panel.className = 'fkb-panel';
    panel.id = 'fkb-panel';

    const header = document.createElement('div');
    header.className = 'fkb-header';

    const title = document.createElement('span');
    title.textContent = '勘定科目';
    header.appendChild(title);

    const headerBtns = document.createElement('div');
    headerBtns.className = 'fkb-header-btns';

    const nanpiBtn = document.createElement('div');
    nanpiBtn.className = 'fkb-toggle';
    nanpiBtn.id = 'fkb-nanpi';
    nanpiBtn.textContent = '🔍';
    nanpiBtn.title = '選択したテキストを「これ、何費？」で調べる（未選択なら取引先候補→手入力）';
    headerBtns.appendChild(nanpiBtn);

    const toggle = document.createElement('div');
    toggle.className = 'fkb-toggle';
    toggle.id = 'fkb-toggle';
    toggle.textContent = '−';
    headerBtns.appendChild(toggle);

    header.appendChild(headerBtns);

    panel.appendChild(header);

    // AI科目点検サマリ（自動経理で起票済みの科目を二次点検した結果。ページ内の要確認件数を表示するだけ）
    const keiriSummary = document.createElement('div');
    keiriSummary.className = 'fkb-keiri-summary';
    keiriSummary.id = 'fkb-keiri-summary';
    panel.appendChild(keiriSummary);

    const body = document.createElement('div');
    body.className = 'fkb-body';
    body.id = 'fkb-body';
    panel.appendChild(body);

    // 「前回の科目」セクション（実績学習。取引先セクションとスタイルを共用）
    const learnedSection = document.createElement('div');
    learnedSection.className = 'fkb-partner-section';
    learnedSection.id = 'fkb-learned-section';

    const learnedDivider = document.createElement('hr');
    learnedDivider.className = 'fkb-partner-divider';
    learnedSection.appendChild(learnedDivider);

    const learnedLabel = document.createElement('span');
    learnedLabel.className = 'fkb-partner-label';
    learnedLabel.textContent = '前回の科目';
    learnedSection.appendChild(learnedLabel);

    const learnedBtn = document.createElement('button');
    learnedBtn.className = 'fkb-btn fkb-btn-partner';
    learnedBtn.type = 'button';
    learnedBtn.id = 'fkb-learned-btn';
    // フォーカスを奪わないようにpointerdownでpreventDefault
    learnedBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
    });
    learnedBtn.addEventListener('click', () => {
      const name = learnedBtn.dataset.accountName;
      if (name) {
        fillAccount(name, learnedBtn);
      }
    });
    learnedSection.appendChild(learnedBtn);

    panel.appendChild(learnedSection);

    const partnerSection = document.createElement('div');
    partnerSection.className = 'fkb-partner-section';
    partnerSection.id = 'fkb-partner-section';

    const divider = document.createElement('hr');
    divider.className = 'fkb-partner-divider';
    partnerSection.appendChild(divider);

    const label = document.createElement('span');
    label.className = 'fkb-partner-label';
    label.textContent = '取引先';
    partnerSection.appendChild(label);

    const partnerBtn = document.createElement('button');
    partnerBtn.className = 'fkb-btn fkb-btn-partner';
    partnerBtn.type = 'button';
    partnerBtn.id = 'fkb-partner-btn';
    // フォーカスを奪わないようにpointerdownでpreventDefault
    partnerBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
    });
    partnerBtn.addEventListener('click', () => {
      const name = partnerBtn.dataset.partnerName;
      if (name) {
        fillPartner(name, partnerBtn);
      }
    });
    partnerSection.appendChild(partnerBtn);

    // 士業カナ名義の漢字推定ボタン（推定結果が届いたときだけ表示される）
    const partnerKanjiBtn = document.createElement('button');
    partnerKanjiBtn.className = 'fkb-btn fkb-btn-partner';
    partnerKanjiBtn.type = 'button';
    partnerKanjiBtn.id = 'fkb-partner-kanji-btn';
    partnerKanjiBtn.style.display = 'none';
    // フォーカスを奪わないようにpointerdownでpreventDefault
    partnerKanjiBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
    });
    partnerKanjiBtn.addEventListener('click', () => {
      const name = partnerKanjiBtn.dataset.partnerName;
      if (name) {
        fillPartner(name, partnerKanjiBtn);
      }
    });
    partnerSection.appendChild(partnerKanjiBtn);

    // 摘要に取引先名が無い明細（デビット承認番号のみ等）で「拡張が壊れているわけではない」と伝える案内
    const partnerNone = document.createElement('span');
    partnerNone.className = 'fkb-partner-none';
    partnerNone.id = 'fkb-partner-none';
    partnerSection.appendChild(partnerNone);

    panel.appendChild(partnerSection);

    shadowRoot.appendChild(panel);

    const toast = document.createElement('div');
    toast.className = 'fkb-toast';
    toast.id = 'fkb-toast';
    shadowRoot.appendChild(toast);

    setupDrag(header, panel);
    setupToggle(toggle, panel);
    setupNanpi(nanpiBtn);

    renderButtons();
    applyPosition(panel);
    applyCollapsed(panel);
  }

  function renderButtons() {
    if (!shadowRoot) return;
    const body = shadowRoot.getElementById('fkb-body');
    if (!body) return;
    body.innerHTML = '';
    currentAccounts.forEach((name) => {
      const btn = document.createElement('button');
      btn.className = 'fkb-btn';
      btn.type = 'button';
      btn.textContent = name;
      btn.title = name;
      // フォーカスを奪わないようにpointerdownでpreventDefault
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
      });
      btn.addEventListener('click', () => {
        fillAccount(name, btn);
      });
      body.appendChild(btn);
    });
  }

  // 「前回の科目」ボタンの表示切り替え（学習済みの署名に一致しない行ではセクションごと非表示）
  function renderLearnedSection(accountName) {
    if (!shadowRoot) return;
    const section = shadowRoot.getElementById('fkb-learned-section');
    const btn = shadowRoot.getElementById('fkb-learned-btn');
    if (!section || !btn) return;
    if (!accountName) {
      section.classList.remove('fkb-shown');
      btn.dataset.accountName = '';
      return;
    }
    section.classList.add('fkb-shown');
    btn.dataset.accountName = accountName;
    btn.textContent = `前回: ${accountName}`;
    btn.title = accountName;
  }

  // 取引先候補ボタンの表示切り替え（候補が抽出できない行ではセクションごと非表示）。
  // noneNoteが渡されたとき（詳細ページで摘要に取引先名が無い明細）はボタンの代わりに案内文だけ表示する
  function renderPartnerSection(partnerName, noneNote) {
    if (!shadowRoot) return;
    const section = shadowRoot.getElementById('fkb-partner-section');
    const btn = shadowRoot.getElementById('fkb-partner-btn');
    const note = shadowRoot.getElementById('fkb-partner-none');
    if (!section || !btn) return;
    if (!partnerName) {
      btn.style.display = 'none';
      btn.dataset.partnerName = '';
      if (noneNote && note) {
        note.textContent = noneNote;
        note.classList.add('fkb-shown');
        section.classList.add('fkb-shown');
      } else {
        if (note) note.classList.remove('fkb-shown');
        section.classList.remove('fkb-shown');
      }
      return;
    }
    if (note) note.classList.remove('fkb-shown');
    btn.style.display = '';
    section.classList.add('fkb-shown');
    btn.dataset.partnerName = partnerName;
    btn.textContent = `取引先: ${partnerName}`;
    btn.title = partnerName;
  }

  // 漢字推定ボタンの表示切り替え（推定できたときだけ表示。カナボタンは常に残す）。
  // confidenceがhigh以外は「漢字?:」表示にして、同姓同名等の可能性がある旨を伝える
  function renderPartnerKanjiButton(kanjiName, confidence) {
    if (!shadowRoot) return;
    const btn = shadowRoot.getElementById('fkb-partner-kanji-btn');
    if (!btn) return;
    if (!kanjiName) {
      btn.style.display = 'none';
      btn.dataset.partnerName = '';
      return;
    }
    const sure = confidence === 'high';
    btn.style.display = '';
    btn.dataset.partnerName = kanjiName;
    btn.textContent = `${sure ? '漢字' : '漢字?'}: ${kanjiName}`;
    btn.title = sure ? kanjiName : `${kanjiName}（推定に自信なし。同姓同名・同名事務所の可能性あり）`;
  }

  // ---- AI科目点検（自動経理で起票済みの科目の二次点検。表示のみ・書き換えは一切しない） ----

  // 「未決済取引の消込」を含む行だけが対象（伝票が紐づいた消込候補行。未マッチの取引登録フォームはスキップ）
  const KEIRI_CHECK_MATCHED_MARK = '未決済取引の消込';
  // このノイズ行は科目名として拾わない（「未決済取引の消込」の直後に出ることがある推測メッセージ）
  const KEIRI_CHECK_ACCOUNT_NOISE_RE = /金額が近い取引の消込を推測/;
  const KEIRI_CHECK_DATE_RE = /\d{4}-\d{2}-\d{2}/;
  const KEIRI_CHECK_ACCOUNT_HEADER_RE = /取引日/;
  const KEIRI_CHECK_AMOUNT_HEADER_RE = /取引金額/;
  // 摘要行の判定: カナ・英字を含み、金額・日付・ノイズだけの行でないこと
  const KEIRI_CHECK_DESC_LIKE_RE = /[ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ]/;

  // AI点検の結果キャッシュ（セッション内、キー→{verdict, suggested, reason}）。判定済みの行は再送しない
  const keiriCheckCache = new Map();
  // サーバーに1回でも到達できなかったら true にして、そのページロード中は再試行しない
  let keiriCheckServerDown = false;
  // 直近送信済みのキー集合（送信中の多重POST防止用）
  const keiriCheckInFlight = new Set();
  let keiriCheckScanTimer = null;
  // デバウンス待ち中のpending集合（同じ集合ならタイマーを張り直さない）
  let keiriCheckLastPendingKeys = new Set();

  // 明細の署名キー（キャッシュ・dedup兼用）
  function keiriCheckKey(date, amount, description, account) {
    return `${date}|${amount}|${_keiriCheckNormalize(description)}|${account}`;
  }

  // 全角→半角・空白除去程度の軽い正規化（サーバー側classify.pyの正規化と完全一致させる必要はなく、dedup用途）
  function _keiriCheckNormalize(text) {
    return normalizeAlnumWidth(String(text || ''))
      .toLowerCase()
      .replace(/[\s　]+/g, '');
  }

  // 行コンテナから {date, description, account, amount} を抽出する。
  // どれか1つでも取れなければ null（誤爆より取りこぼしを選ぶ）
  function extractKeiriCheckRow(rowEl) {
    const text = rowEl && rowEl.innerText;
    if (!text) return null;
    if (!text.includes(KEIRI_CHECK_MATCHED_MARK)) return null;

    // 自分が挿入したバッジの文字（⚠要確認/✓）はinnerTextに混ざるため先に除去する。
    // 残すと科目名が「消耗品費⚠要確認」に変わり、行の署名キーが変動して同じ行を再判定してしまう
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/⚠要確認|✓/g, '').trim())
      .filter((l) => l.length > 0);

    let date = null;
    for (const line of lines) {
      const m = line.match(KEIRI_CHECK_DATE_RE);
      if (m) {
        date = m[0];
        break;
      }
    }
    if (!date) return null;

    const matchedIdx = lines.findIndex((l) => l.includes(KEIRI_CHECK_MATCHED_MARK));
    if (matchedIdx === -1) return null;

    // account: まずfreeeの消込カードの科目要素（account-itemクラス）から直接取る。
    // 消込カードは行によって「取引先タグ＋科目」の2行構成になり、行テキスト解析だと
    // 取引先タグを科目として誤抽出するため（例: 取引先がメールアドレスの行）
    let account = null;
    const accountEl = rowEl.querySelector('[class*="account-item"]');
    if (accountEl && accountEl.innerText) {
      account = accountEl.innerText.replace(/⚠要確認|✓/g, '').trim() || null;
    }
    if (!account) {
      // フォールバック: 「未決済取引の消込」より後、「取引日」より前にある最初の非ノイズ行
      for (let i = matchedIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (KEIRI_CHECK_ACCOUNT_HEADER_RE.test(line)) break;
        if (KEIRI_CHECK_ACCOUNT_NOISE_RE.test(line)) continue;
        if (isPartnerNoiseToken(line)) continue;
        account = line;
        break;
      }
    }
    if (!account) return null;

    // amount: 「取引金額」の次の行の数値（カンマ除去して絶対値）
    let amount = null;
    for (let i = 0; i < lines.length; i++) {
      if (KEIRI_CHECK_AMOUNT_HEADER_RE.test(lines[i]) && lines[i + 1]) {
        const digits = lines[i + 1].replace(/[,，]/g, '').match(/-?\d+/);
        if (digits) amount = Math.abs(parseInt(digits[0], 10));
        break;
      }
    }
    if (amount === null || Number.isNaN(amount)) return null;

    // description: 摘要行。行の並びは 日付→口座名→摘要→金額→消込ブロック の順なので、
    // 消込ブロック（matchedIdx）より前の「最後の」候補行を採る（最初を採ると口座名行を誤採用する）
    const isDescCandidate = (line) =>
      line !== account &&
      !KEIRI_CHECK_DATE_RE.test(line) &&
      !KEIRI_CHECK_ACCOUNT_HEADER_RE.test(line) &&
      !KEIRI_CHECK_AMOUNT_HEADER_RE.test(line) &&
      !line.includes(KEIRI_CHECK_MATCHED_MARK) &&
      !KEIRI_CHECK_ACCOUNT_NOISE_RE.test(line) &&
      !isPartnerNoiseToken(line) &&
      !/^[0-9,，\-−―]+$/.test(line) &&
      KEIRI_CHECK_DESC_LIKE_RE.test(line);

    let description = null;
    for (let i = matchedIdx - 1; i >= 0; i--) {
      if (isDescCandidate(lines[i])) {
        description = lines[i];
        break;
      }
    }
    if (!description) {
      // フォールバック: 行の並びが想定と違うページでは全行から最初の候補を採る
      for (const line of lines) {
        if (isDescCandidate(line)) {
          description = line;
          break;
        }
      }
    }
    if (!description) return null;

    return { date, description, account, amount };
  }

  // 「未決済取引の消込」テキストを含む要素から行コンテナへ昇る。
  // 伝票が紐づいた消込候補行には入力欄が出ないことがあるため、入力欄起点ではなく
  // マークのテキストノード起点で行を特定する（DOMクラス名にも依存しない）。
  function findKeiriCheckRowContainer(el) {
    let node = el.closest('tr, li') || el;
    for (let depth = 0; node && node !== document.body && depth < 10; depth++) {
      const text = node.innerText || '';
      // マークを2つ以上含むコンテナまで昇ったら複数行を跨いでいるので行特定失敗として扱う
      if (text.split(KEIRI_CHECK_MATCHED_MARK).length > 2) return null;
      if (KEIRI_CHECK_DATE_RE.test(text) && KEIRI_CHECK_AMOUNT_HEADER_RE.test(text)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // ページ内の対象行（「未決済取引の消込」を含む行）をすべて集めて抽出する
  function collectKeiriCheckRows() {
    const marks = document.evaluate(
      `//text()[contains(., '${KEIRI_CHECK_MATCHED_MARK}')]`,
      document.body,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );
    const seen = new Set();
    const seenRows = new Set();
    const out = [];
    for (let i = 0; i < marks.snapshotLength; i++) {
      const markEl = marks.snapshotItem(i).parentElement;
      if (!markEl) continue;
      const row = findKeiriCheckRowContainer(markEl);
      if (!row || seenRows.has(row)) continue;
      seenRows.add(row);
      const extracted = extractKeiriCheckRow(row);
      if (!extracted) continue;
      const key = keiriCheckKey(extracted.date, extracted.amount, extracted.description, extracted.account);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ row, key, data: extracted });
    }
    return out;
  }

  // 判定済みキャッシュを元に行へバッジ（⚠/✓）を挿入する。Reactの再描画で消えても
  // data-fkb-checked を見て即座に再挿入できる（判定結果はキャッシュ済みなのでAPIは呼ばない）
  function applyKeiriCheckBadge(rowEl, key) {
    const result = keiriCheckCache.get(key);
    if (!result || result.verdict === 'unknown') return;

    // 挿入先: 抽出したaccount文字列と一致するテキストノードを含む行内の要素の近く
    const account = result.account || '';
    let target = null;
    if (account) {
      const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.trim() === account) {
          target = node.parentElement;
          break;
        }
      }
    }
    if (!target) target = rowEl;

    // 行内の既存バッジを確認: 同じ判定のバッジが正しい位置に付いていれば何もしない（毎秒のポーリングでDOMを触らない）。
    // 挿入先が変わった場合などに残る古いバッジ（行末フォールバック分等）はここで掃除する
    let alreadyApplied = false;
    for (const b of Array.from(rowEl.querySelectorAll('.fkb-keiri-badge'))) {
      if (!alreadyApplied && b.parentElement === target && b.dataset.fkbKey === key && b.dataset.fkbVerdict === result.verdict) {
        alreadyApplied = true;
      } else {
        b.remove();
      }
    }
    if (alreadyApplied) return;

    const badge = document.createElement('span');
    badge.className = 'fkb-keiri-badge';
    badge.setAttribute('data-fkb-keiri-badge', '1');
    badge.dataset.fkbKey = key;
    badge.dataset.fkbVerdict = result.verdict;
    if (result.verdict === 'warn') {
      badge.textContent = '⚠要確認';
      badge.title = `${result.reason || ''}${result.suggested ? `／候補: ${result.suggested}` : ''}`;
      badge.style.cssText =
        'display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;' +
        'font-size:11px;font-weight:700;color:#b45309;background:#fef3c7;white-space:nowrap;';
    } else {
      badge.textContent = '✓';
      badge.title = result.reason || 'AI点検OK';
      badge.style.cssText =
        'display:inline-block;margin-left:6px;font-size:11px;color:#999;white-space:nowrap;';
    }
    target.appendChild(badge);
    rowEl.setAttribute('data-fkb-checked', '1');
  }

  // ページ内の全対象行にバッジを適用し、パネルサマリ（要確認N件）を更新する
  function renderKeiriCheckBadges(rowEntries) {
    let warnCount = 0;
    let anyKnown = false;
    for (const { row, key } of rowEntries) {
      const result = keiriCheckCache.get(key);
      if (!result) continue;
      if (result.verdict === 'unknown') continue;
      anyKnown = true;
      if (result.verdict === 'warn') warnCount += 1;
      applyKeiriCheckBadge(row, key);
    }
    renderKeiriCheckSummary(anyKnown ? warnCount : null);
  }

  function renderKeiriCheckSummary(warnCount) {
    if (!shadowRoot) return;
    const el = shadowRoot.getElementById('fkb-keiri-summary');
    if (!el) return;
    if (keiriCheckServerDown || warnCount === null) {
      el.classList.remove('fkb-shown', 'fkb-keiri-warn');
      return;
    }
    el.classList.add('fkb-shown');
    if (warnCount > 0) {
      el.classList.add('fkb-keiri-warn');
      el.textContent = `AI点検: 要確認 ${warnCount}件`;
    } else {
      el.classList.remove('fkb-keiri-warn');
      el.textContent = 'AI点検: OK';
    }
  }

  // 未判定行をまとめてサーバーへ送る（最大30件、Content-Typeヘッダーなしのsimple requestでCORSプリフライトを避ける）
  function sendKeiriCheckBatch(pendingEntries) {
    if (pendingEntries.length === 0 || keiriCheckServerDown) return;
    const batch = pendingEntries.slice(0, 30);
    for (const entry of batch) keiriCheckInFlight.add(entry.key);

    const items = batch.map((entry) => ({
      id: entry.key,
      description: entry.data.description,
      amount: entry.data.amount,
      date: entry.data.date,
      account: entry.data.account,
    }));

    fetch(KEIRI_CHECK_API_URL, {
      method: 'POST',
      body: JSON.stringify({ items }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const results = (data && Array.isArray(data.results)) ? data.results : [];
        const byId = new Map(results.map((r) => [String(r.id), r]));
        for (const entry of batch) {
          const r = byId.get(entry.key);
          if (r) {
            keiriCheckCache.set(entry.key, {
              verdict: r.verdict === 'ok' || r.verdict === 'warn' ? r.verdict : 'unknown',
              suggested: r.suggested || null,
              reason: r.reason || '',
              account: entry.data.account,
            });
          } else {
            keiriCheckCache.set(entry.key, { verdict: 'unknown', suggested: null, reason: '', account: entry.data.account });
          }
          keiriCheckInFlight.delete(entry.key);
        }
        scanKeiriCheck();
      })
      .catch(() => {
        // サーバー未起動時は静かに機能オフ（ページロード中は再試行しない）
        keiriCheckServerDown = true;
        for (const entry of batch) keiriCheckInFlight.delete(entry.key);
        renderKeiriCheckSummary(null);
      });
  }

  // ページ内の対象行をスキャンし、未判定分だけをまとめて送信、判定済み分にはバッジを適用する。
  // 送信は新しい未判定行が見つかったときだけ1秒デバウンスする（毎秒のポーリング自体は即時実行してよい。
  // バッジの再挿入はReactの再描画で消えるたびに必要なため軽量でここは待たない）
  function scanKeiriCheck() {
    if (!shadowRoot || keiriCheckServerDown) return;
    const entries = collectKeiriCheckRows();
    const pending = [];
    for (const entry of entries) {
      if (!keiriCheckCache.has(entry.key) && !keiriCheckInFlight.has(entry.key)) {
        pending.push(entry);
      }
    }
    // バッジ適用とサマリ更新（判定済み分のみ。既に同じバッジが付いていればDOMは触らない）
    renderKeiriCheckBadges(entries);
    if (pending.length === 0) return;

    // 直前にデバウンス待ち中の集合と同じなら張り直さない（新規行が増えたときだけタイマーを更新）
    const pendingKeySet = new Set(pending.map((e) => e.key));
    const isSamePendingSet =
      keiriCheckScanTimer &&
      keiriCheckLastPendingKeys.size === pendingKeySet.size &&
      [...pendingKeySet].every((k) => keiriCheckLastPendingKeys.has(k));
    if (isSamePendingSet) return;

    keiriCheckLastPendingKeys = pendingKeySet;
    if (keiriCheckScanTimer) clearTimeout(keiriCheckScanTimer);
    keiriCheckScanTimer = setTimeout(() => {
      keiriCheckScanTimer = null;
      keiriCheckLastPendingKeys = new Set();
      sendKeiriCheckBatch(pending);
    }, 1000);
  }

  // ---- ドラッグ移動 ----
  function setupDrag(header, panel) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startRight = 0;
    let startBottom = 0;

    let panelW = 0;
    let panelH = 0;

    header.addEventListener('pointerdown', (e) => {
      // トグルボタンのクリックはドラッグにしない
      if (e.target && e.target.id === 'fkb-toggle') return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      panelW = rect.width;
      panelH = rect.height;
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      // ビューポート内に収める（画面外へドラッグして操作不能にならないように）
      const maxRight = Math.max(0, window.innerWidth - panelW);
      const maxBottom = Math.max(0, window.innerHeight - panelH);
      const newRight = Math.min(Math.max(0, startRight - dx), maxRight);
      const newBottom = Math.min(Math.max(0, startBottom - dy), maxBottom);
      currentPosition = { right: newRight, bottom: newBottom };
      panel.style.right = newRight + 'px';
      panel.style.bottom = newBottom + 'px';
      panel.style.left = 'auto';
      panel.style.top = 'auto';
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ fkb_position: currentPosition });
    }

    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
  }

  function setupToggle(toggle, panel) {
    toggle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      collapsed = !collapsed;
      applyCollapsed(panel);
      chrome.storage.local.set({ fkb_collapsed: collapsed });
    });
  }

  function setupNanpi(nanpiBtn) {
    nanpiBtn.addEventListener('pointerdown', (e) => {
      // ページ上の選択テキストを解除しない＆ヘッダードラッグを発動させない
      e.preventDefault();
      e.stopPropagation();
    });
    nanpiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNanpi();
    });
  }

  function applyCollapsed(panel) {
    if (collapsed) {
      panel.classList.add('fkb-collapsed');
    } else {
      panel.classList.remove('fkb-collapsed');
    }
    const toggle = shadowRoot.getElementById('fkb-toggle');
    if (toggle) toggle.textContent = collapsed ? '＋' : '−';
  }

  function applyPosition(panel) {
    panel.style.bottom = (currentPosition.bottom != null ? currentPosition.bottom : DEFAULT_POSITION.bottom) + 'px';
    panel.style.right = (currentPosition.right != null ? currentPosition.right : DEFAULT_POSITION.right) + 'px';
    clampIntoViewport(panel);
  }

  // 保存済み位置が画面外（ウィンドウ縮小・別解像度で保存した位置など）でも
  // パネルをビューポート内へ引き戻す。非表示中（display:none）はサイズが測れないので何もしない
  function clampIntoViewport(panel) {
    const rect = panel.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const right = window.innerWidth - rect.right;
    const bottom = window.innerHeight - rect.bottom;
    const maxRight = Math.max(0, window.innerWidth - rect.width);
    const maxBottom = Math.max(0, window.innerHeight - rect.height);
    const newRight = Math.min(Math.max(0, right), maxRight);
    const newBottom = Math.min(Math.max(0, bottom), maxBottom);
    if (newRight === right && newBottom === bottom) return;
    currentPosition = { right: newRight, bottom: newBottom };
    panel.style.right = newRight + 'px';
    panel.style.bottom = newBottom + 'px';
    panel.style.left = 'auto';
    panel.style.top = 'auto';
    chrome.storage.local.set({ fkb_position: currentPosition });
  }

  // ---- 表示/非表示ポーリング ----
  function updateVisibility() {
    if (!shadowRoot) return;
    const panel = shadowRoot.getElementById('fkb-panel');
    if (!panel) return;
    const hasInput = findAllAccountInputs().some(isVisible);
    if (hasInput && !panelVisible) {
      panel.classList.add('fkb-shown');
      panelVisible = true;
      // 表示された瞬間に画面外チェック（非表示中はサイズが測れないためここで行う）
      clampIntoViewport(panel);
    } else if (!hasInput && panelVisible) {
      panel.classList.remove('fkb-shown');
      panelVisible = false;
    }
  }

  // ---- storage読み込み・監視 ----
  function loadStorageAndInit() {
    chrome.storage.sync.get(
      { accounts: DEFAULT_ACCOUNTS },
      (syncResult) => {
        currentAccounts = (syncResult.accounts && syncResult.accounts.length > 0)
          ? syncResult.accounts
          : DEFAULT_ACCOUNTS.slice();
        chrome.storage.local.get(
          { fkb_position: DEFAULT_POSITION, fkb_collapsed: false, [LEARNED_STORAGE_KEY]: {} },
          (localResult) => {
            currentPosition = localResult.fkb_position || Object.assign({}, DEFAULT_POSITION);
            collapsed = !!localResult.fkb_collapsed;
            learnedAccounts = localResult[LEARNED_STORAGE_KEY] || {};
            buildPanel();
            setInterval(() => {
              updateVisibility();
              updatePartnerSuggestion();
              updateLearnedSuggestion();
              scanKeiriCheck();
            }, 1000);
            updateVisibility();
            scanKeiriCheck();
            // ウィンドウ縮小でパネルが画面外に残らないように追従する
            window.addEventListener('resize', () => {
              const panel = shadowRoot && shadowRoot.getElementById('fkb-panel');
              if (panel && panelVisible) clampIntoViewport(panel);
            });
          }
        );
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && changes.accounts) {
      currentAccounts = changes.accounts.newValue && changes.accounts.newValue.length > 0
        ? changes.accounts.newValue
        : DEFAULT_ACCOUNTS.slice();
      renderButtons();
    }
    if (areaName === 'local') {
      // 別タブでの学習結果も反映する
      if (changes[LEARNED_STORAGE_KEY]) {
        learnedAccounts = changes[LEARNED_STORAGE_KEY].newValue || {};
      }
      if (changes.fkb_position && shadowRoot) {
        currentPosition = changes.fkb_position.newValue || DEFAULT_POSITION;
        const panel = shadowRoot.getElementById('fkb-panel');
        if (panel) applyPosition(panel);
      }
      if (changes.fkb_collapsed && shadowRoot) {
        collapsed = !!changes.fkb_collapsed.newValue;
        const panel = shadowRoot.getElementById('fkb-panel');
        if (panel) applyCollapsed(panel);
      }
    }
  });

  loadStorageAndInit();
})();

// ════════════════════════════════════════════════════════════════════════════
// freeeファイルボックス AI経理処理（フェーズ2）
// 既存の勘定科目ボタン機能とは完全に独立したIIFE。専用のshadow-rootホストを
// 持ち、状態も共有しない（既存機能を壊さないための分離）。
// ファイルボックス/証憑ページで右下に「🌸 AI経理処理」ボタンを出し、
// クリック→server.py(3460)がヘッドレスclaude -pで準備フェーズを実行→
// 承認パネルでチェック→登録フェーズ、の順で回す。承認は必ず人間が行う。
// ════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API_BASE = 'http://localhost:3460';
  const PREPARE_URL  = API_BASE + '/api/filebox/prepare';
  const STATUS_URL   = API_BASE + '/api/filebox/status';
  const REGISTER_URL = API_BASE + '/api/filebox/register';
  const POLL_MS = 8000;         // status ポーリング間隔
  const POLL_MAX = 360;         // 最大ポーリング回数（8秒×360=約48分。サーバー側のclaude -pタイムアウト45分より長く）

  let host = null;
  let root = null;
  let fabShown = false;
  let currentJobId = null;
  let currentDraftPath = null;
  let pollCount = 0;
  let pollTimer = null;
  let elapsedTimer = null;
  let startedAt = 0;

  // ファイルボックス/証憑ページ判定（SPAなのでURLで判定）
  function isFileboxPage() {
    const p = location.pathname.toLowerCase();
    return p.indexOf('receipts') !== -1 || p.indexOf('file_box') !== -1 || p.indexOf('filebox') !== -1;
  }

  function fmtYen(n) {
    if (n === null || n === undefined || n === '') return '';
    const num = typeof n === 'number' ? n : parseInt(String(n).replace(/[^0-9\-]/g, ''), 10);
    if (isNaN(num)) return String(n);
    return num.toLocaleString('ja-JP');
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // freeeヘッダーから事業所名を取得（取れなければ null）
  // 手入力フォールバックは廃止（タイプミスが事業所照合ゲートを通り抜ける穴になるため）。
  // 取れなければ呼び出し側でエラー中止する
  function detectCompanyName() {
    // 事業所切替のトリガーやヘッダー表示から拾う。freeeのDOMは変わりうるので複数候補を試す
    const selectors = [
      '[class*="CompanySwitch"] [class*="name"]',
      '[data-testid="company-name"]',
      'header [class*="company"]',
      '.global-header-company-name',
      '[class*="GlobalNav"] [class*="company"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim()) {
          return el.textContent.trim().slice(0, 100);
        }
      } catch (e) { /* セレクタ非対応は無視 */ }
    }

    // フォールバック: ヘッダー/ナビ領域のテキストノードから法人格キーワードを含む
    // 短い1行テキストを拾う（画面右上の「🏢 株式会社◯◯」表示を想定）
    const CORP_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|税理士法人|医療法人|学校法人|NPO法人|㈱|（株）|\(株\)|（同）|（有）)/;
    const areas = document.querySelectorAll(
      'header, nav, [class*="Header"], [class*="header"], [class*="GlobalNav"], [class*="globalNav"], [class*="global-nav"]'
    );
    let best = null;
    for (const area of areas) {
      let walker;
      try { walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT); } catch (e) { continue; }
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (!t || t.length > 60 || t.indexOf('\n') !== -1) continue;
        if (!CORP_RE.test(t)) continue;
        if (t.toLowerCase().indexOf('freee') !== -1) continue; // 「freee株式会社」等のサービス側表記を除外
        if (!best || t.length < best.length) best = t;
      }
    }
    if (best) return best.slice(0, 100);
    return null;
  }

  function buildHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'freee-filebox-keiri-host';
    host.style.all = 'initial';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    // 既存パネルと同じ vibes トークン: プライマリ #285ac8 / 枠線 #dcdcdc / 文字 #323232 / 角丸8px
    style.textContent = `
      :host { all: initial; }
      .ffk-fab {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 2147483200;
        background: #285ac8;
        color: #fff;
        border: none;
        border-radius: 24px;
        padding: 12px 18px;
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", メイリオ, Meiryo, sans-serif;
        font-size: 14px;
        font-weight: 700;
        cursor: pointer;
        box-shadow: 0 3px 12px rgba(40, 90, 200, 0.35);
        display: none;
      }
      .ffk-fab.ffk-shown { display: inline-flex; align-items: center; gap: 6px; }
      .ffk-fab:hover { background: #1f49a5; }
      .ffk-fab:disabled { opacity: 0.6; cursor: default; }

      .ffk-overlay {
        position: fixed; inset: 0; z-index: 2147483300;
        background: rgba(0,0,0,0.45);
        display: none; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", メイリオ, Meiryo, sans-serif;
        color: #323232;
      }
      .ffk-overlay.ffk-shown { display: flex; }
      .ffk-modal {
        background: #fff; border-radius: 8px;
        box-shadow: 0 6px 30px rgba(0,0,0,0.3);
        width: min(920px, 94vw); max-height: 88vh;
        display: flex; flex-direction: column; overflow: hidden;
      }
      .ffk-mhead {
        background: #285ac8; color: #fff;
        padding: 12px 18px; font-size: 15px; font-weight: 700;
        display: flex; align-items: center; justify-content: space-between;
      }
      .ffk-mhead .ffk-x { cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
      .ffk-mhead .ffk-x:hover { background: rgba(255,255,255,0.25); }
      .ffk-mbody { padding: 16px 18px; overflow: auto; }
      .ffk-mfoot {
        padding: 12px 18px; border-top: 1px solid #dcdcdc;
        display: flex; gap: 10px; justify-content: flex-end; align-items: center;
      }
      .ffk-note { font-size: 12px; color: #666; margin-bottom: 10px; line-height: 1.6; }
      .ffk-spinner {
        width: 34px; height: 34px; border: 4px solid #dce4f5; border-top-color: #285ac8;
        border-radius: 50%; animation: ffk-spin 0.9s linear infinite; margin: 8px auto 12px;
      }
      @keyframes ffk-spin { to { transform: rotate(360deg); } }
      .ffk-progress { text-align: center; padding: 24px 8px; }
      .ffk-elapsed { font-size: 13px; color: #285ac8; font-weight: 700; }
      table.ffk-tbl { border-collapse: collapse; width: 100%; font-size: 12px; }
      table.ffk-tbl th, table.ffk-tbl td {
        border: 1px solid #e2e2e2; padding: 6px 8px; text-align: left; vertical-align: top;
      }
      table.ffk-tbl th { background: #f0f4fc; color: #285ac8; font-weight: 700; white-space: nowrap; }
      table.ffk-tbl td.ffk-amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      table.ffk-tbl tr.ffk-flagged td { background: #fff6f6; }
      .ffk-flag { color: #c0392b; font-size: 11px; display: block; margin-top: 2px; }
      .ffk-action-new { color: #285ac8; font-weight: 700; }
      .ffk-action-attach { color: #8a6d00; font-weight: 700; }
      .ffk-btn {
        font-family: inherit; font-size: 13px; font-weight: 700;
        padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid #dcdcdc; background: #fff; color: #323232;
      }
      .ffk-btn:hover { background: #f0f4fc; border-color: #285ac8; color: #285ac8; }
      .ffk-btn.ffk-primary { background: #285ac8; color: #fff; border-color: #285ac8; }
      .ffk-btn.ffk-primary:hover { background: #1f49a5; color: #fff; }
      .ffk-btn:disabled { opacity: 0.5; cursor: default; }
      .ffk-err { color: #c0392b; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
      .ffk-report { font-size: 13px; line-height: 1.7; white-space: pre-wrap; background: #f7f9fc; border: 1px solid #dcdcdc; border-radius: 6px; padding: 12px; }
      .ffk-check { width: 16px; height: 16px; cursor: pointer; }
      .ffk-count { font-size: 12px; color: #666; margin-right: auto; }
    `;
    root.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'ffk-fab';
    fab.id = 'ffk-fab';
    fab.textContent = '🌸 AI経理処理';
    fab.addEventListener('click', onFabClick);
    root.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.className = 'ffk-overlay';
    overlay.id = 'ffk-overlay';
    root.appendChild(overlay);
  }

  function showFab(show) {
    const fab = root && root.getElementById('ffk-fab');
    if (!fab) return;
    if (show) fab.classList.add('ffk-shown'); else fab.classList.remove('ffk-shown');
    fabShown = show;
  }

  function openOverlay(innerHtml) {
    const overlay = root.getElementById('ffk-overlay');
    overlay.innerHTML = `
      <div class="ffk-modal">
        <div class="ffk-mhead">
          <span>🌸 ファイルボックス AI経理処理</span>
          <span class="ffk-x" id="ffk-close">×</span>
        </div>
        <div class="ffk-mbody" id="ffk-mbody"></div>
        <div class="ffk-mfoot" id="ffk-mfoot"></div>
      </div>`;
    overlay.classList.add('ffk-shown');
    overlay.querySelector('#ffk-close').addEventListener('click', closeOverlay);
    setBody(innerHtml || '');
  }

  function setBody(html) {
    const b = root.getElementById('ffk-mbody');
    if (b) b.innerHTML = html;
  }
  function setFoot(html) {
    const f = root.getElementById('ffk-mfoot');
    if (f) f.innerHTML = html;
  }

  function closeOverlay() {
    const overlay = root.getElementById('ffk-overlay');
    if (overlay) overlay.classList.remove('ffk-shown');
    stopPolling();
    stopElapsed();
    // FABはクリック可能に戻す
    const fab = root.getElementById('ffk-fab');
    if (fab) fab.disabled = false;
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }
  function startElapsed() {
    startedAt = Date.now();
    stopElapsed();
    elapsedTimer = setInterval(() => {
      const el = root.getElementById('ffk-elapsed');
      if (el) {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        const m = Math.floor(sec / 60), s = sec % 60;
        el.textContent = `経過 ${m}分${String(s).padStart(2, '0')}秒`;
      }
    }, 1000);
  }
  function stopElapsed() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function progressView(msg) {
    return `
      <div class="ffk-progress">
        <div class="ffk-spinner"></div>
        <div style="font-size:14px;font-weight:700;margin-bottom:6px;">${esc(msg)}</div>
        <div class="ffk-elapsed" id="ffk-elapsed">経過 0分00秒</div>
        <div class="ffk-note" style="margin-top:14px;">準備フェーズ（取得→OCR→分類→重複チェック）は<br>5〜10分ほどかかるよ。閉じても処理は続くけど、<br>結果を見るにはこのままにしておいてね。</div>
      </div>`;
  }

  function serverDownView() {
    return `<div class="ffk-err">サーバーに繋がらなかったよ。<br>ハタケダッシュボードを起動してね（start-dashboard.vbs / python server.py）。</div>`;
  }

  // ---- FABクリック → 準備フェーズ起動 ----
  function onFabClick() {
    const fab = root.getElementById('ffk-fab');
    if (fab) fab.disabled = true;

    // 今開いている事業所に固定。手入力は誤登録（他事業所との混在）の穴になるため廃止
    const company = detectCompanyName();
    if (!company) {
      openOverlay(`<div class="ffk-err">画面から事業所名を自動取得できなかったから、安全のため中止したよ。<br>（手入力は誤登録防止のため廃止）<br>freeeの画面構成が変わったかも。はなに「🌸ボタンで事業所名が取れない」って伝えてね。</div>`);
      if (fab) fab.disabled = false;
      return;
    }

    openOverlay(progressView(`${company} の未登録証憑を処理中…`));
    startElapsed();

    fetch(PREPARE_URL, {
      method: 'POST',
      // 簡易リクエスト（Content-Typeヘッダーを付けずCORSプリフライトを避ける。サーバーは本文をJSONとして読む）
      body: JSON.stringify({ company_name: company }),
    })
      .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
      .then((data) => {
        currentJobId = data.job_id;
        pollCount = 0;
        pollStatus();
      })
      .catch((err) => {
        stopElapsed();
        if (err && err.error) {
          setBody(`<div class="ffk-err">エラー: ${esc(err.error)}</div>`);
        } else {
          setBody(serverDownView());
        }
      });
  }

  // ---- ステータスポーリング ----
  function pollStatus() {
    stopPolling();
    pollTimer = setTimeout(() => {
      pollCount++;
      fetch(`${STATUS_URL}?job_id=${encodeURIComponent(currentJobId)}`)
        .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
        .then((data) => {
          if (data.status === 'running') {
            if (pollCount >= POLL_MAX) {
              stopElapsed();
              setBody(`<div class="ffk-err">タイムアウトしたよ。時間がかかりすぎてる。<br>サーバーのログを確認してね。</div>`);
              return;
            }
            pollStatus();
          } else if (data.status === 'done') {
            stopElapsed();
            if (data.phase === 'prepare') {
              // 登録フェーズで使うドラフトパスはstatusレスポンスから受け取る
              currentDraftPath = data.draft_path || null;
              renderApproval(data.draft);
            } else if (data.phase === 'register') {
              renderReport(data.report);
            }
          } else {
            stopElapsed();
            setBody(`<div class="ffk-err">エラー: ${esc(data.error || '不明なエラー')}</div>`);
          }
        })
        .catch((err) => {
          // 一時的なfetch失敗はリトライ（サーバー再起動中など）。上限までは粘る
          if (pollCount >= POLL_MAX) {
            stopElapsed();
            setBody(serverDownView());
          } else {
            pollStatus();
          }
        });
    }, POLL_MS);
  }

  // ---- 承認パネル ----
  function renderApproval(draft) {
    // status が pending 以外（registered/attached 等の処理済み）は絶対に出さない
    // （登録済み行の再登録＝二重計上の防止）
    const allItems = (draft && Array.isArray(draft.items)) ? draft.items : [];
    const items = allItems.filter((it) => !it.status || it.status === 'pending');
    const doneCount = allItems.length - items.length;

    if (items.length === 0) {
      const extra = doneCount > 0 ? `（処理済みの${doneCount}件は表示していないよ）` : '';
      setBody(`<div class="ffk-note">未登録の証憑はなかったよ。処理はここで終わり。${esc(extra)}</div>`);
      setFoot(`<button class="ffk-btn" id="ffk-done">閉じる</button>`);
      const d = root.getElementById('ffk-done');
      if (d) d.addEventListener('click', closeOverlay);
      return;
    }
    if (draft.draft_path) currentDraftPath = draft.draft_path;

    const rows = items.map((it) => {
      const no = it.no;
      const flags = Array.isArray(it.flags) ? it.flags : (it.flags ? [it.flags] : []);
      const flagged = flags.length > 0;
      // フラグが空 → デフォルトON、フラグあり → デフォルトOFF
      const checked = flagged ? '' : 'checked';
      const action = it.action || (it.existing_deal_id ? 'attach_to_existing' : 'create_deal');
      const actionLabel = action === 'attach_to_existing'
        ? '<span class="ffk-action-attach">既存取引に紐づけ</span>'
        : '<span class="ffk-action-new">新規登録</span>';
      const flagHtml = flags.map((f) => `<span class="ffk-flag">⚠ ${esc(f)}</span>`).join('');
      const doc = it.doc || it.description || '';
      return `
        <tr class="${flagged ? 'ffk-flagged' : ''}">
          <td style="text-align:center;"><input type="checkbox" class="ffk-check" data-no="${esc(no)}" ${checked}></td>
          <td>${esc(no)}</td>
          <td>${esc(it.partner_name || '')}</td>
          <td style="white-space:nowrap;">${esc(it.issue_date || '')}</td>
          <td class="ffk-amt">${fmtYen(it.amount)}</td>
          <td>${actionLabel}</td>
          <td>${esc(doc)}${flagHtml}</td>
        </tr>`;
    }).join('');

    setBody(`
      <div class="ffk-note">
        <b>${esc(draft.company_name || '')}</b> の未登録証憑 ${items.length}件。${doneCount > 0 ? esc(`（処理済み${doneCount}件は非表示）`) : ''}<br>
        チェックした行だけ登録するよ。⚠フラグ付き（要確認）は既定でオフにしてある。<br>
        登録の最終判断はけんとさんがやってね。
      </div>
      <div style="overflow-x:auto;">
        <table class="ffk-tbl">
          <thead>
            <tr>
              <th style="width:34px;">選択</th><th>No</th><th>取引先</th><th>発生日</th>
              <th style="text-align:right;">金額</th><th>処理</th><th>内容 / フラグ</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);

    setFoot(`
      <span class="ffk-count" id="ffk-count"></span>
      <button class="ffk-btn" id="ffk-cancel">閉じる</button>
      <button class="ffk-btn ffk-primary" id="ffk-register">✅ チェックした分を登録</button>`);

    const cancel = root.getElementById('ffk-cancel');
    if (cancel) cancel.addEventListener('click', closeOverlay);
    const reg = root.getElementById('ffk-register');
    if (reg) reg.addEventListener('click', onRegisterClick);
    root.querySelectorAll('.ffk-check').forEach((cb) => cb.addEventListener('change', updateCount));
    updateCount();
  }

  function selectedNos() {
    const nos = [];
    root.querySelectorAll('.ffk-check').forEach((cb) => {
      if (cb.checked) {
        const n = parseInt(cb.getAttribute('data-no'), 10);
        if (!isNaN(n)) nos.push(n);
      }
    });
    return nos;
  }

  function updateCount() {
    const c = root.getElementById('ffk-count');
    if (c) {
      const n = selectedNos().length;
      c.textContent = `${n}件を登録対象に選択中`;
    }
  }

  // ---- 登録フェーズ起動 ----
  function onRegisterClick() {
    const nos = selectedNos();
    if (nos.length === 0) {
      window.alert('登録する行を1つ以上チェックしてね。');
      return;
    }
    if (!currentDraftPath) {
      window.alert('ドラフトの保存先が取れなかったよ。もう一度準備からやり直してね。');
      return;
    }
    const reg = root.getElementById('ffk-register');
    if (reg) reg.disabled = true;

    setBody(progressView(`承認した ${nos.length}件を登録中…`));
    setFoot('');
    startElapsed();

    fetch(REGISTER_URL, {
      method: 'POST',
      body: JSON.stringify({
        job_id: currentJobId,
        draft_path: currentDraftPath,
        approved_nos: nos,
      }),
    })
      .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
      .then((data) => {
        currentJobId = data.job_id;
        pollCount = 0;
        pollStatus();
      })
      .catch((err) => {
        stopElapsed();
        if (err && err.error) {
          setBody(`<div class="ffk-err">登録リクエストが拒否されたよ: ${esc(err.error)}</div>`);
        } else {
          setBody(serverDownView());
        }
        setFoot(`<button class="ffk-btn" id="ffk-done2">閉じる</button>`);
        const d = root.getElementById('ffk-done2');
        if (d) d.addEventListener('click', closeOverlay);
      });
  }

  // ---- 完了レポート ----
  function renderReport(report) {
    setBody(`
      <div class="ffk-note">登録が完了したよ。内容を確認してね。</div>
      <div class="ffk-report">${esc(report || '（レポートなし）')}</div>`);
    setFoot(`<button class="ffk-btn ffk-primary" id="ffk-done3">閉じる</button>`);
    const d = root.getElementById('ffk-done3');
    if (d) d.addEventListener('click', closeOverlay);
  }

  // ---- 可視性の監視（SPAのURL変化に追従。既存パネルと同じ1秒ポーリング方式）----
  function tick() {
    if (!root) return;
    const should = isFileboxPage();
    if (should !== fabShown) showFab(should);
  }

  function init() {
    buildHost();
    setInterval(tick, 1000);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// ════════════════════════════════════════════════════════════════════════════
// 🔁 繰返し起票（repeat-keiri / フェーズ3）
// 既存の勘定科目ボタン・ファイルボックス経理とは完全に独立したIIFE。専用の
// shadow-rootホストを持ち、状態も共有しない（既存機能を壊さないための分離）。
// 取引詳細・振替伝票詳細ページで右下に「🔁 繰返し起票」ボタンを出し、
// 回数×開始月を指定 → server.py(3460)がヘッドレスclaudeで元伝票を取得し
// Python側で決定論的にN件のペイロードを生成 → プレビュー承認 → 登録、の順で回す。
// 金額・科目はサーバー側で組み立てるだけで、この拡張は表示と承認のみを担う。
// ════════════════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const API_BASE = 'http://localhost:3460';
  const PREPARE_URL  = API_BASE + '/api/repeat-keiri/prepare';
  const STATUS_URL   = API_BASE + '/api/repeat-keiri/status';
  const REGISTER_URL = API_BASE + '/api/repeat-keiri/register';
  const POLL_MS = 5000;
  const POLL_MAX = 120;         // 5秒×120=約10分（元伝票1件の取得なので短め）

  let host = null;
  let root = null;
  let fabShown = false;
  let currentJobId = null;      // prepare のジョブID（register でそのまま使う）
  let pollCount = 0;
  let pollTimer = null;
  let elapsedTimer = null;
  let startedAt = 0;
  let lastPreview = null;

  // 取引/振替伝票の詳細ページか（SPAなのでURL+ハッシュで判定。厳密判定はしない＝
  // ボタンは出して、IDが取れなければ手入力に頼る）
  function isVoucherPage() {
    const p = (location.pathname + location.hash).toLowerCase();
    return p.indexOf('deals') !== -1 || p.indexOf('manual_journal') !== -1;
  }

  // 「取引の詳細」「振替伝票」モーダルが開いているか（レポート・月次推移など
  // URLが変わらない画面から開くケース）。開いていれば種別を返す。
  function voucherModalType() {
    const heads = document.querySelectorAll('h1, h2, h3, [class*="title"], [class*="Title"], [class*="heading"], [class*="Heading"]');
    for (const el of heads) {
      const t = (el.textContent || '').trim();
      if (t !== '取引の詳細' && t !== '振替伝票の詳細' && t !== '振替伝票詳細' && t !== '振替伝票') continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width > 0 && r.height > 0) return (t.indexOf('振替') === 0) ? 'manual_journal' : 'deal';
    }
    return null;
  }

  // ページが伝票APIを叩いたら、そのURLから種別・ID・company_idを覚えておく。
  // Resource Timingのバッファ（既定250件）はレポート等の重い画面で満杯になり、
  // 後から開いたモーダルのAPIが記録されないため、PerformanceObserverで発生時に拾う。
  let lastApiVoucher = null; // { type, id, company_id }
  function noteApiUrl(u) {
    if (!u || u.indexOf('secure.freee.co.jp') === -1) return;
    let type = null, id = null;
    // モーダルのAPIは deals/standard/{id} のようにIDの前に1セグメント挟まる形
    // （実測: /api/p/deals/standard/3397272913）。挟まらない形も両方拾う。
    let m = u.match(/manual_journals\/(?:[a-z_]+\/)?([0-9]+)(?=[/?#]|$)/) || u.match(/[?&]manual_journal_id=([0-9]+)/);
    if (m) { type = 'manual_journal'; id = m[1]; }
    else {
      m = u.match(/deals\/(?:[a-z_]+\/)?([0-9]+)(?=[/?#]|$)/) || u.match(/[?&]deal_id=([0-9]+)/);
      if (m) { type = 'deal'; id = m[1]; }
    }
    if (!id) return;
    const cm = u.match(/[?&]company_id=([0-9]+)/);
    lastApiVoucher = { type: type, id: id, company_id: cm ? cm[1] : null };
  }
  function watchVoucherApi() {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        for (const en of entries) noteApiUrl(en.name || '');
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch (e) { /* 未対応ブラウザは従来のバッファスキャンで拾う */ }
    try {
      if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(10000);
    } catch (e) { /* ignore */ }
  }

  // URLから伝票種別・伝票ID・company_idを推測（決め打ちせず複数パターンを試す）。
  // 取れなければ null。手入力フォールバックがあるので不完全でよい。
  function detectVoucher() {
    const hay = location.pathname + location.hash + location.search;
    let type = null, id = null;
    const pats = [
      { re: /manual_journals?[^0-9]*([0-9]+)/i, type: 'manual_journal' },
      { re: /deals?[^0-9]*([0-9]+)/i,           type: 'deal' },
    ];
    for (const pt of pats) {
      const m = hay.match(pt.re);
      if (m) { type = pt.type; id = m[1]; break; }
    }
    // URLから取れないとき（モーダル表示）：モーダルが裏で叩いたAPIのURLから
    // 最新の伝票IDを拾う。誤検出防止のため、モーダルが開いているときだけ使い、
    // プリフィルはフォームに表示して確認してもらう。
    if (!id && voucherModalType()) {
      if (lastApiVoucher) {
        type = lastApiVoucher.type;
        id = lastApiVoucher.id;
        if (lastApiVoucher.company_id) detectVoucher._cidFromApi = lastApiVoucher.company_id;
      } else {
        try {
          const res = performance.getEntriesByType('resource');
          for (let i = res.length - 1; i >= 0; i--) {
            const u = res[i].name || '';
            if (u.indexOf('secure.freee.co.jp') === -1) continue;
            let m = u.match(/manual_journals\/(?:[a-z_]+\/)?([0-9]+)(?=[/?#]|$)/);
            if (m) { type = 'manual_journal'; id = m[1]; }
            else {
              m = u.match(/deals\/(?:[a-z_]+\/)?([0-9]+)(?=[/?#]|$)/);
              if (m) { type = 'deal'; id = m[1]; }
            }
            if (m) {
              const cm = u.match(/[?&]company_id=([0-9]+)/);
              if (cm) detectVoucher._cidFromApi = cm[1];
              break;
            }
          }
        } catch (e) { /* ignore */ }
      }
    }
    let cid = null;
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('company_id') && /^\d+$/.test(q.get('company_id'))) cid = q.get('company_id');
    } catch (e) { /* ignore */ }
    if (!cid) {
      const m = hay.match(/[?&#/]company_id[=/]([0-9]+)/);
      if (m) cid = m[1];
    }
    if (!cid && detectVoucher._cidFromApi) cid = detectVoucher._cidFromApi;
    return { type: type, id: id, company_id: cid };
  }

  // freeeヘッダーから事業所名を取得（filebox版と同じ方針。取れなければ null）
  function detectCompanyName() {
    const selectors = [
      '[class*="CompanySwitch"] [class*="name"]',
      '[data-testid="company-name"]',
      'header [class*="company"]',
      '.global-header-company-name',
      '[class*="GlobalNav"] [class*="company"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.textContent && el.textContent.trim()) return el.textContent.trim().slice(0, 100);
      } catch (e) { /* ignore */ }
    }
    const CORP_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|税理士法人|医療法人|学校法人|NPO法人|㈱|（株）|\(株\)|（同）|（有）)/;
    const areas = document.querySelectorAll('header, nav, [class*="Header"], [class*="header"], [class*="GlobalNav"], [class*="globalNav"], [class*="global-nav"]');
    let best = null;
    for (const area of areas) {
      let walker;
      try { walker = document.createTreeWalker(area, NodeFilter.SHOW_TEXT); } catch (e) { continue; }
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (!t || t.length > 60 || t.indexOf('\n') !== -1) continue;
        if (!CORP_RE.test(t)) continue;
        if (t.toLowerCase().indexOf('freee') !== -1) continue;
        if (!best || t.length < best.length) best = t;
      }
    }
    return best ? best.slice(0, 100) : null;
  }

  function fmtYen(n) {
    if (n === null || n === undefined || n === '') return '';
    const num = typeof n === 'number' ? n : parseInt(String(n).replace(/[^0-9\-]/g, ''), 10);
    if (isNaN(num)) return String(n);
    return num.toLocaleString('ja-JP');
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function thisMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function buildHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'freee-repeat-keiri-host';
    host.style.all = 'initial';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    // filebox と同じトークン。FABは filebox(bottom:20)と被らないよう少し上に置く
    style.textContent = `
      :host { all: initial; }
      .rkb-fab {
        position: fixed; right: 20px; bottom: 74px; z-index: 2147483200;
        background: #6b3fa0; color: #fff; border: none; border-radius: 24px;
        padding: 12px 18px;
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", メイリオ, Meiryo, sans-serif;
        font-size: 14px; font-weight: 700; cursor: pointer;
        box-shadow: 0 3px 12px rgba(107, 63, 160, 0.35); display: none;
      }
      .rkb-fab.rkb-shown { display: inline-flex; align-items: center; gap: 6px; }
      .rkb-fab:hover { background: #57327f; }
      .rkb-fab:disabled { opacity: 0.6; cursor: default; }
      .rkb-overlay {
        position: fixed; inset: 0; z-index: 2147483300; background: rgba(0,0,0,0.45);
        display: none; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", メイリオ, Meiryo, sans-serif;
        color: #323232;
      }
      .rkb-overlay.rkb-shown { display: flex; }
      .rkb-modal {
        background: #fff; border-radius: 8px; box-shadow: 0 6px 30px rgba(0,0,0,0.3);
        width: min(880px, 94vw); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden;
      }
      .rkb-mhead {
        background: #6b3fa0; color: #fff; padding: 12px 18px; font-size: 15px; font-weight: 700;
        display: flex; align-items: center; justify-content: space-between;
      }
      .rkb-mhead .rkb-x { cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 4px; }
      .rkb-mhead .rkb-x:hover { background: rgba(255,255,255,0.25); }
      .rkb-mbody { padding: 16px 18px; overflow: auto; }
      .rkb-mfoot { padding: 12px 18px; border-top: 1px solid #dcdcdc; display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
      .rkb-note { font-size: 12px; color: #666; margin-bottom: 12px; line-height: 1.7; }
      .rkb-warn { color: #b9770e; font-weight: 700; }
      .rkb-field { margin-bottom: 14px; }
      .rkb-field > label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 6px; color: #444; }
      .rkb-radio { display: inline-flex; gap: 14px; font-size: 13px; align-items: center; }
      .rkb-radio label { font-weight: 400; cursor: pointer; }
      .rkb-input, .rkb-month {
        font-family: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid #cfcfcf; border-radius: 6px; color: #323232;
      }
      .rkb-input:focus, .rkb-month:focus { outline: none; border-color: #6b3fa0; }
      .rkb-presets { display: inline-flex; gap: 6px; margin-right: 10px; }
      .rkb-chip {
        font-family: inherit; font-size: 13px; font-weight: 700; padding: 6px 12px; border-radius: 16px;
        border: 1px solid #cfcfcf; background: #fff; color: #444; cursor: pointer;
      }
      .rkb-chip:hover { border-color: #6b3fa0; color: #6b3fa0; }
      .rkb-chip.rkb-active { background: #6b3fa0; color: #fff; border-color: #6b3fa0; }
      .rkb-spinner {
        width: 34px; height: 34px; border: 4px solid #e4dcf1; border-top-color: #6b3fa0;
        border-radius: 50%; animation: rkb-spin 0.9s linear infinite; margin: 8px auto 12px;
      }
      @keyframes rkb-spin { to { transform: rotate(360deg); } }
      .rkb-progress { text-align: center; padding: 24px 8px; }
      .rkb-elapsed { font-size: 13px; color: #6b3fa0; font-weight: 700; }
      table.rkb-tbl { border-collapse: collapse; width: 100%; font-size: 12px; }
      table.rkb-tbl th, table.rkb-tbl td { border: 1px solid #e2e2e2; padding: 6px 8px; text-align: left; vertical-align: top; }
      table.rkb-tbl th { background: #f4f0fa; color: #6b3fa0; font-weight: 700; white-space: nowrap; }
      table.rkb-tbl td.rkb-amt { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .rkb-trunc { background: #fff8ec; border: 1px solid #f0d9a8; border-radius: 6px; padding: 10px 12px; font-size: 12.5px; color: #8a6d00; line-height: 1.7; margin-bottom: 12px; }
      .rkb-total { font-size: 13px; font-weight: 700; margin-top: 10px; text-align: right; }
      .rkb-lines { font-size: 11.5px; color: #555; line-height: 1.6; }
      .rkb-btn {
        font-family: inherit; font-size: 13px; font-weight: 700; padding: 8px 16px; border-radius: 8px;
        cursor: pointer; border: 1px solid #dcdcdc; background: #fff; color: #323232;
      }
      .rkb-btn:hover { background: #f4f0fa; border-color: #6b3fa0; color: #6b3fa0; }
      .rkb-btn.rkb-primary { background: #6b3fa0; color: #fff; border-color: #6b3fa0; }
      .rkb-btn.rkb-primary:hover { background: #57327f; color: #fff; }
      .rkb-btn:disabled { opacity: 0.5; cursor: default; }
      .rkb-err { color: #c0392b; font-size: 13px; line-height: 1.7; white-space: pre-wrap; }
      .rkb-report { font-size: 13px; line-height: 1.7; white-space: pre-wrap; background: #f7f9fc; border: 1px solid #dcdcdc; border-radius: 6px; padding: 12px; }
    `;
    root.appendChild(style);

    const fab = document.createElement('button');
    fab.className = 'rkb-fab';
    fab.id = 'rkb-fab';
    fab.textContent = '🔁 繰返し起票';
    fab.addEventListener('click', openForm);
    root.appendChild(fab);

    const overlay = document.createElement('div');
    overlay.className = 'rkb-overlay';
    overlay.id = 'rkb-overlay';
    root.appendChild(overlay);
  }

  function showFab(show) {
    const fab = root && root.getElementById('rkb-fab');
    if (!fab) return;
    if (show) fab.classList.add('rkb-shown'); else fab.classList.remove('rkb-shown');
    fabShown = show;
  }

  function openOverlay(innerHtml) {
    const overlay = root.getElementById('rkb-overlay');
    overlay.innerHTML = `
      <div class="rkb-modal">
        <div class="rkb-mhead">
          <span>🔁 繰返し起票</span>
          <span class="rkb-x" id="rkb-close">×</span>
        </div>
        <div class="rkb-mbody" id="rkb-mbody"></div>
        <div class="rkb-mfoot" id="rkb-mfoot"></div>
      </div>`;
    overlay.classList.add('rkb-shown');
    overlay.querySelector('#rkb-close').addEventListener('click', closeOverlay);
    setBody(innerHtml || '');
  }
  function setBody(html) { const b = root.getElementById('rkb-mbody'); if (b) b.innerHTML = html; }
  function setFoot(html) { const f = root.getElementById('rkb-mfoot'); if (f) f.innerHTML = html; }

  function closeOverlay() {
    const overlay = root.getElementById('rkb-overlay');
    if (overlay) overlay.classList.remove('rkb-shown');
    stopPolling();
    stopElapsed();
  }
  function stopPolling() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }
  function startElapsed() {
    startedAt = Date.now();
    stopElapsed();
    elapsedTimer = setInterval(() => {
      const el = root.getElementById('rkb-elapsed');
      if (el) {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        el.textContent = `経過 ${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
      }
    }, 1000);
  }
  function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }

  function progressView(msg) {
    return `
      <div class="rkb-progress">
        <div class="rkb-spinner"></div>
        <div style="font-size:14px;font-weight:700;margin-bottom:6px;">${esc(msg)}</div>
        <div class="rkb-elapsed" id="rkb-elapsed">経過 0分00秒</div>
        <div class="rkb-note" style="margin-top:14px;">閉じても処理は続くけど、<br>結果を見るにはこのままにしておいてね。</div>
      </div>`;
  }
  function serverDownView() {
    return `<div class="rkb-err">サーバーに繋がらなかったよ。<br>ハタケダッシュボードを起動してね（start-dashboard.vbs / python server.py）。</div>`;
  }

  // ---- 入力フォーム ----
  function openForm() {
    const company = detectCompanyName();
    const v = detectVoucher();
    const typeGuess = v.type || voucherModalType() || 'deal';
    const idGuess = v.id || '';

    openOverlay(`
      <div class="rkb-note">
        毎月同額の伝票（税理士報酬・役員報酬など）を、この伝票を元に月末日付で複製して一括起票するよ。<br>
        <span class="rkb-warn">報酬改定があったら、この機能では追従できないよ（金額はそのまま複製）。改定時は手動で直してね。</span><br>
        ${company ? `対象事業所: <b>${esc(company)}</b>` : '<span class="rkb-err">事業所名を自動取得できなかったよ。安全のため、取れないと登録は止まるよ。</span>'}
      </div>
      <div class="rkb-field">
        <label>伝票の種別</label>
        <div class="rkb-radio">
          <label><input type="radio" name="rkb-type" value="deal" ${typeGuess === 'deal' ? 'checked' : ''}> 取引（deals）</label>
          <label><input type="radio" name="rkb-type" value="manual_journal" ${typeGuess === 'manual_journal' ? 'checked' : ''}> 振替伝票（manual_journals）</label>
        </div>
      </div>
      <div class="rkb-field">
        <label>元にする伝票ID ${v.id ? '（このページから自動取得したよ。違ってたら直してね）' : '（URLから取れなかったから手入力してね）'}</label>
        <input type="text" class="rkb-input" id="rkb-vid" value="${esc(idGuess)}" inputmode="numeric" placeholder="例: 1234567" style="width:200px;">
      </div>
      <div class="rkb-field">
        <label>回数（何ヶ月分）</label>
        <div>
          <span class="rkb-presets" id="rkb-presets">
            <button type="button" class="rkb-chip" data-n="1">1</button>
            <button type="button" class="rkb-chip" data-n="3">3</button>
            <button type="button" class="rkb-chip" data-n="6">6</button>
            <button type="button" class="rkb-chip" data-n="12">12</button>
          </span>
          <input type="number" class="rkb-input" id="rkb-count" value="3" min="1" max="24" style="width:80px;"> 回（最大24）
        </div>
      </div>
      <div class="rkb-field">
        <label>開始月（発生日は毎回その月の月末になるよ）</label>
        <input type="month" class="rkb-month" id="rkb-month" value="${esc(thisMonth())}">
      </div>
    `);
    setFoot(`
      <button class="rkb-btn" id="rkb-cancel">閉じる</button>
      <button class="rkb-btn rkb-primary" id="rkb-preview">プレビュー</button>`);

    root.getElementById('rkb-cancel').addEventListener('click', closeOverlay);
    root.getElementById('rkb-preview').addEventListener('click', onPreviewClick);
    // プリセットチップ
    root.querySelectorAll('#rkb-presets .rkb-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const n = chip.getAttribute('data-n');
        const inp = root.getElementById('rkb-count');
        if (inp) inp.value = n;
        syncChips();
      });
    });
    const countInp = root.getElementById('rkb-count');
    if (countInp) countInp.addEventListener('input', syncChips);
    syncChips();
  }

  function syncChips() {
    const inp = root.getElementById('rkb-count');
    const val = inp ? String(parseInt(inp.value, 10)) : '';
    root.querySelectorAll('#rkb-presets .rkb-chip').forEach((chip) => {
      if (chip.getAttribute('data-n') === val) chip.classList.add('rkb-active');
      else chip.classList.remove('rkb-active');
    });
  }

  // ---- プレビュー（prepare）起動 ----
  function onPreviewClick() {
    const company = detectCompanyName();
    if (!company) {
      window.alert('事業所名が自動取得できなかったよ。誤登録防止のため中止するね。freeeの画面を開き直してみて。');
      return;
    }
    const typeEl = root.querySelector('input[name="rkb-type"]:checked');
    const voucherType = typeEl ? typeEl.value : 'deal';
    const vidRaw = (root.getElementById('rkb-vid') || {}).value || '';
    const voucherId = String(vidRaw).replace(/[^0-9]/g, '');
    if (!voucherId) { window.alert('元にする伝票IDを入力してね（数字）。'); return; }
    const count = parseInt((root.getElementById('rkb-count') || {}).value, 10);
    if (isNaN(count) || count < 1 || count > 24) { window.alert('回数は1〜24で入れてね。'); return; }
    const startMonth = (root.getElementById('rkb-month') || {}).value || '';
    if (!/^\d{4}-\d{2}$/.test(startMonth)) { window.alert('開始月を選んでね。'); return; }

    const v = detectVoucher();
    const payload = {
      company_name: company,
      voucher_type: voucherType,
      voucher_id: voucherId,
      count: count,
      start_month: startMonth,
    };
    if (v.company_id) payload.company_id = v.company_id;

    setBody(progressView(`${company} の元伝票を取得して、${count}件ぶんを組み立て中…`));
    setFoot('');
    startElapsed();

    fetch(PREPARE_URL, { method: 'POST', body: JSON.stringify(payload) })
      .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
      .then((data) => { currentJobId = data.job_id; pollCount = 0; pollStatus('prepare'); })
      .catch((err) => {
        stopElapsed();
        if (err && err.error) setBody(`<div class="rkb-err">エラー: ${esc(err.error)}</div>`);
        else setBody(serverDownView());
        setFoot(`<button class="rkb-btn" id="rkb-back">閉じる</button>`);
        const b = root.getElementById('rkb-back'); if (b) b.addEventListener('click', closeOverlay);
      });
  }

  // ---- ステータスポーリング ----
  function pollStatus(kind) {
    stopPolling();
    pollTimer = setTimeout(() => {
      pollCount++;
      fetch(`${STATUS_URL}?job_id=${encodeURIComponent(currentJobId)}`)
        .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
        .then((data) => {
          if (data.status === 'running') {
            if (pollCount >= POLL_MAX) {
              stopElapsed();
              setBody(`<div class="rkb-err">時間がかかりすぎてるよ。サーバーのログを確認してね。</div>`);
              return;
            }
            pollStatus(kind);
          } else if (data.status === 'done' || data.status === 'partial') {
            stopElapsed();
            if (data.phase === 'prepare') renderPreview(data.preview);
            else renderResult(data);
          } else {
            stopElapsed();
            setBody(`<div class="rkb-err">エラー: ${esc(data.error || '不明なエラー')}</div>`);
            setFoot(`<button class="rkb-btn" id="rkb-back2">閉じる</button>`);
            const b = root.getElementById('rkb-back2'); if (b) b.addEventListener('click', closeOverlay);
          }
        })
        .catch(() => {
          if (pollCount >= POLL_MAX) { stopElapsed(); setBody(serverDownView()); }
          else pollStatus(kind);
        });
    }, POLL_MS);
  }

  // ---- プレビュー表示 ----
  function renderPreview(preview) {
    if (!preview || !Array.isArray(preview.entries) || preview.entries.length === 0) {
      setBody(`<div class="rkb-err">起票する内容が空だったよ。開始月や伝票IDを見直してね。</div>`);
      setFoot(`<button class="rkb-btn" id="rkb-back3">閉じる</button>`);
      const b = root.getElementById('rkb-back3'); if (b) b.addEventListener('click', closeOverlay);
      return;
    }
    lastPreview = preview;

    let truncHtml = '';
    if (preview.truncated) {
      truncHtml = `<div class="rkb-trunc">📅 ${esc(preview.requested_count)}回を指定したけど、決算月（期末 ${esc(preview.fiscal_end)}）までの <b>${esc(preview.generated_count)}回</b> で打ち切ったよ。決算期をまたがないようにしてるよ。</div>`;
    }
    let unsettledHtml = '';
    if (preview.unsettled) {
      unsettledHtml = `<div class="rkb-note">※ 取引（deals）は<b>すべて未決済</b>で作成するよ（相手方の未払金／未収入金はfreeeが自動計上）。決済情報は元伝票からコピーしないよ。</div>`;
    }

    const rows = preview.entries.map((e) => {
      const lines = (e.lines || []).map((ln) => `${esc(ln.side)} ${esc(ln.account)} ${fmtYen(ln.amount)}`).join('<br>');
      const due = e.due_date ? `<div class="rkb-lines">期日: ${esc(e.due_date)}</div>` : '';
      return `
        <tr>
          <td style="white-space:nowrap;">${esc(e.issue_date)}</td>
          <td class="rkb-amt">${fmtYen(e.amount)}</td>
          <td>${esc(e.partner_name || '')}</td>
          <td><div class="rkb-lines">${lines}</div>${due}</td>
        </tr>`;
    }).join('');

    setBody(`
      <div class="rkb-note">
        <b>${esc(preview.company_name || '')}</b> の伝票を、下の内容で <b>${esc(preview.generated_count)}件</b> 起票するよ。<br>
        金額・科目・取引先は元伝票のまま（1円も変えてない）。発生日だけ各月の月末にしてるよ。<br>
        登録の最終判断はけんとさんがやってね。
      </div>
      ${truncHtml}
      ${unsettledHtml}
      <div style="overflow-x:auto;">
        <table class="rkb-tbl">
          <thead><tr><th>発生日</th><th style="text-align:right;">金額</th><th>取引先</th><th>仕訳（借方/貸方）</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="rkb-total">合計 ${preview.generated_count}件 / ${fmtYen(preview.grand_total)} 円</div>`);

    setFoot(`
      <button class="rkb-btn" id="rkb-cancel2">閉じる</button>
      <button class="rkb-btn rkb-primary" id="rkb-register">この内容で登録（${esc(preview.generated_count)}件）</button>`);
    root.getElementById('rkb-cancel2').addEventListener('click', closeOverlay);
    root.getElementById('rkb-register').addEventListener('click', onRegisterClick);
  }

  // ---- 登録（register）起動 ----
  function onRegisterClick() {
    if (!currentJobId) { window.alert('準備からやり直してね。'); return; }
    const reg = root.getElementById('rkb-register');
    if (reg) reg.disabled = true;

    const n = lastPreview ? lastPreview.generated_count : '';
    setBody(progressView(`${n}件を起票中…`));
    setFoot('');
    startElapsed();

    fetch(REGISTER_URL, { method: 'POST', body: JSON.stringify({ job_id: currentJobId }) })
      .then((res) => (res.ok ? res.json() : res.json().then((e) => Promise.reject(e))))
      .then((data) => { currentJobId = data.job_id; pollCount = 0; pollStatus('register'); })
      .catch((err) => {
        stopElapsed();
        if (err && err.error) setBody(`<div class="rkb-err">登録リクエストが拒否されたよ: ${esc(err.error)}</div>`);
        else setBody(serverDownView());
        setFoot(`<button class="rkb-btn" id="rkb-done">閉じる</button>`);
        const d = root.getElementById('rkb-done'); if (d) d.addEventListener('click', closeOverlay);
      });
  }

  // ---- 完了レポート ----
  function renderResult(data) {
    const result = data.result;
    let html = '';
    if (result && Array.isArray(result.created)) {
      const created = result.created;
      const failed = Array.isArray(result.failed) ? result.failed : [];
      const cRows = created.map((c) => `
        <tr><td style="white-space:nowrap;">${esc(c.issue_date || '')}</td><td>ID: ${esc(c.id)}</td></tr>`).join('');
      html = `<div class="rkb-note"><b>${esc(created.length)}件</b> 起票したよ。${failed.length ? `<span class="rkb-err">（${esc(failed.length)}件は失敗）</span>` : ''}</div>`;
      if (created.length) {
        html += `<div style="overflow-x:auto;"><table class="rkb-tbl"><thead><tr><th>発生日</th><th>伝票ID</th></tr></thead><tbody>${cRows}</tbody></table></div>`;
      }
      if (failed.length) {
        const fRows = failed.map((f) => `<tr><td style="white-space:nowrap;">${esc(f.issue_date || '')}</td><td class="rkb-err">${esc(f.error || '')}</td></tr>`).join('');
        html += `<div class="rkb-note" style="margin-top:10px;">失敗した分（手動で確認してね。成功分は登録済み）:</div>
          <div style="overflow-x:auto;"><table class="rkb-tbl"><thead><tr><th>発生日</th><th>エラー</th></tr></thead><tbody>${fRows}</tbody></table></div>`;
      }
    } else {
      // 結果JSONが取れなかった場合はテキストレポートを出す
      html = `<div class="rkb-note">起票が完了したよ。内容を確認してね。</div>
        <div class="rkb-report">${esc(data.report || '（レポートなし）')}</div>`;
    }
    setBody(html);
    setFoot(`<button class="rkb-btn rkb-primary" id="rkb-done2">閉じる</button>`);
    const d = root.getElementById('rkb-done2'); if (d) d.addEventListener('click', closeOverlay);
  }

  // ---- 可視性監視（SPAのURL変化・モーダル開閉に追従）----
  function tick() {
    if (!root) return;
    const should = isVoucherPage() || voucherModalType() !== null;
    if (should !== fabShown) showFab(should);
  }

  function init() {
    buildHost();
    watchVoucherApi();
    setInterval(tick, 1000);
    tick();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
