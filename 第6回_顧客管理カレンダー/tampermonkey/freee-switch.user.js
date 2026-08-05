// ==UserScript==
// @name         顧客管理カレンダー：freee事業所 自動切替
// @namespace    https://github.com/fromk0326-boop/haifuyou
// @version      1.1
// @description  カレンダーのfreeeボタンから cm.secure.freee.co.jp を開いたとき、URLの target_client_id を読んで該当顧問先へ自動で切り替える（freee認定アドバイザー向け）
// @match        https://cm.secure.freee.co.jp/clients*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function() {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const targetId = params.get('target_client_id');
  if (!targetId) return;

  console.log('[freee] 切替開始:', targetId);

  // CSRFトークンを取得（metaタグ優先、なければXSRF-TOKENクッキー）
  const csrfMeta = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
  const xsrfCookie = document.cookie.split(';')
    .find(c => c.trim().startsWith('XSRF-TOKEN='))?.split('=').slice(1).join('=') || '';
  const xsrfToken = decodeURIComponent(xsrfCookie);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/p/client_companies/switch', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
  if (csrfMeta) xhr.setRequestHeader('X-CSRF-Token', csrfMeta);
  if (xsrfToken) xhr.setRequestHeader('X-XSRF-TOKEN', xsrfToken);

  xhr.onload = function() {
    console.log('[freee] status:', xhr.status);
    if (xhr.status >= 200 && xhr.status < 300) {
      window.location.href = 'https://secure.freee.co.jp/';
    } else {
      console.log('[freee] 失敗:', xhr.responseText);
    }
  };
  xhr.send(JSON.stringify({ id: targetId }));
})();
