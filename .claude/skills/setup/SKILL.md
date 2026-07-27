---
name: setup
description: >-
  freeeオート経理体験キットの初期セットアップを一歩ずつ案内するスキル。
  「セットアップして」「準備を手伝って」「初期設定」「はじめかた」「認証がうまくいかない」
  「.envの作り方」「freeeと接続したい」などのリクエストで発動する。
---

# 初期セットアップの案内

受講生のPCで、キットが動く状態までを一歩ずつ案内します。
**一度に全部やらせず、1ステップ完了を確認してから次へ進んでください。**

## 手順

### 1. Pythonの確認

```
python --version
```

を実行してもらい、3.10以上ならOK。表示されない・エラーになる場合は README「1. Pythonを用意する」のインストール手順を案内する（「Add python.exe to PATH」のチェックが最重要）。

### 2. 部品のインストール

キットの一番上のフォルダを作業場所にして実行する：

```
pip install -r requirements.txt
```

エラーが出たら、エラー文を貼ってもらい対処する。

### 3. .env の作成

```
copy .env.example .env
```

（Macは `cp`）でキット直下のひな形から `.env` を作り、4項目（ANTHROPIC_API_KEY / FREEE_CLIENT_ID / FREEE_CLIENT_SECRET / FREEE_COMPANY_ID）を**受講生自身にメモ帳等で記入してもらう**。

- **重要**: `.env` の中身をチャットに貼らせない・自分で読まない・表示しない
- 取得場所が分からない場合は README の表（準備3）を参照してもらう

### 4. コールバックURLの登録

freeeアプリ管理画面のコールバックURLに次を**完全一致**で登録してもらう：

```
http://127.0.0.1:8088/callback
```

### 5. freee認証

```
python .claude/skills/setup/freee_auth.py
```

ブラウザが開くので、freeeにログインして「許可する」を押してもらう。キット直下に `token.json` ができれば成功。

事業所IDが不明な場合は認証後に：

```
python .claude/skills/setup/freee_auth.py --companies
```

### 6. 動作確認

```
python .claude/skills/jido-kicho/auto_keiri.py --limit 1
```

明細が1件表示されればセットアップ完了。「体験①に進みましょう」と案内する。

## 注意

- 各ステップで失敗したら、先に進まず原因を解消してから次へ
- 秘密情報（APIキー・token.json）は読まない・表示しない
