#!/bin/zsh
cd "$(dirname "$0")" || exit 1
node companion/start.mjs
if [ $? -ne 0 ]; then
  read -r '?Нажми Enter, чтобы закрыть окно.'
fi
