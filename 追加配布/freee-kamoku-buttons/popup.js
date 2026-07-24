// freee勘定科目ボタン - popup script
(function () {
  'use strict';

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

  const MAX_ACCOUNTS = 10;

  const textarea = document.getElementById('fkb-textarea');
  const saveBtn = document.getElementById('fkb-save');
  const statusEl = document.getElementById('fkb-status');
  const errorEl = document.getElementById('fkb-error');

  function loadAccounts() {
    chrome.storage.sync.get(
      { accounts: DEFAULT_ACCOUNTS },
      (result) => {
        const accounts = (result.accounts && result.accounts.length > 0)
          ? result.accounts
          : DEFAULT_ACCOUNTS;
        textarea.value = accounts.join('\n');
      }
    );
  }

  function parseTextarea() {
    return textarea.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  function showStatus(message) {
    statusEl.textContent = message;
    setTimeout(() => {
      statusEl.textContent = '';
    }, 2000);
  }

  function showError(message) {
    errorEl.textContent = message;
  }

  saveBtn.addEventListener('click', () => {
    errorEl.textContent = '';
    const accounts = parseTextarea();

    if (accounts.length > MAX_ACCOUNTS) {
      showError(`科目は最大${MAX_ACCOUNTS}件までだよ（現在${accounts.length}件）`);
      return;
    }

    if (accounts.length === 0) {
      showError('科目を1件以上入力してね');
      return;
    }

    chrome.storage.sync.set({ accounts }, () => {
      showStatus('保存したよ！');
    });
  });

  loadAccounts();
})();
