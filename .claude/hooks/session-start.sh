#!/usr/bin/env bash
# session-start.sh — Claude Code SessionStart hook
#
# セッション開始時に「今日の日付」と「CLAUDE.md の冒頭」を Claude に注入する。
# 配置先: ~/.claude/hooks/session-start.sh
# settings.json 設定例は README 参照。
#
# 動作: 本スクリプトの stdout がそのまま Claude のコンテキストに追記される。

set -euo pipefail

DATE=$(date "+%Y-%m-%d")

cat <<EOF
=== SESSION START ===
Today: ${DATE}
EOF

# 作業フォルダの CLAUDE.md が存在すれば冒頭 30 行を注入
# （作業ディレクトリが自動でプロジェクトルートになる）
if [ -f "CLAUDE.md" ]; then
  echo ""
  echo "--- CLAUDE.md (冒頭30行) ---"
  head -30 "CLAUDE.md"
  echo "----------------------------"
fi

echo "===================="
