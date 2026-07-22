# Hooks セットアップパック（SessionStart / PostCompact）

CLAUDE.md・Memory までで「AI が事務所の前提を読み込む」状態は完成しています。
このパックは、**セッション中に文脈が劣化したとき、自動で立て直す仕掛け**を入れます。

「長い会話で前提を忘れる」「圧縮（`/compact`）が走るとルールが抜ける」を防ぎます。

---

## 入っているもの

| フック | タイミング | 効果 |
|--------|-----------|------|
| `hooks/session-start.sh` | セッション開始時（毎回） | 今日の日付 + CLAUDE.md の冒頭を自動注入 |
| `hooks/post-compact.sh` | `/compact` 後 | 圧縮で消えた前提情報を再注入 |

### 入れると何が変わるか

- 「今日は何日ですか」と聞かなくていい
- CLAUDE.md に書いた大事なルールが毎セッション冒頭で読まれる
- `/compact` 後に「前提を忘れた Claude」になりにくい

> 💡 これは最小構成の2本です。慣れてきたら、`Stop`（応答完了時に通知）や `PostToolUse`（編集後にログ記録）など他のタイミングのフックも追加できます。まずはこの2本で効果を体感してください。

---

## 前提条件

- 「セットアップ-mdファイル」で CLAUDE.md を設置済み
- Mac または Windows（Git Bash / WSL 環境）

---

## 設置手順

### 1. ファイルを配置する

```bash
mkdir -p ~/.claude/hooks

cp hooks/session-start.sh ~/.claude/hooks/session-start.sh
cp hooks/post-compact.sh  ~/.claude/hooks/post-compact.sh

chmod +x ~/.claude/hooks/session-start.sh
chmod +x ~/.claude/hooks/post-compact.sh
```

Windows（Git Bash）の場合、`~` は `/c/Users/あなたの名前` に相当します。

### 2. settings.json に追記する

`~/.claude/settings.json` を開き、`"hooks"` セクションに以下を追記します。

**Mac のパス例（書き換えて使ってください）:**

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash /Users/あなたの名前/.claude/hooks/session-start.sh",
          "timeout": 5
        }
      ]
    }
  ],
  "PostCompact": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash /Users/あなたの名前/.claude/hooks/post-compact.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

**Windows のパス例:**

```json
"hooks": {
  "SessionStart": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash C:/Users/あなたの名前/.claude/hooks/session-start.sh",
          "timeout": 5
        }
      ]
    }
  ],
  "PostCompact": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash C:/Users/あなたの名前/.claude/hooks/post-compact.sh",
          "timeout": 5
        }
      ]
    }
  ]
}
```

> 「セットアップ-セキュリティ」で `settings.json` を既に設置している場合は、既存の `"hooks"` ブロックの中に `SessionStart` / `PostCompact` を**追記**してください（`PreToolUse` を上書きしないよう注意）。

---

## 動作確認

Claude Code を起動し、最初のメッセージを送ってみてください。以下のような注入が確認できれば成功です。

```
=== SESSION START ===
Today: 2026-07-01
--- CLAUDE.md (冒頭30行) ---
（CLAUDE.md の内容がここに表示される）
----------------------------
====================
```

---

## カスタマイズ

### 抜粋行数を変える

`session-start.sh` の `head -30` の数字を変えると読み込む行数が変わります。

```bash
head -50 "CLAUDE.md"  # 50行に増やす例
```

CLAUDE.md が長い場合は 20〜30 行が目安です。重要ルールを冒頭にまとめておくと効果が高くなります。

### 日付に曜日を追加する

```bash
DATE=$(date "+%Y-%m-%d %A")
```

> Mac / Git Bash の locale 設定によって英語表示になる場合があります。

---

## トラブルシューティング

**Q. Claude に何も注入されない**
- ファイルパスが正しいか確認（スペース・大文字小文字・スラッシュの向き）
- `bash ~/.claude/hooks/session-start.sh` を直接実行して出力を確認

**Q. permission denied エラー**
- `chmod +x ~/.claude/hooks/session-start.sh` を実行して実行権限を付与

**Q. 設置したのに反応しない（エラーも出ない）**
- ZIPやクラウドドライブ経由のファイルは改行コードが **CRLF** に変わって動かないことがあります。Claude に「`~/.claude/hooks/` の .sh ファイルの改行コードを確認して、CRLFならLFに直して」と頼んでください

**Q. CLAUDE.md が注入されない**
- Claude Code を起動したディレクトリに CLAUDE.md があるか確認
- フックはプロジェクトのルートディレクトリで実行されます

**Q. 既存の hooks ブロックに追記したら JSON エラーになった**
- カンマ・括弧の数を確認するか、その場で Claude Code に「このJSONのエラーを直して」とエラーメッセージごと貼り付ければ直してくれます
