#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if [ -f "$HOME/Library/LaunchAgents/digital.shaikh.companion.plist" ]; then
  node companion/service.mjs stop
else
  node companion/stop.mjs
fi
