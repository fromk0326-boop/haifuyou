# 第6回 顧客管理カレンダー

税理士事務所向けの顧客管理ツールです。年間の申告スケジュールを1画面で見渡し、各顧問先の freee / マネーフォワード会計・e-Tax・eLTAX をボタン1つで開けます。

畠山税理士事務所で実際に使っているものから、顧問先データを抜いた「箱」だけを配布しています。サンプル3社入り。自分の顧問先データを入れて使ってください。

## できること

| 機能 | 内容 |
|------|------|
| 年間カレンダー | 決算期・申告・予定納税・源泉納付・年末調整を12ヶ月マトリクスで表示 |
| タスク管理 | セルクリックで 未着手 → 完了 の切り替え。スポットタスクの追加も可能 |
| 会計ソフト直行 | freee / マネーフォワード会計の該当事業所をボタン1つで開く（Tampermonkey併用で事業所の切り替えまで自動） |
| e-Tax / eLTAX | ボタン1つで自動ログイン（ブラウザが起動してID・暗証番号を入力） |
| チャット直リンク | 顧問先ごとの連絡チャンネル（Slack・Chatwork等）を記憶してワンクリックで開く |
| Notion同期（任意） | Notionの顧問先DBから顧問先データを自動生成 |

## 動かし方（2ステップ）

Pythonが必要です（キット一番上の `README.md`「共通の準備」参照）。キットの一番上のフォルダで、次を実行します。

```
python 第6回_顧客管理カレンダー/server.py
```

ブラウザで http://localhost:3460 を開いて、サンプル3社（サンプル商事・デモテック・見本一郎）が表示されれば成功です。

Claude Codeに「第6回の顧客管理カレンダーを起動して」と頼んでもOKです。

## 自分の顧問先を入れる

初回起動時に、サンプルから `data.json` が自動で作られます。データの本体はこの `data.json` です。Claude Codeにこう頼むのが早いです。

```
第6回_顧客管理カレンダー/data.json のサンプル3社を消して、うちの顧問先を入れてください。
顧問先リストを貼ります: （社名・決算月・freee/MFの別 を貼り付け）
決算月から申告・予定納税・源泉・年末調整のタスクも、サンプルと同じルールで作ってください。
```

手で書く場合の1社分の形は `data.sample.json` を参照してください。決算月（fiscal_month）を入れると、カレンダーの並び順と申告期限の表示が決まります。

> **安心ポイント**: `data.json`・タスクの完了状態・チャットURLはgit管理外です。教材の更新を取り込んでも、自分が入れたデータは書き換わりません。逆に言うと**リポジトリには保存されない**ので、PCの買い替え時などは `data.json` を自分でコピーしてください。

## ボタンの設定

### freee ボタン

`index.html` 内の `FREEE_CM_IDS`（認定アドバイザーの顧問先直リンク）または `FREEE_COMPANY_IDS` に、顧問先UUIDとfreee側IDの対応を書きます。書き方の例はコード内のコメントにあります。未設定でも freee のトップは開きます。

### マネーフォワード ボタン

`index.html` 内の `MF_CTI_MAP` に cti（事業者切替トークン）を書きます。cti は `accounting.moneyforward.com/offices` の切替リンクのURLから取れます。

### 事業所まで自動で切り替える（Tampermonkey・任意）

上の設定だけだと、freee / MF のボタンで開くのは「事業所を選ぶ一覧ページ」までで、最後の切り替えクリックは手動です。ここを自動化するのが Tampermonkey（タンパーモンキー）という無料のChrome拡張です。

仕組み：カレンダーのボタンは、URLに「どの顧問先を開きたいか」の目印（freeeは `target_client_id`、MFは `target_cti`）を付けて一覧ページを開くだけです。Tampermonkeyに登録したスクリプトがその目印を読み取って、該当事業所への切り替えを代行します。目印を読むのはこのスクリプトだけなので、入れなくても壊れることはありません（手動で選ぶだけ）。

#### 1. Tampermonkey を入れる（取得方法）

1. Chromeウェブストアで「Tampermonkey」を検索して「Chromeに追加」を押します。直リンク: https://chromewebstore.google.com/detail/dhdgffkkebhmkfjojejmpbldmpobfkfo
2. アドレスバーに `chrome://extensions` と入力して拡張機能の画面を開き、右上の「デベロッパーモード」をオンにします（最近のChromeは、これをオンにしないとスクリプトが動きません）
3. Edgeの方も同じ流れで使えます（EdgeアドオンストアにもTampermonkeyがあります）

#### 2. スクリプトを登録する（設定方法）

