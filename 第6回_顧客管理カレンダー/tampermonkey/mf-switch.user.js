// ==UserScript==
// @name         顧客管理カレンダー：MF会計 事業者自動切替
// @namespace    https://github.com/fromk0326-boop/haifuyou
// @version      1.0.0
// @description  カレンダーのMFボタンから accounting.moneyforward.com/offices を開いたとき、URLの target_cti を読んで該当事業者の切替リンクを自動クリックする
// @match        https://accounting.moneyforward.com/offices*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // カレンダーのボタンが付けてくる目印。無ければ何もしない（普通に開いただけのとき）
  const targetCti = new URLSearchParams(location.search).get('target_cti');
  if (!targetCti) return;

  // 事業者一覧の切替リンク（hrefにctiが入っている）を探してクリックする
  function clickSwitchLink() {
    const link = Array.from(document.querySelectorAll('a')).find(
      (a) => (a.getAttribute('href') || '').includes(targetCti)
    );
    if (link) {
      link.click();
      return true;
    }
    return false;
  }

  // 一覧の読み込みを待ちながら15秒までリンクを探す。見つからなければ手動で選ぶ
  if (clickSwitchLink()) return;
  const deadline = Date.now() + 15000;
  const timer = setInterval(() => {
    if (clickSwitchLink() || Date.now() > deadline) clearInterval(timer);
  }, 500);
})();
