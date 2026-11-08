#!/usr/bin/env bash
# Агенты метрик на рабочей машине флота (R208): железо (node-exporter) и контейнеры (cAdvisor) — только на loopback.
# Пульт на A забирает их через постоянный SSH-туннель (infra/fleet/cord-fleet-tunnel@.service); наружу порты не открываются.
#
#   bash install-agents.sh            # повторный запуск обновляет образы и пересоздаёт контейнеры
#
# Порты: 19100 — node-exporter, 19101 — cAdvisor. Чужой мониторинг на машине (например, Kiki) не трогается.
set -euo pipefail
NODE_IMAGE=prom/node-exporter:v1.12.1
CADVISOR_IMAGE=gcr.io/cadvisor/cadvisor:v0.52.1
docker pull -q "$NODE_IMAGE" >/dev/null
docker pull -q "$CADVISOR_IMAGE" >/dev/null
docker rm -f cord-fleet-node cord-fleet-cadvisor >/dev/null 2>&1 || true
docker run -d --name cord-fleet-node --restart unless-stopped --network host --pid host \
  --memory 128m --cpus 0.25 --read-only \
  -v /:/host:ro,rslave "$NODE_IMAGE" \
  --path.rootfs=/host --web.listen-address=127.0.0.1:19100 \
  --collector.filesystem.mount-points-exclude='^/(dev|proc|sys|run|var/lib/docker/.+)($|/)' >/dev/null
# cAdvisor: кто из контейнеров ест ЦП, память, сеть и диск. Сбор раз в 15 с и без меток контейнеров — дёшево на 2 vCPU.
docker run -d --name cord-fleet-cadvisor --restart unless-stopped --network host --privileged \
  --memory 256m --cpus 0.5 \
  -v /:/rootfs:ro -v /var/run:/var/run:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro -v /dev/disk/:/dev/disk:ro \
  --device /dev/kmsg "$CADVISOR_IMAGE" \
  --listen_ip=127.0.0.1 --port=19101 --docker_only=true --housekeeping_interval=15s \
  --store_container_labels=false --whitelisted_container_labels=com.docker.compose.service \
  --disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,process,referenced_memory,resctrl,sched,tcp,udp >/dev/null
sleep 3
for p in 19100 19101; do curl -fsS -o /dev/null -m 5 "http://127.0.0.1:$p/metrics" && echo "агент :$p — ок" || echo "агент :$p — НЕ ОТВЕЧАЕТ"; done
