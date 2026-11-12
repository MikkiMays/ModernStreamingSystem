#!/usr/bin/env bash
# Туннели пульта ко всем рабочим машинам (R208). Запускать на A от root. Порт на A = 191<машина><цель>:
#   цели: 0 — node-exporter (19100), 1 — cAdvisor (19101), 2 — ядро Cord (8080), 4 — метрики шлюза (2019),
#   3 — метрики SFU (6789, пароль метрик LiveKit продукта), 5 — службы Cord (кинозал, музыка; 18100) — у машины продукта.
set -euo pipefail
install -d -m 700 /etc/cord-fleet
machine() { # id ip key prefix [core]
  local id=$1 ip=$2 key=$3 p=$4 core=${5:-}
  # Ядро Cord (цель 2) — только у машины продукта: медиаузел ядра не держит, и проброс в пустой порт был бы вечной
  # целью `down`.
  local forwards="-L 127.0.0.1:${p}0:127.0.0.1:19100 -L 127.0.0.1:${p}1:127.0.0.1:19101 -L 127.0.0.1:${p}3:127.0.0.1:6789 -L 127.0.0.1:${p}4:127.0.0.1:2019"
  [ "$core" = core ] && forwards="$forwards -L 127.0.0.1:${p}2:127.0.0.1:8080 -L 127.0.0.1:${p}5:127.0.0.1:18100"
  cat > /etc/cord-fleet/$id.env <<ENV
HOST=$ip
KEY=$key
FORWARDS=$forwards
ENV
  chmod 600 /etc/cord-fleet/$id.env
}
machine fra 108.165.32.23 /root/.ssh/cord_fra 1911 core
machine msk 157.22.241.114 /root/.ssh/cord_msk 1912
machine hel 152.234.227.199 /root/.ssh/cord_fi 1913
# Цели для VictoriaMetrics (задание `nodes`, file_sd): метки machine/kind/role, у ядра — свой путь метрик.
SCRAPE=${CORD_DIR:-/opt/ModernStreamingSystem}/infra/generated/scrape-nodes
SFU=${CORD_DIR:-/opt/ModernStreamingSystem}/infra/generated/scrape-sfu
install -d "$SCRAPE" "$SFU"
python3 - "$SCRAPE" "$SFU" <<'PY'
import json, sys
from pathlib import Path
out, sfu = Path(sys.argv[1]), Path(sys.argv[2])
for mid, p, title, role, core in (("fra", "1911", "meet · Франкфурт", "product+media", True),
                                  ("msk", "1912", "msk · Москва", "media", False),
                                  ("hel", "1913", "Хельсинки", "media", False)):
    groups = [{"targets": [f"127.0.0.1:{p}{n}"], "labels": {"machine": mid, "title": title, "role": role, "kind": kind}}
              for n, kind in (("0", "node"), ("1", "containers"), ("4", "gateway"))]
    if core:
        groups.append({"targets": [f"127.0.0.1:{p}2"], "labels": {"machine": mid, "title": title, "role": role,
                       "kind": "core", "__metrics_path__": "/actuator/prometheus"}})
        groups.append({"targets": [f"127.0.0.1:{p}5"], "labels": {"machine": mid, "title": title, "role": role,
                       "kind": "services"}})
    (out / f"fleet-{mid}.json").write_text(json.dumps(groups, ensure_ascii=False, indent=1))
    # SFU — отдельным заданием со своим паролем (scrape.yml, nodes-sfu).
    (sfu / f"fleet-{mid}.json").write_text(json.dumps([{"targets": [f"127.0.0.1:{p}3"], "labels": {
        "machine": mid, "title": title, "role": role, "kind": "livekit"}}], ensure_ascii=False, indent=1))
PY
install -m 644 "$(dirname "$0")/cord-fleet-tunnel@.service" /etc/systemd/system/cord-fleet-tunnel@.service
systemctl daemon-reload
for id in fra msk hel; do systemctl enable --now cord-fleet-tunnel@$id >/dev/null 2>&1; systemctl restart cord-fleet-tunnel@$id; done
sleep 4
for id in fra msk hel; do printf '%-4s %s\n' $id "$(systemctl is-active cord-fleet-tunnel@$id)"; done
