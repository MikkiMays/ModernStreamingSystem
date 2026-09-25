#!/usr/bin/env bash
#
# Cord — проверка подсети плеера страниц (`sniffer-firewall.sh validate`), в контейнере.
#
#   bash infra/sniffer-subnet-test.sh          на двойнике сети прода в своём пространстве имён контейнера
#   bash infra/sniffer-subnet-test.sh --host   и ещё против настоящих маршрутов этого хоста (только чтение)
#
# ПОЧЕМУ В КОНТЕЙНЕРЕ. validate читает маршруты и адреса (`ip`), а чтобы проверить «в подсети шлюз по
# умолчанию» или «мост самой сети — не пересечение», нужны сети, которых на машине разработчика может не
# быть. Контейнер с `--network none` и `NET_ADMIN` получает своё пространство имён сети: в нём собирается
# двойник прода (шлюз 10.0.0.1 onlink, внешний адрес /32, docker0 и мосты 172.18–172.20, мост сети плеера
# страниц 10.231.0.0/24 с docker-именем) и ещё LAN 192.168.50.0/24 — а сам хост не меняется ничем.
# iptables в контейнере нет; на его месте — ловушка, которая записывает каждый вызов: ни validate, ни apply
# и check с негодной подсетью не должны позвать его ни разу.
#
# --host добавляет прогон в сети самого хоста (`--network host`, без NET_ADMIN и только для чтения):
# подсеть с настоящим шлюзом по умолчанию хоста не годится, а 10.231.0.0/24 — годится, в том числе когда её
# сеть docker уже поднята (мост самой этой сети — не пересечение).
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"
IMAGE="${CORD_WALL_TEST_IMAGE:-cord-wall-test:dev}"
HOST=0
[[ "${1:-}" == --host ]] && HOST=1

# bash и настоящий iproute2 (у busybox `ip` другой вывод): образ маленький и собирается один раз.
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -q -t "$IMAGE" - >/dev/null <<'DOCKERFILE'
FROM alpine:3.23.3
RUN apk add --no-cache bash iproute2
DOCKERFILE
fi

# Внутри контейнера: сеть-двойник, ловушка вместо iptables и таблица случаев.
read -r -d '' CASES <<'SCRIPT' || true
set -euo pipefail
bridge() {
  ip link add "$1" type bridge
  ip link set "$1" up
  if [[ -n "${2:-}" ]]; then ip addr add "$2" dev "$1"; fi
}
if [[ "$MODE" == twin ]]; then
  # Двойник прода (`ip -4 route`/`ip -4 addr` на meet.nikg.tech, 25.09.2026) — мостами: модуля dummy на
  # хосте может не быть, а bridge есть везде, где есть docker.
  bridge ens3 108.165.32.23/32
  ip route add default via 10.0.0.1 dev ens3 onlink
  bridge docker0 172.17.0.1/16
  bridge br-4703bba61033 172.18.0.1/16
  bridge br-6ed0bf340a1f 172.19.0.1/16
  bridge br-5333f8beda83 10.231.0.1/24
  bridge br-b56cd6c8467d 172.20.0.1/16
  bridge lan0 192.168.50.10/24
fi

mkdir -p /tmp/trap
printf '#!/bin/sh\necho "$*" >>/tmp/trap/iptables.log\nexit 1\n' >/tmp/trap/iptables
chmod +x /tmp/trap/iptables
export PATH="/tmp/trap:$PATH"
: >/tmp/trap/iptables.log

failed=0
expect() {
  local want="$1" action="$2" net="$3" code=0 output
  output="$(bash /w/infra/sniffer-firewall.sh "$action" ${net:+"$net"} 2>&1)" || code=$?
  local got=bad
  ((code == 0)) && got=ok
  local reason
  reason="$(printf '%s\n' "$output" | sed -n '2p' | sed 's/^ *//')"
  if [[ "$got" == "$want" ]]; then
    printf '  ok    %-9s %-26s → %-3s %s\n' "$action" "${net:-\$CINEMA_SNIFFER_SUBNET}" "$got" "${reason:0:90}"
  else
    printf '  FAIL  %-9s %-26s → %-3s (ждали %s, код %s)\n%s\n' "$action" "${net:-\$CINEMA_SNIFFER_SUBNET}" "$got" \
      "$want" "$code" "$output"
    failed=1
  fi
}

