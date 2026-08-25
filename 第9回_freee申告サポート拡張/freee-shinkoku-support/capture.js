/*
 * freee申告サポートボタン - APIキャプチャ（MAINワールド）
 * ページ自身が行う fetch / XMLHttpRequest のJSONレスポンスを観測し、
 * window.postMessage で content.js（ISOLATEDワールド）へ渡す。
 * 外部への送信は一切しない。観測のみで、リクエスト自体には手を加えない。
 */
(function () {
  'use strict';

  var SOURCE = 'freee-shinkoku-support';
  var MAX_BODY = 300000; // 1レスポンスあたりの保持上限（文字数）

  function post(entry) {
    try {
      window.postMessage({ source: SOURCE, type: 'capture', entry: entry }, window.location.origin);
    } catch (e) { /* 送れないレスポンスは黙って捨てる */ }
  }

  function shouldCapture(url) {
    if (typeof url !== 'string') return false;
    // freee系ドメインへのAPI呼び出しだけを対象にする
    return url.indexOf('freee.co.jp') !== -1 || url.charAt(0) === '/';
  }

  function makeEntry(method, url, status, contentType, bodyText) {
    var truncated = false;
    var body = bodyText || '';
    if (body.length > MAX_BODY) {
      body = body.slice(0, MAX_BODY);
      truncated = true;
    }
    return {
      method: (method || 'GET').toUpperCase(),
      url: url,
      status: status,
      contentType: contentType || '',
      body: body,
      truncated: truncated,
      at: new Date().toISOString()
    };
  }

  /* ---- fetch ---- */
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var promise = origFetch.apply(this, arguments);
      if (shouldCapture(url)) {
        promise.then(function (res) {
          try {
            var ct = res.headers.get('content-type') || '';
            if (ct.indexOf('json') === -1) return;
            res.clone().text().then(function (text) {
              post(makeEntry(method, url, res.status, ct, text));
            }).catch(function () {});
          } catch (e) { /* 観測失敗は無視 */ }
        }).catch(function () {});
      }
      return promise;
    };
  }

  /* ---- XMLHttpRequest ---- */
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__fss_method = method;
    this.__fss_url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (shouldCapture(xhr.__fss_url)) {
      xhr.addEventListener('load', function () {
        try {
          var ct = xhr.getResponseHeader('content-type') || '';
          if (ct.indexOf('json') === -1) return;
          if (xhr.responseType && xhr.responseType !== 'text') return;
          post(makeEntry(xhr.__fss_method, xhr.__fss_url, xhr.status, ct, xhr.responseText));
        } catch (e) { /* 観測失敗は無視 */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
