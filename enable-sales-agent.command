#!/bin/zsh
set -e
cd -- "$(dirname "$0")"
docker compose -f compose.whatsapp.yaml exec -T whatsapp-bridge node /app/toggle.mjs on
echo "Локальные автоответы разрешены, когда агент «Шаихназар» обучен и AI ON на сайте."
