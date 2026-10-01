#!/usr/bin/env bash
# Один запуск проекта rd: проверка окружения, установка зависимостей,
# проверка типов и тестов, запуск signaling-сервера и веб-клиента.
#
#   ./start.sh                 обычный запуск
#   ./start.sh --skip-install  не трогать node_modules
#   ./start.sh --no-browser    не открывать браузер
set -euo pipefail

cd "$(dirname "$0")"

SERVER_PORT="${SERVER_PORT:-8787}"
WEB_PORT="${WEB_PORT:-5173}"
SKIP_INSTALL=""
NO_BROWSER=""

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --no-browser) NO_BROWSER=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "неизвестный аргумент: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; }

step 'Проверка Node.js'
if ! command -v node >/dev/null 2>&1; then
  fail 'Node.js не найден. Установите 20.11 или новее: https://nodejs.org/'
  exit 1
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
echo "  node $NODE_VERSION"
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Нужен Node.js 20.11 или новее, найден $NODE_VERSION."
  exit 1
fi

if [ -z "$SKIP_INSTALL" ]; then
  step 'Установка зависимостей (npm install)'
  if ! command -v npm >/dev/null 2>&1; then
    fail 'npm не найден: он идёт в составе Node.js.'
    exit 1
  fi
  npm install
fi

step 'Проверка типов и тестов'
npx --no-install tsc -p tsconfig.json --noEmit
npx --no-install vitest run --reporter=dot
printf '\033[32m  типы и тесты в порядке\033[0m\n'

step 'Запуск signaling-сервера и веб-клиента'
export PORT="$SERVER_PORT"
export VITE_SIGNALING_URL="ws://localhost:$SERVER_PORT/ws"

# Собранного сервера может не быть — тогда запускаем исходники через tsx.
if [ -f packages/signaling/dist/main.js ]; then
  node packages/signaling/dist/main.js &
else
  npx --no-install tsx packages/signaling/src/main.ts &
fi
SERVER_PID=$!

( cd packages/web && npx --no-install vite --port "$WEB_PORT" ) &
WEB_PID=$!

sleep 4
echo "  signaling: http://localhost:$SERVER_PORT/healthz"
printf '\033[32m  клиент:   http://localhost:%s\033[0m\n' "$WEB_PORT"
if [ -z "$NO_BROWSER" ] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$WEB_PORT" >/dev/null 2>&1 || true
fi

printf '\n\033[33mОстановить: Ctrl+C\033[0m\n'
cleanup() {
  kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait
