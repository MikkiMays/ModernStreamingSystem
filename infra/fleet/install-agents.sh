#!/usr/bin/env bash
# Агенты метрик на рабочей машине флота (R208): железо (node-exporter) и контейнеры (cAdvisor) — только на loopback.
# Пульт на A забирает их через постоянный SSH-туннель (infra/fleet/cord-fleet-tunnel@.service); наружу порты не открываются.
#
#   bash install-agents.sh                    # повторный запуск обновляет образы и пересоздаёт контейнеры
#   bash install-agents.sh --containers-only  # на A: железо там уже снимает node-exporter мониторинга, нужен только cAdvisor
#
# Порты: 19100 — node-exporter, 19101 — cAdvisor. Чужой мониторинг на машине (например, Kiki) не трогается.
set -euo pipefail
NODE_IMAGE=prom/node-exporter:v1.12.1
# cAdvisor с ghcr.io: на gcr.io выпуски кончились на 0.52, а 0.52 не понимает хранилище образов containerd у Docker 29
# («failed to identify the read-write layer ID») и отдаёт только корневую группу — без строк по контейнерам.
CADVISOR_IMAGE=ghcr.io/google/cadvisor:v0.60.6@sha256:b8e7d1093144fd088f425ff003d75a4aa405de075db78dae3bc563730b1bd07a
only_containers=false
[ "${1:-}" = --containers-only ] && only_containers=true
docker pull -q "$CADVISOR_IMAGE" >/dev/null
docker rm -f cord-fleet-cadvisor >/dev/null 2>&1 || true
ports=19101
if ! $only_containers; then
ports="19100 19101"
docker pull -q "$NODE_IMAGE" >/dev/null
docker rm -f cord-fleet-node >/dev/null 2>&1 || true
docker run -d --name cord-fleet-node --restart unless-stopped --network host --pid host \
  --memory 128m --cpus 0.25 --read-only \
  -v /:/host:ro,rslave "$NODE_IMAGE" \
  --path.rootfs=/host --web.listen-address=127.0.0.1:19100 \
  --collector.filesystem.mount-points-exclude='^/(dev|proc|sys|run|var/lib/docker/.+)($|/)' >/dev/null
fi
# cAdvisor: кто из контейнеров ест ЦП, память, сеть и диск. Сбор раз в 15 с и без меток контейнеров — дёшево на 2 vCPU.
docker run -d --name cord-fleet-cadvisor --restart unless-stopped --network host --privileged \
  --memory 256m --cpus 0.5 \
  -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro -v /dev/disk/:/dev/disk:ro \
  --device /dev/kmsg "$CADVISOR_IMAGE" \
  --listen_ip=127.0.0.1 --port=19101 --docker_only=true --housekeeping_interval=15s \
  --store_container_labels=false --whitelisted_container_labels=com.docker.compose.service \
  --disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp >/dev/null
sleep 3
for p in $ports; do curl -fsS -o /dev/null -m 5 "http://127.0.0.1:$p/metrics" && echo "агент :$p — ок" || echo "агент :$p — НЕ ОТВЕЧАЕТ"; done
