// ==UserScript==
// @name         顧客管理カレンダー：MF会計 事業者自動切替
// @namespace    https://github.com/fromk0326-boop/haifuyou
// @version      1.4
// @description  カレンダーのMFボタンから accounting.moneyforward.com/offices を開いたとき、URLの target_cti を読んで該当事業者の切替リンクを自動クリックする
// @match        https://accounting.moneyforward.com/offices*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const targetCti = params.get('target_cti');
  if (!targetCti) return;

  window.confirm = () => true;

  function tryClick() {
    // data-method="patch" が正しいセレクター（putではない）
    const links = document.querySelectorAll('a[data-method="patch"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (href.includes('tid=' + targetCti)) {
        console.log('[MF] 切替実行:', link.textContent.trim());
        link.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
        observer.disconnect();
        return true;
      }
    }
    return false;
  }

  const observer = new MutationObserver(() => {
    tryClick();
  });

  observer.observe(document.documentElement, {childList: true, subtree: true});

  // ページロード後にも一度試みる
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryClick);
  } else {
    tryClick();
  }

  setTimeout(() => {
    observer.disconnect();
    console.log('[MF] タイムアウト');
  }, 10000);
})();
