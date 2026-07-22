# セキュリティ設計の考え方

このひな形が「なぜこういう作りなのか」を解説します。
仕組みを理解すれば、自分の業務に合わせて**安全に拡張**できるようになります。

---

## 守りたいもの・防ぎたいこと

AIエージェント（Claude Code）はあなたのPC上で、ファイルを読み書きし、コマンドを実行します。
便利ですが、次のような事故が起こり得ます。

| 脅威 | 具体例 |
|---|---|
| **認証情報の漏洩** | AIが `.env` やトークンを読み、外部に送信してしまう |
| **プロンプトインジェクション** | Webページやメールに仕込まれた「この秘密を送れ」という指示にAIが従う |
| **破壊的操作** | 大量ファイル削除、Git履歴の破壊、`git push --force` で作業が消える |
| **意図しない公開** | Privateリポジトリをうっかり Public 化、Driveの共有設定変更 |
| **顧客情報の混入** | 個人情報や証憑をうっかりコミット・送信 |

---

## 基本の考え方：多層防御（Defense in Depth）

1つの対策に頼ると、それが破られたら終わりです。
そこで**性質の違う防御を重ねて**、どれかをすり抜けても次で止める設計にします。

```
        ┌─────────────────────────────────────────────┐
利用者 →│  ① permissions.deny  … 問答無用でブロック     │ ← 一番外側・最速
        │  ② permissions.ask   … 人間に確認            │
        │  ③ hooks ガード       … 文脈で判断（柔軟）    │
        │  ④ .gitignore        … そもそも触れさせない   │ ← 入口で予防
        └─────────────────────────────────────────────┘
                          ↓
                    AIの実行・コミット
```

---

## ① permissions.deny — 完全ブロック（最速・確実）

`settings.json` の `permissions.deny` に書いたものは、**問答無用で拒否**されます。
判断の余地がない「絶対ダメ」を置きます。

```json
"deny": [
  "Read(**/.env*)",       // 認証情報ファイルは読ませない
  "Read(**/*.pem)",       // 秘密鍵
  "Bash(curl*)",          // 生の curl/wget は禁止（送信の入口）
  "Bash(wget*)",
  "Bash(rm -rf *)",       // 破滅的削除
  "Bash(chmod 777 *)"     // 権限の無効化
]
```

**ポイント**: `curl`/`wget` を丸ごと禁止しているのは、漏洩の最も一般的な経路だからです。
必要なAPI通信は、専用のMCPツール（GitHub、Slack 等）を通せば安全に行えます。

---

## ② permissions.ask — 人間に確認させる

「便利だけど取り返しがつかない操作」は、即実行させず**人間に確認**を求めます。

```json
"ask": [
  "mcp__gmail__send_message",        // メール送信（誤送信防止）
  "mcp__gmail__delete_message",      // 削除
  "mcp__github__create_repository",  // リポジトリ作成
  "mcp__slack__send_message",        // Slack送信
  "mcp__google-drive__shareFile"     // 共有設定の変更（情報公開）
]
```

**送信・削除・公開・課金**に関わる操作は ask にする、と覚えてください。

---

## ③ hooks ガード — 文脈で判断する賢い門番

permissions は「ツール名」や「単純なパターン」でしか判断できません。
より複雑な「**送信と認証情報の組み合わせ**」のような文脈判断は、**hooks**（フック）で行います。
hooks は AI がツールを実行する**直前（PreToolUse）**に小さなスクリプトを挟み、許可/確認/拒否を返せます。

### credential-guard.sh — 認証ファイルの読み取り検知
`.env`、`token.json`、`*.pem`、`credentials` 等を読もうとしたら **ask（確認）** に降格。
deny をすり抜けるファイル名（命名のゆれ）に対する保険です。

### exfil-guard.sh — 漏洩対策の中核（即ブロック）
**「ネットワーク送信」×「認証情報」**という危険な組み合わせを検出したら **deny（即ブロック）**。

- `curl ... -d @.env ...` のような直接送信
- `base64` でエンコードして隠して送る手口
- 一時ファイル経由の間接送信

`curl`/`wget` などのネットワーク送信コマンドを含まないコマンド（通常のファイル操作・git・python 実行など）は、最初の判定で素通しするので、誤検知しにくい作りです。

