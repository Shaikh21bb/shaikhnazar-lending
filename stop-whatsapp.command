#!/bin/zsh
set -e
cd -- "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop уже выключен."
else
  docker compose -f compose.whatsapp.yaml stop whatsapp-bridge
fi
if [[ -f .ollama-started-by-sales-agent ]]; then
  brew services stop ollama
  rm .ollama-started-by-sales-agent
fi
echo "Локальный Sales Agent остановлен. Связанный WhatsApp и история сохранены в Docker volume."
