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
if [[ ! -f .env.n8n.local ]]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "Не найден openssl для создания локального ключа n8n."
    exit 1
  fi
  umask 077
  print -r -- "N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)" > .env.n8n.local
  echo "Создан локальный ключ n8n. Храните .env.n8n.local только на этом Mac."
fi
if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama не установлен. Установите его с https://ollama.com/download/mac."
  exit 1
fi
if ! curl --silent --fail --max-time 2 http://127.0.0.1:11434/api/version >/dev/null; then
  brew services run ollama
  touch .ollama-started-by-sales-agent
fi
for attempt in {1..30}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:11434/api/version >/dev/null; then
    break
  fi
  sleep 1
done
if ! curl --silent --fail --max-time 2 http://127.0.0.1:11434/api/version >/dev/null; then
  echo "Ollama не запустился. WhatsApp-мост не изменён."
  exit 1
fi
if ! ollama list | grep -q '^qwen3:1.7b[[:space:]]'; then
  echo "Первый запуск: загружается локальная модель qwen3:1.7b (около 1,4 ГБ)."
  ollama pull qwen3:1.7b
fi

docker compose -f compose.whatsapp.yaml up -d --build
echo "WhatsApp, локальный n8n и Ollama запущены. n8n: http://localhost:5678."
echo "Автоответы требуют заполненного обучения, AI ON на сайте и локального переключателя enable-sales-agent.command."
echo "Для выключения запустите stop-whatsapp.command."
