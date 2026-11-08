"""Метрики машин и горящие алерты (§8.8) и живой снимок флота (R209, Р-125): VictoriaMetrics и vmalert
профиля `monitoring` на A.

Нет профиля — плашки говорят об этом, служба не падает: любая ошибка источника здесь превращается в
`None`-ряды и строку `error`, а не в отказ всего экрана.

Живой снимок считается **групповыми запросами на весь флот** — один запрос на величину, не на машину:
строки ответа раскладываются по машинам по меткам (`machine="fra"` у туннелей, `job="node"` у A,
`node="hel"` у магистрали). Какие метки у какого вида источника — `kind_selector`.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .machines import Machine

# Что считаем по машине за 5 минут. `{sel}` — метки машины из `Machine.metrics` (например `job="node"`
# для A или `node="msk",role="node"` для медиаузла через магистраль).
QUERIES = {
    "cpu": '1 - avg(rate(node_cpu_seconds_total{{mode="idle",{sel}}}[5m]))',
    "steal": 'avg(rate(node_cpu_seconds_total{{mode="steal",{sel}}}[5m]))',
    "memUsed": '1 - sum(node_memory_MemAvailable_bytes{{{sel}}}) / sum(node_memory_MemTotal_bytes{{{sel}}})',
    "memTotalBytes": 'sum(node_memory_MemTotal_bytes{{{sel}}})',
    "diskFreeBytes": 'min(node_filesystem_avail_bytes{{mountpoint="/",{sel}}})',
    "uplinkMbps": 'sum(rate(node_network_transmit_bytes_total{{device!~"lo|docker.*|veth.*|br-.*",{sel}}}[5m])) * 8 / 1e6',
}

# Метки, по которым строка группового запроса находит свою машину.
GROUP = "machine, job, node, instance, kind, role"
NET = 'device!~"lo|docker.*|veth.*|br-.*"'

# Виды источников на машине → как их подписывает сбор (`infra/generated/scrape-nodes/*.json`, `scrape.yml`).
KINDS = ("node", "containers", "core", "sfu")
TUNNEL_KIND = {"node": "node", "containers": "containers", "core": "core", "sfu": "livekit"}
LOCAL_JOB = {"node": "node", "containers": "cadvisor", "core": "core", "sfu": "livekit"}
BACKBONE_ROLE = {"node": "node", "containers": "containers", "core": "core", "sfu": "livekit"}

# Групповые запросы живого снимка: имя → (вид источника, PromQL с `{g}` вместо списка меток группировки).
LIVE: dict[str, tuple[str, str]] = {
    # Железо и нагрузка машины.
    "cores": ("node", 'count by ({g}) (node_cpu_seconds_total{{mode="idle"}})'),
    "cpu": ("node", '1 - avg by ({g}) (rate(node_cpu_seconds_total{{mode="idle"}}[1m]))'),
    "steal": ("node", 'avg by ({g}) (rate(node_cpu_seconds_total{{mode="steal"}}[1m]))'),
    "load1": ("node", "sum by ({g}) (node_load1)"),
    "memTotalBytes": ("node", "sum by ({g}) (node_memory_MemTotal_bytes)"),
    "memAvailableBytes": ("node", "sum by ({g}) (node_memory_MemAvailable_bytes)"),
    "swapUsedBytes": ("node", "sum by ({g}) (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes)"),
    "diskTotalBytes": ("node", 'min by ({g}) (node_filesystem_size_bytes{{mountpoint="/"}})'),
    "diskFreeBytes": ("node", 'min by ({g}) (node_filesystem_avail_bytes{{mountpoint="/"}})'),
    "netInMbps": ("node", f"sum by ({{g}}) (rate(node_network_receive_bytes_total{{{{{NET}}}}}[1m])) * 8 / 1e6"),
    "netOutMbps": ("node", f"sum by ({{g}}) (rate(node_network_transmit_bytes_total{{{{{NET}}}}}[1m])) * 8 / 1e6"),
    "netErrorsPerSec": (
        "node",
        f"sum by ({{g}}) (rate(node_network_receive_errs_total{{{{{NET}}}}}[5m]) + rate(node_network_transmit_errs_total{{{{{NET}}}}}[5m])"
        f" + rate(node_network_receive_drop_total{{{{{NET}}}}}[5m]) + rate(node_network_transmit_drop_total{{{{{NET}}}}}[5m]))",
    ),
    "bootTime": ("node", "max by ({g}) (node_boot_time_seconds)"),
    "psiCpu": ("node", "avg by ({g}) (rate(node_pressure_cpu_waiting_seconds_total[1m]))"),
    "psiMemory": ("node", "avg by ({g}) (rate(node_pressure_memory_waiting_seconds_total[1m]))"),
    "psiIo": ("node", "avg by ({g}) (rate(node_pressure_io_waiting_seconds_total[1m]))"),
    "uname": ("node", "max by ({g}, release, sysname, exported_machine) (node_uname_info)"),
    "os": ("node", "max by ({g}, pretty_name) (node_os_info)"),
    # Контейнеры (cAdvisor): корневая cgroup `id="/"` без имени — не контейнер.
    "containerCpu": ("containers", 'sum by ({g}, name) (rate(container_cpu_usage_seconds_total{{name!=""}}[1m]))'),
    "containerMem": ("containers", 'sum by ({g}, name) (container_memory_working_set_bytes{{name!=""}})'),
    "containerIn": ("containers", 'sum by ({g}, name) (rate(container_network_receive_bytes_total{{name!=""}}[1m])) * 8 / 1e6'),
    "containerOut": ("containers", 'sum by ({g}, name) (rate(container_network_transmit_bytes_total{{name!=""}}[1m])) * 8 / 1e6'),
    # Ядро Cord.
    "rooms": ("core", "sum by ({g}, state) (cord_rooms_active)"),
    "humans": ("core", "sum by ({g}) (cord_participants_active)"),
    "connected": ("core", "sum by ({g}) (cord_participants_connected)"),
    "bots": ("core", "sum by ({g}) (cord_bots_active)"),
    "screens": ("core", "sum by ({g}) (cord_screens_active)"),
    "integrations": ("core", "sum by ({g}, kind) (cord_integrations_active)"),
    "joinsPerMin": ("core", 'sum by ({g}) (rate(cord_joins_total{{result="ok"}}[5m])) * 60'),
    "failuresPerMin": ("core", 'sum by ({g}) (rate(cord_joins_total{{result!="ok"}}[5m])) * 60'),
    "clientErrorsPerMin": ("core", "sum by ({g}) (rate(cord_client_errors_total[5m])) * 60"),
    "nodeRooms": ("core", "sum by ({g}) (cord_node_rooms)"),
    "nodeParticipants": ("core", "sum by ({g}) (cord_node_participants)"),
    "nodeUp": ("core", "min by ({g}) (cord_node_up)"),
    # SFU.
    "sfuRooms": ("sfu", "sum by ({g}) (livekit_room_total)"),
    "sfuParticipants": ("sfu", "sum by ({g}) (livekit_participant_total)"),
    "sfuMbps": ("sfu", "sum by ({g}, direction) (rate(livekit_packet_bytes[1m])) * 8 / 1e6"),
    "sfuLossPercent": (
        "sfu",
        "sum by ({g}) (rate(livekit_packet_loss_percent_sum[5m])) / sum by ({g}) (rate(livekit_packet_loss_percent_count[5m]))",
    ),
    "sfuRttMs": ("sfu", "sum by ({g}) (rate(livekit_rtt_ms_sum[5m])) / sum by ({g}) (rate(livekit_rtt_ms_count[5m]))"),
}

# У `cord_integrations_active` метка `kind` — вид интеграции, а у сбора по туннелю `kind` — вид источника:
# экспортированная метка становится `exported_kind`. Аналогично `node` у `cord_node_*`.
INTEGRATION_LABELS = ("exported_kind", "kind")
NODE_LABELS = ("exported_node", "node")


def selector(machine: Machine) -> str:
    labels = machine.metrics or {"job": "node"}
    return ",".join(f'{key}="{value}"' for key, value in sorted(labels.items()))


def kind_selector(machine: Machine, kind: str) -> dict[str, str]:
    """Метки рядов вида `kind` у машины: явные `metricsKinds`, иначе — соглашение сбора.

    Туннели (`machine="fra"`) подписывают источники меткой `kind`; A — отдельными `job`; магистраль
    (`node="hel"`) — меткой `role`.
    """
    explicit = machine.metrics_kinds.get(kind)
    if explicit:
        return dict(explicit)
    labels = dict(machine.metrics or {"job": "node"})
    if "machine" in labels:
        labels["kind"] = TUNNEL_KIND[kind]
    elif "node" in labels:
        labels["role"] = BACKBONE_ROLE[kind]
    else:
        labels["job"] = LOCAL_JOB[kind]
    return labels


def matches(labels: dict[str, str], wanted: dict[str, str]) -> bool:
    return all(labels.get(key) == value for key, value in wanted.items())


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


class Metrics:
    def __init__(self, metrics_url: str, alerts_url: str, client: httpx.AsyncClient | None = None) -> None:
        self.metrics_url = metrics_url
        self.alerts_url = alerts_url
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0))

    async def close(self) -> None:
        await self.client.aclose()

    @property
    def enabled(self) -> bool:
        return bool(self.metrics_url)

    async def query(self, promql: str) -> list[dict[str, Any]]:
        """Строки мгновенного запроса: `{"labels": {...}, "value": float|None}`; ошибка — исключение."""
        response = await self.client.get(self.metrics_url + "/api/v1/query", params={"query": promql})
        response.raise_for_status()
        data = response.json()
        rows = []
        for item in data.get("data", {}).get("result", []):
            value = item.get("value") or [None, None]
            rows.append({"labels": dict(item.get("metric", {})), "value": _float(value[1])})
        return rows

    async def machine(self, machine: Machine) -> dict[str, Any]:
        """Ряды машины; `null` — ряда нет; `error` — источник не ответил."""
        result: dict[str, Any] = {key: None for key in QUERIES}
        if not self.metrics_url:
            result["error"] = "Профиль monitoring на A не включён — метрик нет"
            return result
        sel = selector(machine)
        for key, template in QUERIES.items():
            try:
                rows = await self.query(template.format(sel=sel))
            except (httpx.HTTPError, ValueError) as error:
                result["error"] = f"VictoriaMetrics не отвечает: {error.__class__.__name__}"
                return result
            if rows:
                result[key] = rows[0]["value"]
        return result

    async def live(self, machines: list[Machine]) -> dict[str, Any]:
        """Живой снимок флота: по машине — железо, нагрузка, контейнеры, ядро, SFU (§3 admin-analytics.md)."""
        empty = {m.id: self._empty() for m in machines}
        if not self.metrics_url:
            return {"machines": empty, "error": "Профиль monitoring на A не включён — метрик нет"}
        names = list(LIVE)
        results = await asyncio.gather(
            *(self.query(LIVE[name][1].format(g=GROUP)) for name in names), return_exceptions=True
        )
        failed = [name for name, rows in zip(names, results) if isinstance(rows, BaseException)]
        rows_by_name = {name: rows for name, rows in zip(names, results) if not isinstance(rows, BaseException)}
        for machine in machines:
            view = empty[machine.id]
            for name, rows in rows_by_name.items():
                kind = LIVE[name][0]
                wanted = kind_selector(machine, kind)
                mine = [row for row in rows if matches(row["labels"], wanted)]
                if mine:
                    self._fill(view, name, mine)
            self._finish(view)
        error = None
        if len(failed) == len(names):
            error = "VictoriaMetrics не отвечает"
        elif failed:
            error = "Часть рядов не прочитана: " + ", ".join(sorted(failed))
        return {"machines": empty, "error": error}

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {
            "hardware": {
                "cores": None,
                "memTotalBytes": None,
                "diskTotalBytes": None,
                "kernel": None,
                "os": None,
                "arch": None,
                "bootTime": None,
            },
            "load": {
                key: None
                for key in (
                    "cpu",
                    "steal",
                    "load1",
                    "memUsed",
                    "memAvailableBytes",
                    "swapUsedBytes",
                    "diskFreeBytes",
                    "netInMbps",
                    "netOutMbps",
                    "netErrorsPerSec",
                    "psiCpu",
                    "psiMemory",
                    "psiIo",
                )
            },
            "containers": {},
            "core": None,
            "sfu": None,
        }

    @staticmethod
    def _fill(view: dict[str, Any], name: str, rows: list[dict[str, Any]]) -> None:
        first = rows[0]
        value = first["value"]
        hardware, load = view["hardware"], view["load"]
        if name == "cores":
            hardware["cores"] = int(value) if value is not None else None
        elif name in ("memTotalBytes", "diskTotalBytes"):
            hardware[name] = value
        elif name == "bootTime":
            hardware["bootTime"] = value
        elif name == "uname":
            hardware["kernel"] = first["labels"].get("release")
            hardware["arch"] = first["labels"].get("exported_machine") or first["labels"].get("machine")
        elif name == "os":
            hardware["os"] = first["labels"].get("pretty_name")
        elif name in load:
            load[name] = value
        elif name.startswith("container"):
            field = {"containerCpu": "cpu", "containerMem": "memBytes", "containerIn": "inMbps", "containerOut": "outMbps"}[name]
            for row in rows:
                container = view["containers"].setdefault(
                    row["labels"].get("name", "?"), {"cpu": None, "memBytes": None, "inMbps": None, "outMbps": None}
                )
                container[field] = row["value"]
        elif name in ("rooms", "humans", "connected", "bots", "screens", "integrations", "joinsPerMin", "failuresPerMin", "clientErrorsPerMin", "nodeRooms", "nodeParticipants", "nodeUp"):
            core = view["core"] or Metrics._core()
            view["core"] = core
            if name == "rooms":
                for row in rows:
                    core["live" if row["labels"].get("state") == "live" else "waiting"] = row["value"]
            elif name == "integrations":
                for row in rows:
                    kind = next((row["labels"][k] for k in INTEGRATION_LABELS if k in row["labels"]), "other")
                    core["integrations"][kind] = row["value"]
            elif name in ("nodeRooms", "nodeParticipants", "nodeUp"):
                field = {"nodeRooms": "rooms", "nodeParticipants": "participants", "nodeUp": "up"}[name]
                for row in rows:
                    node = next((row["labels"][k] for k in NODE_LABELS if k in row["labels"]), "main")
                    entry = core["nodes"].setdefault(node, {"rooms": None, "participants": None, "up": None})
                    entry[field] = row["value"]
            else:
                core[name] = value
        elif name.startswith("sfu"):
            sfu = view["sfu"] or {"rooms": None, "participants": None, "inMbps": None, "outMbps": None, "lossPercent": None, "rttMs": None}
            view["sfu"] = sfu
            if name == "sfuMbps":
                for row in rows:
                    direction = row["labels"].get("direction")
                    sfu["inMbps" if direction == "incoming" else "outMbps"] = (
                        (sfu["inMbps" if direction == "incoming" else "outMbps"] or 0) + (row["value"] or 0)
                    )
            else:
                sfu[{"sfuRooms": "rooms", "sfuParticipants": "participants", "sfuLossPercent": "lossPercent", "sfuRttMs": "rttMs"}[name]] = value

    @staticmethod
    def _core() -> dict[str, Any]:
        return {
            "live": None,
            "waiting": None,
            "humans": None,
            "connected": None,
            "bots": None,
            "screens": None,
            "integrations": {},
            "joinsPerMin": None,
            "failuresPerMin": None,
            "clientErrorsPerMin": None,
            "nodes": {},
        }

    @staticmethod
    def _finish(view: dict[str, Any]) -> None:
        load, hardware = view["load"], view["hardware"]
        total, available = hardware["memTotalBytes"], load["memAvailableBytes"]
        if total and available is not None:
            load["memUsed"] = max(0.0, 1 - available / total)
        if load["load1"] is not None and hardware["cores"]:
            load["load1"] = load["load1"] / hardware["cores"]
        # Контейнеры — списком, самые тяжёлые по ЦП первыми.
        containers = [{"name": name, **values} for name, values in view["containers"].items()]
        containers.sort(key=lambda c: -(c["cpu"] or 0))
        view["containers"] = containers[:12]
        if view["core"]:
            view["core"]["nodes"] = [{"node": node, **values} for node, values in sorted(view["core"]["nodes"].items())]

    async def alerts(self) -> dict[str, Any]:
        if not self.alerts_url:
            return {"alerts": [], "error": "vmalert не включён — алертов нет"}
        try:
            response = await self.client.get(self.alerts_url + "/api/v1/alerts")
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as error:
            return {"alerts": [], "error": f"vmalert не отвечает: {error.__class__.__name__}"}
        alerts = []
        for item in data.get("data", {}).get("alerts", []):
            labels = item.get("labels", {})
            alerts.append(
                {
                    "name": labels.get("alertname") or item.get("name"),
                    "severity": labels.get("severity"),
                    "node": labels.get("node"),
                    "state": item.get("state"),
                    "activeAt": item.get("activeAt"),
                    "summary": (item.get("annotations") or {}).get("summary"),
                }
            )
        return {"alerts": alerts, "error": None}
