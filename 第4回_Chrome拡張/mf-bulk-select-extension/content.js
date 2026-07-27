// MF会計「連携サービスから入力」ルール一致一括選択
// 対応ページ:
//   /transaction_journals  … 通帳・カード他（明細単位・行チェックボックス）
//   /journalable_dists     … ビジネスカテゴリ（ユビレジ等・日次単位・仕訳グループごとのチェックボックス)
// 白（ルール一致で科目が入っている）だけが選択された状態を作る。
// 青（MF推定＝勘定科目ボタン内に雲アイコンimg）と科目未選択は除外。
// 登録自体はユーザーが「一括登録」ボタンを押す。この拡張は選択までしかしない。
//
// 実装メモ:
// - transaction_journals: 1行ずつチェックすると1クリック≒1秒（React再レンダリング）かかるため、
//   ヘッダーの全選択(1クリック)→除外行だけ解除、の方式でクリック数を最小化している。
// - journalable_dists: チェックボックスは仕訳グループ（日次）ごとに1個・最大50個程度なので、
//   対象グループだけを個別にチェックする（「一括選択」リンクのトグル挙動には依存しない）。
//   「自動仕訳ルールとして保存」「適格」のチェックボックスには絶対に触らない
//   （行選択はテーブル内の recognizedAtHeading 配下だけを使う）。
// - バックグラウンドタブではsetTimeoutが分単位に間引かれるため、待機は全て
//   MessageChannelベースのyieldTask + performance.now()デッドラインで行う。
// - 「続きを表示」直後はReactの行更新コミットが遅れて届き、選択状態を丸ごと
//   上書きすることがある（全解除に見える）。行数が落ち着くまで待ち、さらに
//   完了後に実測で検証して、リセットされていたら1回だけ自動リトライする。
// - 展開中の振替行（チェックボックスdisabled）は全選択に巻き込まれても解除できないため、
//   警告表示に留める（勝手に「閉じる」は押さない）。
(() => {
  'use strict';

  const BAR_ID = 'mf-rule-select-bar';
  const PAGE = location.pathname.includes('journalable_dists') ? 'dists' : 'journals';

  // バックグラウンドタブでもタイマー制限を受けずにイベントループへ譲るyield
  const yieldTask = () =>
    new Promise((r) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => r();
      ch.port2.postMessage(0);
    });

  function setStatus(text) {
    const el = document.getElementById(BAR_ID + '-status');
    if (el) el.textContent = text;
  }

  // ---- transaction_journals（明細単位） ----

  const rowCheckbox = (tr) =>
    tr.querySelector('td[class*="colCheckbox"] input[type="checkbox"]');

  const headerCheckbox = () =>
    document.querySelector('table thead [class*="colCheckbox"] input[type="checkbox"]');

  // 行の分類: target(白・ルール一致) / estimated(青・MF推定) / unselected(科目未選択) / expanded(展開中でdisabled)
  function classify(tr) {
    const cb = rowCheckbox(tr);
    if (!cb) return 'no-checkbox';
    if (cb.disabled) return 'expanded';
    const btn = tr.querySelector('td[class*="colLedgerAccount"] button');
    if (!btn) return 'no-account';
    if (btn.querySelector('img')) return 'estimated'; // 雲アイコン = MF推定
    if (/isUnselected|isInvalid/.test(btn.className)) return 'unselected';
    const t = btn.textContent.trim();
    if (!t || t === '未選択') return 'unselected';
    return 'target';
  }

  function allRows() {
    return [...document.querySelectorAll('table tbody tr')];
  }

  // ---- journalable_dists（日次・仕訳グループ単位） ----

  function distTables() {
    return [...document.querySelectorAll('table[class*="journalableDistJournalBody"]')];
  }

  const distCheckbox = (t) =>
    t.querySelector('[class*="recognizedAtHeading"] input[type="checkbox"]');

  // 仕訳グループの分類（テーブル内の勘定科目ボタンで判定）
  // 各itemAndSubItemセルは [勘定科目ボタン, 補助科目ボタン] の並び。
  // 「補助科目なし」ボタンにはisUnselectedクラスが付くが正常な状態なので、
  // 判定には各セルの1個目（勘定科目）だけを使う。
  function classifyTable(t) {
    const cb = distCheckbox(t);
    if (!cb) return 'no-checkbox';
    if (cb.disabled) return 'expanded';
    const btns = [...t.querySelectorAll('td[class*="itemAndSubItem"]')]
      .map((td) => td.querySelector('button'))
      .filter(Boolean);
    if (!btns.length) return 'no-account';
    if (btns.some((b) => b.querySelector('img'))) return 'estimated';
    if (btns.some((b) => /isUnselected|isInvalid/.test(b.className))) return 'unselected';
    return 'target';
  }

  // ---- 共通: 待機・実測 ----

  // 選択状態の実測（enabled=有効チェック数 / blue=そのうちMF推定 / stuck=disabledのままチェック済み）
  function countChecked() {
    let enabled = 0, blue = 0, stuck = 0;
    if (PAGE === 'dists') {
      for (const t of distTables()) {
        const cb = distCheckbox(t);
        if (!cb || !cb.checked) continue;
        if (cb.disabled) { stuck++; continue; }
        enabled++;
        if (classifyTable(t) === 'estimated') blue++;
      }
    } else {
      for (const tr of allRows()) {
        const cb = rowCheckbox(tr);
        if (!cb || !cb.checked) continue;
        if (cb.disabled) { stuck++; continue; }
        enabled++;
        if (classify(tr) === 'estimated') blue++;
      }
    }
    return { enabled, blue, stuck };
  }

  // 行数がsettleMsの間変化しなくなるまで待つ（Reactの遅延コミット対策）
  async function waitForRowsSettled(settleMs = 1500, timeoutMs = 15000) {
    const t0 = performance.now();
    let last = allRows().length;
    let lastChange = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      await yieldTask();
      const n = allRows().length;
      if (n !== last) {
        last = n;
        lastChange = performance.now();
      }
      if (performance.now() - lastChange >= settleMs) return;
    }
  }

  // 「続きを表示」を全部読み込み、行更新が落ち着くまで待つ
  async function loadAllPages() {
    for (let i = 0; i < 100; i++) {
      const more = [...document.querySelectorAll('button, a')].find(
        (e) => e.offsetParent !== null && e.textContent.trim() === '続きを表示'
      );
      if (!more) break;
      const before = allRows().length;
      more.click();
      setStatus(`読み込み中… ${before}件`);
      const deadline = performance.now() + 10000;
      while (allRows().length === before && performance.now() < deadline) {
        await yieldTask();
      }
      if (allRows().length === before) break;
    }
    setStatus('読み込み完了を待っています…');
    await waitForRowsSettled();
  }

  // ---- 選択処理 ----

  // transaction_journals: 全選択→除外解除を1回実行。分類の集計を返す
  async function runSelectionJournals() {
    // ヘッダーは毎回取り直す（再レンダリングでstaleになるため）
    const headCb = headerCheckbox();
    if (!headCb) throw new Error('全選択チェックボックスが見つかりません');
    setStatus('全選択中…');
    await yieldTask();
    if (!headCb.checked) headCb.click();

    const rows = allRows();
    const counts = { target: 0, estimated: 0, unselected: 0, expanded: 0 };
    const toUncheck = [];
    for (const tr of rows) {
      const c = classify(tr);
      if (counts[c] !== undefined) counts[c]++;
      if (c === 'estimated' || c === 'unselected') {
        const cb = rowCheckbox(tr);
        if (cb && cb.checked && !cb.disabled) toUncheck.push(cb);
      }
    }
    let done = 0;
    for (const cb of toUncheck) {
      cb.click(); // 1クリック≒1秒かかる（React再レンダリング）
      done++;
      setStatus(`推定行を除外中… ${done}/${toUncheck.length}`);
      await yieldTask(); // ステータス表示を描画させる
    }
    return counts;
  }

  // journalable_dists: 対象グループのチェックボックスだけを個別にON
  async function runSelectionDists() {
    const tables = distTables();
    const counts = { target: 0, estimated: 0, unselected: 0, expanded: 0 };
    const toCheck = [];
    for (const t of tables) {
      const c = classifyTable(t);
      if (counts[c] !== undefined) counts[c]++;
      if (c === 'target') {
        const cb = distCheckbox(t);
        if (cb && !cb.checked) toCheck.push(cb);
      }
    }
    let done = 0;
    for (const cb of toCheck) {
      cb.click();
      done++;
      setStatus(`選択中… ${done}/${toCheck.length}`);
      await yieldTask();
    }
    return counts;
  }

  async function selectRuleMatched() {
    const btn = document.getElementById(BAR_ID + '-select');
    btn.disabled = true;
    try {
      await loadAllPages();

      let counts = null;
      let actual = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        counts = PAGE === 'dists' ? await runSelectionDists() : await runSelectionJournals();
        // 選択コミットの遅延を待ってから実測で検証
        await waitForRowsSettled(1000, 8000);
        actual = countChecked();
        const ok = actual.blue === 0 && (counts.target === 0 || actual.enabled > 0);
        if (ok) break;
        setStatus(`選択がリセットされたため再試行します… (${attempt}/2)`);
      }

      // 結果表示は実測ベース
      const unit = PAGE === 'dists' ? '仕訳' : '明細';
      const skipped = [];
      if (counts.estimated) skipped.push(`MF推定${counts.estimated}件`);
      if (counts.unselected) skipped.push(`科目未選択${counts.unselected}件`);
      let msg = `✅ ${unit}${actual.enabled}件を選択${skipped.length ? '（除外: ' + skipped.join('・') + '）' : ''}`;
      if (actual.blue > 0) {
        msg = `⚠️ MF推定${actual.blue}件が選択に残っています。「解除」してやり直してください`;
      } else if (counts.target > 0 && actual.enabled === 0) {
        msg = '⚠️ 選択がページ更新でリセットされました。もう一度ボタンを押してください';
      } else if (counts.target === 0) {
        msg = `選択できる${unit}がありません${skipped.length ? '（' + skipped.join('・') + '）' : ''}`;
      } else if (actual.stuck) {
        // 展開中の行は解除できず選択に残るため警告
        msg += ` ⚠️ 展開中の行${actual.stuck}件も選択に含まれています。外したい場合は行の「閉じる」を押してからやり直してください。`;
      } else {
        msg += ' → 内容確認して「一括登録」を押してください';
      }
      setStatus(msg);
    } catch (e) {
      setStatus('⚠️ エラー: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function deselectAll() {
    if (PAGE === 'dists') {
      // グループごとのチェックを個別にOFF（他のチェックボックスには触らない）
      const checked = distTables()
        .map(distCheckbox)
        .filter((c) => c && c.checked && !c.disabled);
      let done = 0;
      for (const cb of checked) {
        cb.click();
        done++;
        setStatus(`解除中… ${done}/${checked.length}`);
        await yieldTask();
      }
      setStatus('チェックを解除しました');
      return;
    }
    // ヘッダーのトグルで一括解除（部分選択→全選択→全解除の順になることがあるため最大3回）
    for (let i = 0; i < 3; i++) {
      const headCb = headerCheckbox();
      if (!headCb) return;
      const anyChecked = allRows().some((tr) => rowCheckbox(tr)?.checked);
      if (!anyChecked) break;
      setStatus('解除中…');
      await yieldTask();
      headCb.click();
      await waitForRowsSettled(500, 5000);
    }
    setStatus('チェックを解除しました');
  }

  function injectBar() {
    if (document.getElementById(BAR_ID)) return;
    // 「一括登録」ボタンの近くに置く
    const bulkBtn = [...document.querySelectorAll('button, input[type="submit"], a')].find(
      (e) => (e.textContent || e.value || '').trim() === '一括登録'
    );
    const bar = document.createElement('span');
    bar.id = BAR_ID;
    bar.style.cssText = 'display:inline-flex;align-items:center;gap:8px;margin-left:16px;font-size:13px;max-width:720px;';

    const selectBtn = document.createElement('button');
    selectBtn.id = BAR_ID + '-select';
    selectBtn.type = 'button';
    selectBtn.textContent = '⚡ ルール一致を全選択';
    selectBtn.style.cssText =
      'padding:4px 12px;border:1px solid #2c67c8;border-radius:4px;background:#fff;color:#2c67c8;cursor:pointer;font-weight:bold;white-space:nowrap;';
    selectBtn.addEventListener('click', selectRuleMatched);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = '解除';
    clearBtn.style.cssText =
      'padding:4px 10px;border:1px solid #999;border-radius:4px;background:#fff;color:#555;cursor:pointer;white-space:nowrap;';
    clearBtn.addEventListener('click', deselectAll);

    const status = document.createElement('span');
    status.id = BAR_ID + '-status';
    status.style.cssText = 'color:#2c67c8;line-height:1.3;';

    bar.append(selectBtn, clearBtn, status);

    if (bulkBtn && bulkBtn.parentElement) {
      bulkBtn.parentElement.appendChild(bar);
    } else {
      // フォールバック: 画面右上に固定表示
      bar.style.cssText +=
        'position:fixed;top:60px;right:20px;z-index:9999;background:#fff;padding:8px 12px;border:1px solid #ccc;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);';
      document.body.appendChild(bar);
    }
  }

  // Reactの再レンダリングでバーが消えたら差し直す
  const observer = new MutationObserver(() => {
    if (!document.getElementById(BAR_ID)) injectBar();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  injectBar();
})();