### anomaly-guard.sh — 異常行動の検知
プロンプトインジェクションで「普段しない破壊的・送信的な行動」をAIがやり始めた時の検知器。
検出したら **ask（確認）** に降格します。

- 大量削除（`rm -r`、`find -delete`、`Remove-Item -Recurse`、SQL `DROP`）
- 履歴破壊（`git filter-repo`、`git push --force`、`git reset --hard`）
- 誤公開（`gh repo edit --visibility public`）
- 外部送信先（`scp`/`rsync`/`aws s3 cp`/`gsutil`/`git remote add`）

### LLM判定フック（settings 内の `type: prompt`）
正規表現では拾いきれない巧妙な手口を、**AI自身にもう一段チェックさせる**仕組みです。
「このコマンドは漏洩の試みか？」を別のAI判定に通し、危険なら止めます。

> **なぜスクリプトとAI判定の両方？** スクリプトは速くて確実だがパターンが固定。AI判定は柔軟だが完璧ではない。両者を重ねることで穴を減らします（これも多層防御）。

---

## ④ .gitignore — そもそも触れさせない（最良の予防）

最も確実な漏洩対策は「**漏洩しうるものを、漏洩しうる場所に置かない**」ことです。
`.gitignore` で認証情報・顧客データを**最初からGit管理の対象外**にすれば、
うっかりコミットも、AIによる誤送信のリスクも根本から減ります。

```
.env
*.pem
credentials*
*.csv          # 顧客データが入りがちな形式
証憑/           # 業務フォルダ
```

---

## 自分で育てる（カスタマイズ）

このひな形は**出発点**です。業務に合わせて少しずつ強く・賢くしていきましょう。

### 誤検知（安全なのに止まる）が多いとき
`exfil-guard.sh` は「ネットワーク送信コマンド（`curl`/`wget` 等）× 認証情報パターン」を検出したときだけ deny します。
安全なのに止まる場合は、認証情報とみなすパターン `CRED='...'` から、誤検知の原因になっている語を外します（防御は少し弱まる点に注意）。

```bash
# exfil-guard.sh の該当行（初期値）
CRED='(\.env|token\.json|client_secret|api_key|credential|\.pem|\.key|private_key|access_token)'

# 例: ファイル名に "key" を含む安全なファイルを毎回送っていて誤検知する場合は \.key を外す
CRED='(\.env|token\.json|client_secret|api_key|credential|\.pem|private_key|access_token)'
```

> そもそも `curl`/`wget` 自体は `permissions.deny` で禁止しているので、exfil-guard が誤発火する場面はかなり限定的です。
> なお `curl`/`wget` を含まないコマンドは最初の判定で素通しするため、`CRED` をいじる前に「本当にネットワーク送信コマンドが入っているか」を確認してください。

### 守りを足したいとき
`anomaly-guard.sh` に新しい検知パターンを追記します。

```bash
# 例: terraform destroy を確認対象にする
if echo "$COMMAND" | grep -qE 'terraform[[:space:]]+destroy'; then
  ask "⚠️ インフラ破壊検出: terraform destroy"
fi
```

### MCPの確認を増やしたいとき
`settings.json` の `permissions.ask` に、確認したいMCPツール名を足します。

---

## ガードの返し方（仕様メモ）

hooks スクリプトは標準入力でツール情報（JSON）を受け取り、標準出力でJSONを返します。

```json
{"hookSpecificOutput":{
  "hookEventName":"PreToolUse",
  "permissionDecision":"deny",   // "deny"=ブロック / "ask"=確認 / 何も返さない=許可
  "permissionDecisionReason":"理由（ユーザーに表示される）"
}}
```

何も出力せず `exit 0` すれば、そのガードは「問題なし」として素通しします。
複数のガードを重ねても、**最も厳しい判断が優先**されます。

---

## まとめ：3つの原則

1. **最小権限から始める** — 必要になったら足す。最初から全部許可しない。
2. **取り返しのつかない操作は人間が確認** — 送信・削除・公開・課金。
3. **機密は入口で締め出す** — `.gitignore` と `deny` で、そもそも触れさせない。

この3つを守れば、AIに安心して業務を任せられます。
