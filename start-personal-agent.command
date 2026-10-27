#!/bin/zsh
cd "$(dirname "$0")" || exit 1
if [ -f "$HOME/Library/LaunchAgents/digital.shaikh.companion.plist" ]; then
  node companion/service.mjs start
else
  node companion/start.mjs
fi
if [ $? -ne 0 ]; then
  read -r '?Нажми Enter, чтобы закрыть окно.'
fi
