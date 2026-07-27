#!/bin/bash
# exfil-guard.sh - 外部送信ガード（情報漏洩対策の中核）
# Bash ツールが「ネットワーク送信」と「認証情報アクセス」を組み合わせたコマンドを
# 実行しようとしたら即ブロック（deny）。プロンプトインジェクションで認証情報を
# 外部に持ち出される事故を防ぐ。
set -euo pipefail

INPUT=$(cat)
# JSONパースは python を使用（jq が無い環境でも動くように）
COMMAND=$(printf '%s' "$INPUT" | python -c 'import json,sys
try:
  print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception:
  pass
' 2>/dev/null)

if [ -z "$COMMAND" ]; then
  exit 0
fi

# ネットワーク系コマンドがなければOK
# ※ 注意: 先頭コマンドだけで安全判定すると `cat .env | curl ...` のような
#   「先頭は安全・パイプの後ろが危険」というケースを見逃します。
#   そのため安全コマンドのホワイトリストは使わず、コマンド文字列全体に
#   ネットワーク送信コマンドが含まれるかどうかで判定します。
if ! echo "$COMMAND" | grep -qiE '(curl|wget|nc[[:space:]]|netcat|ssh[[:space:]]|scp[[:space:]]|Invoke-WebRequest|Invoke-RestMethod)'; then
  exit 0
fi

# ネットワーク + 認証情報パターン → 即ブロック
CRED='(\.env|token\.json|client_secret|api_key|credential|\.pem|\.key|private_key|access_token)'
if echo "$COMMAND" | grep -qiE "$CRED"; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"🚫 ネットワーク送信と認証情報アクセスの組み合わせを検出。ブロックしました。"}}'
  exit 0
fi

# base64 + ネットワーク → ブロック（エンコードで隠して送信する手口）
if echo "$COMMAND" | grep -qiE 'base64' && echo "$COMMAND" | grep -qiE '(curl|wget|http|Invoke-WebRequest)'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"🚫 base64エンコードとネットワーク送信の組み合わせを検出。ブロックしました。"}}'
  exit 0
fi

exit 0
