// ==UserScript==
// @name         顧客管理カレンダー：freee事業所 自動切替
// @namespace    https://github.com/fromk0326-boop/haifuyou
// @version      1.0.0
// @description  カレンダーのfreeeボタンから cm.secure.freee.co.jp を開いたとき、URLの target_client_id を読んで該当顧問先へ自動で切り替える（freee認定アドバイザー向け）
// @match        https://cm.secure.freee.co.jp/clients*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // カレンダーのボタンが付けてくる目印。無ければ何もしない（普通に開いただけのとき）
  const targetId = new URLSearchParams(location.search).get('target_client_id');
  if (!targetId) return;

  // 作戦1: 顧問先管理画面の切替APIを直接呼ぶ → 成功したらfreee本体へ移動
  async function switchByApi() {
    const csrf = document.querySelector('meta[name="csrf-token"]');
    const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
    if (csrf) headers['X-CSRF-Token'] = csrf.content;
    // リクエストの形式が画面更新で変わることがあるため、2パターン試す
    for (const body of [{ client_company_id: targetId }, { id: targetId }]) {
      try {
        const res = await fetch('/api/p/client_companies/switch', {
          method: 'POST',
          headers,
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (res.ok) return true;
      } catch (e) {
        // 失敗したら次のパターン、それもだめなら作戦2へ
      }
    }
    return false;
  }

  // 作戦2: 顧問先一覧の中から該当顧問先へのリンクを探してクリックする
  function switchByClick() {
    const link = Array.from(document.querySelectorAll('a')).find(
      (a) => (a.getAttribute('href') || '').includes(targetId)
    );
    if (link) {
      link.click();
      return true;
    }
    return false;
  }

  (async () => {
    if (await switchByApi()) {
      location.href = 'https://secure.freee.co.jp/';
      return;
    }
    // 一覧の読み込みを待ちながら15秒までリンクを探す。見つからなければ手動で選ぶ
    const deadline = Date.now() + 15000;
    const timer = setInterval(() => {
      if (switchByClick() || Date.now() > deadline) clearInterval(timer);
    }, 500);
  })();
})();
