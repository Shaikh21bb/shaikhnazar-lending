#!/bin/zsh
set -e
cd -- "$(dirname "$0")"
docker compose -f compose.whatsapp.yaml exec -T whatsapp-bridge node /app/toggle.mjs off
echo "Автоответы выключены. WhatsApp остаётся подключённым."
