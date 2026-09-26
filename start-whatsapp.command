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
model="${LOCAL_AGENT_MODEL:-qwen3.5:9b-mlx}"
case "$model" in
  qwen3.5:9b-mlx|qwen3:1.7b|llama3.1:8b) ;;
  *)
    echo "Неизвестная модель: $model. Выберите одну из трёх установленных моделей."
    exit 1
    ;;
esac
if ! ollama list | awk -v requested="$model" 'NR > 1 && $1 == requested { found = 1 } END { exit !found }'; then
  echo "Первый запуск: загружается локальная модель $model."
  ollama pull "$model"
fi
export LOCAL_AGENT_MODEL="$model"

docker compose -f compose.whatsapp.yaml up -d --build
echo "WhatsApp, локальный n8n и Ollama запущены. n8n: http://localhost:5678."
echo "Модель выбирается в карточке агента на сайте. Заполните обучение и нажмите «Включить ответы»."
echo "Кнопка «Приостановить ответы» останавливает диалог без потери WhatsApp-связи и памяти."
echo "Для выключения запустите stop-whatsapp.command."