if [[ "$MODE" == twin ]]; then
  echo "двойник прода: маршруты"
  ip -4 route show table main | sed 's/^/    /'
  # Обязательные случаи задачи M2.
  expect bad validate 0.0.0.0/0
  expect bad validate 10.0.0.0/8
  expect bad validate 10.232.0.0/15
  expect ok validate 10.232.0.0/16
  expect ok validate 10.232.5.0/24
  expect ok validate 10.232.5.8/29
  expect bad validate 10.232.5.8/30
  expect bad validate 10.999.0.0/24
  expect bad validate 10.232.5.1/24
  expect bad validate 172.20.0.0/16
  expect bad validate 10.0.0.0/24
  expect ok validate 10.231.0.0/24
  # Сверх списка: ведущий ноль, мост своей сети только при точном совпадении, LAN, адрес хоста, служебные
  # диапазоны, стенд разработчика и то, что подсетью не является вовсе.
  expect bad validate 010.231.0.0/24
  expect bad validate 10.231.0.0/16
  expect bad validate 192.168.0.0/16
  expect bad validate 192.168.50.128/25
  expect ok validate 192.168.51.0/24
  expect bad validate 108.165.32.0/24
  expect bad validate 127.0.0.0/16
  expect bad validate 169.254.0.0/16
  expect bad validate 224.1.0.0/16
  expect ok validate 10.231.1.0/24
  expect bad validate 10.231.0.0
  expect bad validate '10.231.0.0/24 -j ACCEPT'
  expect bad validate abc
  # Подсеть из окружения (`CINEMA_SNIFFER_SUBNET`), как её читают единицы systemd.
  CINEMA_SNIFFER_SUBNET=10.231.0.0/24 expect ok validate ''
  CINEMA_SNIFFER_SUBNET=10.0.0.0/24 expect bad validate ''
  # apply и check с негодной подсетью отказывают раньше iptables.
  expect bad apply 0.0.0.0/0
  expect bad apply 10.0.0.0/24
  expect bad check 172.20.0.0/16
else
  echo "сеть самого хоста: маршруты"
  ip -4 route show table main | sed 's/^/    /'
  gateway="$(ip -4 route show default | awk '/via/ {for (i = 1; i < NF; i++) if ($i == "via") {print $(i + 1); exit}}')"
  if [[ -n "$gateway" ]]; then
    IFS=. read -r a b c _ <<<"$gateway"
    expect bad validate "$a.$b.$c.0/24"
  else
    echo "  (шлюза по умолчанию у хоста нет — этот случай пропущен)"
  fi
  expect ok validate 10.231.0.0/24
fi

if [[ -s /tmp/trap/iptables.log ]]; then
  echo "  FAIL  iptables звали:"
  sed 's/^/        /' /tmp/trap/iptables.log
  failed=1
else
  echo "  ok    iptables не звали ни разу"
fi
exit "$failed"
SCRIPT

status=0
echo "== sniffer-firewall.sh: bash -n"
bash -n infra/sniffer-firewall.sh && echo "  ok"
echo "== подсеть на двойнике прода (--network none, своё пространство имён сети)"
docker run --rm --network none --cap-add NET_ADMIN -e MODE=twin -v "$root:/w:ro" "$IMAGE" bash -c "$CASES" \
  || status=1
if ((HOST)); then
  echo "== подсеть в сети этого хоста (--network host, только чтение)"
  docker run --rm --network host --read-only --cap-drop ALL -e MODE=host -v "$root:/w:ro" --tmpfs /tmp \
    "$IMAGE" bash -c "$CASES" || status=1
fi
if ((status)); then echo "ПРОВАЛ"; else echo "всё сходится"; fi
exit "$status"