このフォルダの `tampermonkey/` に2本入っています。使う会計ソフトの分だけ登録すればOKです。

| ファイル | 対象 | はたらき |
|---------|------|---------|
| `tampermonkey/freee-switch.user.js` | freee（認定アドバイザー向け） | `cm.secure.freee.co.jp` で該当顧問先へ自動切替 → freee本体を開く |
| `tampermonkey/mf-switch.user.js` | MF会計 | `/offices` で該当事業者の切替リンクを自動クリック |

登録は2本とも同じ手順です。

1. ブラウザ右上のTampermonkeyアイコン →「ダッシュボード」を開きます
2. 「＋」タブ（新規スクリプトを作成）を押します
3. もとから入っているひな形を全部消して、上の `.user.js` ファイルの中身を丸ごと貼り付けます（ファイルはメモ帳で開くか、Claude Codeに「中身を表示して」と頼んでコピー）
4. `Ctrl + S`（Macは `Cmd + S`）で保存します

#### 3. 動作確認と前提

カレンダーの freee / MF ボタンを押して、該当事業所の画面まで自動で進めば成功です。

- freeeの自動切替は、freee認定アドバイザーの顧問先管理画面（`cm.secure.freee.co.jp`）を使っていて、`FREEE_CM_IDS` を設定済みの場合に働きます。未設定の顧問先は今までどおりfreeeトップが開きます
- MFの自動切替は `MF_CTI_MAP` の設定が前提です
- freee / MF の画面の作りが変わると動かなくなることがあります。その場合はスクリプトをClaude Codeに見せて「動かなくなったので直して」と頼んでください

### Googleカレンダー サイドバー

画面右のサイドバーに自分のGoogleカレンダーを表示できます。`index.html` 内の `YOUR_CALENDAR_ID%40gmail.com` を自分のカレンダーID（通常はGmailアドレスの `@` を `%40` にしたもの）に差し替えてください。使わない場合は × で閉じられます。

### e-Tax / eLTAX ボタン

1. `pip install playwright` のあと `playwright install chromium`（Claude Codeに頼めば実行してくれます）
2. 一覧で顧問先の行にカーソルを乗せると出る「+e-Tax」「+eLTAX」ボタンから利用者識別番号 / eLTAX IDを登録
3. 暗証番号も自動入力したい場合は `tax-credentials.sample.json` をコピーして、同じフォルダに `tax-credentials.json` を作って記入

暗証番号を書かなくても、ID入力済みのログイン画面が開くところまでは自動化されます。

**注意: `tax-credentials.json` は暗証番号そのものです。git管理外に設定済みですが、Claude Codeにも「中身は読まない・表示しない」を徹底させてください。**

## Notion同期（任意・上級者向け）

顧問先台帳をNotionで管理している場合、`generate.py` で data.json と顧問先別の詳細ページ（clients/*.html）を自動生成できます。

1. `.env.example` をコピーして、**このフォルダの中に** `.env` を作り、`NOTION_TOKEN` と `NOTION_DB_ID` を記入（キット一番上の第3回用 `.env` とは別ファイルです）
2. 画面右上の「🔄 Notion同期」ボタン、または `python generate.py`

`generate.py` は畠山事務所のNotion DBのプロパティ名（略称・正式・決算 など）を前提にしています。自分のDBに合わせる調整は、generate.py をClaudeに読ませて「うちのDBのプロパティ名に合わせて直して」と頼めばOKです。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `index.html` | 画面本体（1ファイル完結） |
| `server.py` | ローカルサーバー（配信・保存・ログイン起動） |
| `data.sample.json` | サンプルデータ（初回起動時に data.json のもとになる） |
| `data.json` | 自分の顧問先データ（初回起動時に自動作成。git管理外） |
| `calendar-tasks.json` / `chat-urls.json` | タスク状態・チャットURLの保存先（自動作成。git管理外） |
| `generate.py` | Notion同期（任意） |
| `etax_login.py` / `eltax_login.py` | e-Tax / eLTAX 自動ログイン（Playwright使用） |
| `tampermonkey/*.user.js` | freee / MF会計の事業所自動切替スクリプト（任意。Tampermonkeyに登録して使う） |
| `tax-credentials.sample.json` | 暗証番号ファイルのひな形 |
| `.env.example` | Notion同期の設定ひな形 |

## 免責

自動ログインは e-Tax / eLTAX の画面変更で動かなくなることがあります。その場合はエラーログ（このフォルダの `temp/` 内）をClaude Codeに見せて直してもらってください。税務判断を伴う機能はありません。
