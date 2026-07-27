#!/bin/bash
# anomaly-guard.sh - 異常行動検知ガード
# プロンプトインジェクション対策。普段と違う破壊的・外部送信的な行動
# （大量削除 / 履歴破壊 / リポジトリ公開化 / 外部送信先）を検知したら ask に降格して人間に確認を求める。
set -euo pipefail

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | python -c 'import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get("tool_input",{}).get("command",""))
except Exception:
  pass
' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

ask() {
  local reason="$1"
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$reason"
  exit 0
}

# ============================================================
# 1. 大量削除パターン
# ============================================================

# Remove-Item -Recurse (PowerShell)
if echo "$COMMAND" | grep -qiE 'Remove-Item.*-Recurse|Remove-Item.*-r[[:space:]]|ri[[:space:]].*-Recurse'; then
  ask "⚠️ 大量削除パターン検出: Remove-Item -Recurse（PowerShell）"
fi

# del /s (cmd)
if echo "$COMMAND" | grep -qiE '(^|[[:space:]])del[[:space:]]+(/[a-z][[:space:]]+)*/s'; then
  ask "⚠️ 大量削除パターン検出: del /s（cmd 再帰削除）"
fi

# find ... -delete / -exec rm
if echo "$COMMAND" | grep -qE 'find[[:space:]].*-delete'; then
  ask "⚠️ 大量削除パターン検出: find -delete"
fi
if echo "$COMMAND" | grep -qE 'find[[:space:]].*-exec[[:space:]]+rm'; then
  ask "⚠️ 大量削除パターン検出: find -exec rm"
fi

# rm -r （rm -rf * は permissions.deny で止まるが、それ以外のパターン）
if echo "$COMMAND" | grep -qE '(^|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*[[:space:]])'; then
  ask "⚠️ 大量削除パターン検出: rm -r（再帰削除）"
fi

# git filter-repo / filter-branch（履歴破壊）
if echo "$COMMAND" | grep -qE 'git[[:space:]]+filter-(repo|branch)'; then
  ask "⚠️ 履歴破壊パターン検出: git filter-repo/filter-branch"
fi

# gh repo delete / gh release delete / gh gist delete
if echo "$COMMAND" | grep -qE 'gh[[:space:]]+(repo|release|gist)[[:space:]]+delete'; then
  ask "⚠️ GitHub リソース削除パターン検出: gh ... delete"
fi

# SQL DROP / TRUNCATE
if echo "$COMMAND" | grep -qiE '\b(DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)|TRUNCATE[[:space:]]+TABLE)\b'; then
  ask "⚠️ SQL 破壊操作検出: DROP/TRUNCATE"
fi

# ============================================================
# 2. 大量書き換え・破壊的操作
# ============================================================

# git push --force / -f
if echo "$COMMAND" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))'; then
  ask "⚠️ 強制 push 検出: git push --force（履歴上書きの可能性）"
fi

# git push with + refspec (force push 相当)
if echo "$COMMAND" | grep -qE 'git[[:space:]]+push[[:space:]]+[^[:space:]]+[[:space:]]+\+'; then
  ask "⚠️ 強制 push 検出: git push +refspec（force 相当）"
fi

# git reset --hard
if echo "$COMMAND" | grep -qE 'git[[:space:]]+reset[[:space:]]+--hard'; then
  ask "⚠️ 破壊的操作検出: git reset --hard（未コミット変更喪失の可能性）"
fi

# git checkout . / git restore . / git clean -f
if echo "$COMMAND" | grep -qE 'git[[:space:]]+(checkout|restore)[[:space:]]+\.([[:space:]]|$)'; then
  ask "⚠️ 破壊的操作検出: git checkout/restore .（未コミット変更喪失）"
fi
if echo "$COMMAND" | grep -qE 'git[[:space:]]+clean[[:space:]]+(-[a-zA-Z]*f|--force)'; then
  ask "⚠️ 破壊的操作検出: git clean -f（追跡外ファイル削除）"
fi

# Rename-Item -Recurse
if echo "$COMMAND" | grep -qiE 'Rename-Item.*-Recurse'; then
  ask "⚠️ 大量リネーム検出: Rename-Item -Recurse"
fi

# gh repo edit --visibility public ← Private リポの誤公開防止
if echo "$COMMAND" | grep -qE 'gh[[:space:]]+repo[[:space:]]+edit.*--visibility[[:space:]]+public'; then
  ask "🚨 リポジトリ公開化検出: gh repo edit --visibility public（Privateリポの誤公開）"
fi

# gh repo create ... --public
if echo "$COMMAND" | grep -qE 'gh[[:space:]]+repo[[:space:]]+create.*--public'; then
  ask "⚠️ Publicリポジトリ作成: gh repo create --public（情報持ち出し先になり得る）"
fi

# ============================================================
# 3. 普段使わない外部送信先
# ============================================================

# scp / sftp / rsync to remote (user@host: or host:)
if echo "$COMMAND" | grep -qE '(^|[[:space:]])(scp|sftp|rsync)[[:space:]].*[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+:'; then
  ask "⚠️ リモート送信検出: scp/sftp/rsync（外部ホスト宛）"
fi

# ssh で任意コマンド実行（ssh host command 形式）
if echo "$COMMAND" | grep -qE '(^|[[:space:]])ssh[[:space:]]+[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+[[:space:]]+[a-zA-Z]'; then
  ask "⚠️ SSH 経由のリモートコマンド実行検出"
fi

# aws s3 cp / sync / mv (S3 への送信)
if echo "$COMMAND" | grep -qE 'aws[[:space:]]+s3[[:space:]]+(cp|sync|mv).*s3://'; then
  ask "⚠️ AWS S3 送信検出: aws s3 cp/sync"
fi

# gsutil cp / rsync to gs://
if echo "$COMMAND" | grep -qE 'gsutil[[:space:]]+(cp|rsync|mv).*gs://'; then
  ask "⚠️ GCS 送信検出: gsutil cp/rsync"
fi

# git remote add で外部リポ追加（送信先設定の可能性）
if echo "$COMMAND" | grep -qE 'git[[:space:]]+remote[[:space:]]+add'; then
  ask "⚠️ Git リモート追加検出: git remote add（外部送信先設定の可能性）"
fi

exit 0
