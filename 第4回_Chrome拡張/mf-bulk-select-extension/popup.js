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

const listEl = document.getElementById('list');
const savedEl = document.getElementById('saved');

chrome.storage.local.get(['mfkbKamoku'], (data) => {
  const list = Array.isArray(data.mfkbKamoku) && data.mfkbKamoku.length
    ? data.mfkbKamoku
    : DEFAULT_KAMOKU;
  listEl.value = list.join('\n');
});

document.getElementById('save').addEventListener('click', () => {
  const list = listEl.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (!list.length) {
    savedEl.textContent = '1件以上入力してね';
    return;
  }
  chrome.storage.local.set({ mfkbKamoku: list }, () => {
    savedEl.textContent = '保存したよ！';
    setTimeout(() => (savedEl.textContent = ''), 1500);
  });
});
