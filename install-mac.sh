#!/bin/bash
# Installs a daily launchd job that runs update.mjs at 5:45pm (Mac's local time).
# Re-run any time to change the time:  ./install-mac.sh 18 30
set -euo pipefail
HOUR=${1:-17}; MIN=${2:-45}
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found. Install it from https://nodejs.org (or: brew install node), then re-run."; exit 1; }
[ -f "$DIR/config.json" ] || cp "$DIR/config.example.json" "$DIR/config.json"
mkdir -p "$DIR/logs"
LABEL=org.artradar.openings
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/update.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <key>StandardOutPath</key><string>$DIR/logs/update.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/update.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
printf 'Installed: runs daily at %02d:%02d. Log: %s/logs/update.log\n' "$HOUR" "$MIN" "$DIR"
echo "Run it now with:  launchctl kickstart gui/$(id -u)/$LABEL"
