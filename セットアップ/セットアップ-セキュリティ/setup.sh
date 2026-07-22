#!/bin/bash
# setup.sh - Claude Code セキュリティひな形の導入スクリプト
#
# やること:
#   1. hooks/*.sh を ~/.claude/hooks/ にコピーして実行権限を付与
#   2. settings.security.template.json の __CLAUDE_HOME__ を実際のパスに置換し、
#      マージ用ファイル（settings.security.merged.json）を生成
#   3. 既存 settings.json への安全なマージ手順を案内
#
# Mac / Linux はそのまま、Windows は Git Bash 上で実行してください。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"

echo "================================================"
echo " Claude Code セキュリティひな形 セットアップ"
echo "================================================"
echo " .claude の場所: $CLAUDE_HOME"
echo ""

# --- 1. hooks のコピー ---
mkdir -p "$CLAUDE_HOME/hooks"
for f in credential-guard.sh exfil-guard.sh anomaly-guard.sh; do
  cp "$SCRIPT_DIR/hooks/$f" "$CLAUDE_HOME/hooks/$f"
  chmod +x "$CLAUDE_HOME/hooks/$f"
  echo " [OK] hooks/$f をコピー＆実行権限付与"
done
echo ""

# --- 2. settings 断片のパス置換 ---
MERGED="$SCRIPT_DIR/settings.security.merged.json"
# __CLAUDE_HOME__ を実パスに置換（JSON内なのでバックスラッシュ問題を避けるため / 区切りのパスを使用）
CLAUDE_HOME_SLASH="$(echo "$CLAUDE_HOME" | sed 's|\\|/|g')"
sed "s|__CLAUDE_HOME__|$CLAUDE_HOME_SLASH|g" \
  "$SCRIPT_DIR/settings.security.template.json" > "$MERGED"
echo " [OK] パス置換済みファイルを生成: settings.security.merged.json"
echo ""

# --- 3. マージ案内 ---
echo "------------------------------------------------"
echo " 次の手順（手動マージ）"
echo "------------------------------------------------"
echo " settings.json の自動上書きはしません（既存設定を壊さないため）。"
echo ""
echo " 1) まずバックアップ:"
echo "      cp \"$CLAUDE_HOME/settings.json\" \"$CLAUDE_HOME/settings.json.bak\""
echo ""
echo " 2) settings.security.merged.json の中身を、"
echo "    既存 settings.json の permissions.deny / permissions.ask / hooks.PreToolUse に追記してマージ"
echo "    （jq があれば下記コマンドで自動マージできます）"
echo ""
echo "      jq -s '.[0] * .[1]' \"$CLAUDE_HOME/settings.json\" \"$MERGED\" > /tmp/settings.new.json"
echo "      # 中身を確認してから:"
echo "      mv /tmp/settings.new.json \"$CLAUDE_HOME/settings.json\""
echo ""
echo "    ※ jq の '*' は配列を『置換』するため、deny/ask/hooks を既に使っている人は"
echo "      手動で配列を結合してください（README の『マージの注意』参照）。"
echo ""
echo " 3) Claude Code を再起動して、test-guards.sh で動作確認:"
echo "      bash \"$SCRIPT_DIR/test-guards.sh\""
echo ""
echo " 完了です。お疲れさまでした！"
