#!/usr/bin/env bash
# post-compact.sh — Claude Code PostCompact hook
#
# コンテキスト圧縮（/compact）後に重要な前提を再注入する。
# session-start.sh と同じ内容を再度流すことで、圧縮で消えた情報を復元する。
# 配置先: ~/.claude/hooks/post-compact.sh
# settings.json 設定例は README 参照。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# session-start.sh と同じ内容を再注入
exec "$SCRIPT_DIR/session-start.sh"
