#!/usr/bin/env bash
# Плохой канал для одного тестового браузера (R107): своё сетевое пространство имён и netem на его
# паре veth. Сеть стенда не трогается: правила висят только на `cv0`/`cv1`, а стенд браузер видит
# как обычный внешний адрес (443/tcp и 7882/udp открыты в ufw и так).
#
#   sudo e2e/media/netns.sh up                                 # пространство cordvoice, 10.213.0.2
#   sudo e2e/media/netns.sh shape delay 40ms 30ms loss 3%      # оба направления
#   sudo e2e/media/netns.sh shape-down rate 1mbit delay 40ms   # только к слушателю
#   sudo e2e/media/netns.sh clear                              # снять netem
#   sudo e2e/media/netns.sh down                               # всё убрать
#   sudo e2e/media/netns.sh exec <команда…>                    # запустить внутри
set -euo pipefail
NS=${CORD_NETNS:-cordvoice}
HOST_IF=cv0
NS_IF=cv1
HOST_IP=10.213.0.1
NS_IP=10.213.0.2

case "${1:-}" in
  up)
    ip netns add "$NS"
    ip link add "$HOST_IF" type veth peer name "$NS_IF"
    ip link set "$NS_IF" netns "$NS"
    ip addr add "$HOST_IP/30" dev "$HOST_IF"
    ip link set "$HOST_IF" up
    ip netns exec "$NS" ip addr add "$NS_IP/30" dev "$NS_IF"
    ip netns exec "$NS" ip link set "$NS_IF" up
    ip netns exec "$NS" ip link set lo up
    ip netns exec "$NS" ip route add default via "$HOST_IP"
    echo "netns $NS: $NS_IP via $HOST_IF"
    ;;
  shape)
    shift
    tc qdisc replace dev "$HOST_IF" root netem "$@"
    ip netns exec "$NS" tc qdisc replace dev "$NS_IF" root netem "$@"
    tc qdisc show dev "$HOST_IF"
    ;;
  shape-down)
    shift
    tc qdisc replace dev "$HOST_IF" root netem "$@"
    ip netns exec "$NS" tc qdisc del dev "$NS_IF" root 2>/dev/null || true
    tc qdisc show dev "$HOST_IF"
    ;;
  clear)
    tc qdisc del dev "$HOST_IF" root 2>/dev/null || true
    ip netns exec "$NS" tc qdisc del dev "$NS_IF" root 2>/dev/null || true
    ;;
  exec)
    shift
    exec ip netns exec "$NS" "$@"
    ;;
  down)
    tc qdisc del dev "$HOST_IF" root 2>/dev/null || true
    ip link del "$HOST_IF" 2>/dev/null || true
    ip netns del "$NS" 2>/dev/null || true
    echo "netns $NS removed"
    ;;
  *)
    sed -n 2,12p "$0"
    exit 2
    ;;
esac
