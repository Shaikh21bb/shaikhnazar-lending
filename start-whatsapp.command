#!/bin/zsh
set -e
cd -- "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Откройте Docker Desktop и дождитесь запуска, затем повторите."
  exit 1
fi
if [[ ! -f .env.worker.local ]]; then
  echo "Не найдены локальные настройки .env.worker.local. QR-мост не запущен."
  exit 1
fi

docker compose -f compose.whatsapp.yaml up -d --build
echo "WhatsApp QR-мост запущен. Откройте агента «Шаихназар» на https://shaikh.digital."
echo "Для выключения запустите stop-whatsapp.command."
