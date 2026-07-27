#!/bin/bash
# credential-guard.sh - 認証情報ファイルの読み取りガード
# Read ツールが認証情報ファイルを読もうとしたら、ユーザーに確認を求める（ask に降格）。
# permissions.deny で完全ブロックしているファイルもあるが、こちらは「うっかり読み」の最終防衛線。
set -euo pipefail

INPUT=$(cat)
# JSONパースは python を使用（jq が無い環境でも動くように）
FILE_PATH=$(printf '%s' "$INPUT" | python -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))
except Exception:
  pass
' 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

BASENAME=$(basename "$FILE_PATH")

# .env 系ファイル
if echo "$BASENAME" | grep -qiE '^\.(env|env\..*)$'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⚠️ 認証情報を含む可能性のあるファイル (.env) を読み取ろうとしています。"}}'
  exit 0
fi

# token.json
if echo "$BASENAME" | grep -qiE '^token.*\.json$'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⚠️ OAuthトークンファイルを読み取ろうとしています。"}}'
  exit 0
fi

# credentials / secret / key 系
if echo "$BASENAME" | grep -qiE '(credential|secret|private.key|\.pem$|\.key$|api.key)'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"⚠️ 認証情報・秘密鍵ファイルを読み取ろうとしています。"}}'
  exit 0
fi

exit 0
