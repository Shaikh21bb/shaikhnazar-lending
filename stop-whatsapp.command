#!/bin/zsh
set -e
cd -- "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop уже выключен. WhatsApp QR-мост не работает."
  exit 0
fi

docker compose -f compose.whatsapp.yaml stop
echo "WhatsApp QR-мост остановлен. Связанный WhatsApp сохранён в Docker volume."
