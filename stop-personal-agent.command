#!/bin/zsh
cd "$(dirname "$0")" || exit 1
node companion/stop.mjs
