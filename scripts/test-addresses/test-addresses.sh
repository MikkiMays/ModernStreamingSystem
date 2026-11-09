#!/usr/bin/env bash
# Стенд «разных адресов» на A для автотестов и нагрузки (см. proxy.mjs). От root.
#   bash scripts/test-addresses/test-addresses.sh up [N]   # интерфейс cordtest0 с N адресами 10.77.x.x и прокси :18299
#   bash scripts/test-addresses/test-addresses.sh down
#   CORD_TEST_PROXY=http://127.0.0.1:18299 PLAYWRIGHT_BASE_URL=https://callcord.ru npx playwright test …
# Адреса — только на этой машине (интерфейс dummy, наружу не маршрутизируются): так ходят автотесты к стенду A.
# Продукт на meet отсюда разными адресами не увидеть — для него нагрузка идёт с нескольких машин флота.
set -euo pipefail
cmd=${1:-up}; count=${2:-200}
dir=$(cd "$(dirname "$0")" && pwd)
case "$cmd" in
  up)
    ip link show cordtest0 >/dev/null 2>&1 || ip link add cordtest0 type dummy
    ip link set cordtest0 up
    for ((i = 0; i < count; i++)); do ip addr add "10.77.$((i / 250)).$((i % 250 + 1))/32" dev cordtest0 2>/dev/null || true; done
    pkill -f "test-addresses/proxy.mjs" 2>/dev/null || true
    nohup node "$dir/proxy.mjs" --count "$count" >/tmp/cord-test-addresses.log 2>&1 &
    sleep 1; cat /tmp/cord-test-addresses.log
    ;;
  down)
    pkill -f "test-addresses/proxy.mjs" 2>/dev/null || true
    ip link del cordtest0 2>/dev/null || true
    echo "test-addresses: снято"
    ;;
  *) echo "up [N] | down" >&2; exit 2 ;;
esac
