"""Метрики флота (§8.8) и «Флот — live» (R209, Р-125): VictoriaMetrics и vmalert профиля `monitoring` на A.

Нет профиля — плашки говорят об этом, служба не падает: любая ошибка источника превращается в `None`-ряды и
строку `error`, а не в отказ всего экрана.

Живой снимок считается **групповыми запросами на весь флот** — один запрос на величину, не на машину; строки
ответа раскладываются по машинам и видам источников по меткам целей (`infra/monitoring/scrape.yml`):

- удалённые машины (туннели, `job="nodes"`): `machine="fra"`, вид — `kind="node|containers|core|gateway"`;
- эта машина (A): вид — по `job` (`node`, `cadvisor`, `core`, `livekit`, `gateway`); с R212 у её целей ещё
  `machine="a", kind="local"`, а до неё метки `machine` нет вовсе — такие строки принадлежат машине пульта
  (`Machine.local`).

Метка цели вытесняет одноимённую метку ряда в `exported_*`: у `cord_integrations_active` вид интеграции —
`exported_kind` (или `kind` у A до R212), у `node_uname_info` архитектура — `exported_machine`.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from .machines import Machine

NET = 'device!~"lo|docker.*|veth.*|br-.*"'
DISK = 'device!~"loop.*|ram.*|dm-.*"'
GROUP = "machine, job, kind"

# Вид источника по `job` у целей этой машины и по `kind` у целей туннелей.
LOCAL_JOBS = {"node": "node", "cadvisor": "containers", "core": "core", "livekit": "sfu", "gateway": "gateway"}
TUNNEL_KINDS = {"node": "node", "containers": "containers", "core": "core", "gateway": "gateway", "livekit": "sfu"}
SOURCES = ("node", "containers", "core", "sfu", "gateway")
LOCAL = "@local"

# Групповые запросы живого снимка: имя → (вид источника, PromQL; `{g}` — метки группировки).
LIVE: dict[str, tuple[str, str]] = {
    # Есть ли источник и отвечает ли он (`up` цели): 1 — да, 0 — молчит.
    "up": ("*", "max by ({g}) (up)"),
    # Железо.
    "cores": ("node", 'count by ({g}) (node_cpu_seconds_total{{mode="idle"}})'),
    "memTotalBytes": ("node", "sum by ({g}) (node_memory_MemTotal_bytes)"),
    "diskTotalBytes": ("node", 'min by ({g}) (node_filesystem_size_bytes{{mountpoint="/"}})'),
    "bootTime": ("node", "max by ({g}) (node_boot_time_seconds)"),
    "uname": ("node", "max by ({g}, release, nodename, exported_machine) (node_uname_info)"),
    "os": ("node", "max by ({g}, pretty_name) (node_os_info)"),
    "dmi": ("node", "max by ({g}, product_name, system_vendor) (node_dmi_info)"),
    # Нагрузка машины за минуту.
    "cpu": ("node", '1 - avg by ({g}) (rate(node_cpu_seconds_total{{mode="idle"}}[1m]))'),
    "steal": ("node", 'avg by ({g}) (rate(node_cpu_seconds_total{{mode="steal"}}[1m]))'),
    "iowait": ("node", 'avg by ({g}) (rate(node_cpu_seconds_total{{mode="iowait"}}[1m]))'),
    "load1": ("node", "sum by ({g}) (node_load1)"),
    "memAvailableBytes": ("node", "sum by ({g}) (node_memory_MemAvailable_bytes)"),
    "swapUsedBytes": ("node", "sum by ({g}) (node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes)"),
    "diskFreeBytes": ("node", 'min by ({g}) (node_filesystem_avail_bytes{{mountpoint="/"}})'),
    "diskReadMBps": ("node", f"sum by ({{g}}) (rate(node_disk_read_bytes_total{{{{{DISK}}}}}[1m])) / 1e6"),
    "diskWriteMBps": ("node", f"sum by ({{g}}) (rate(node_disk_written_bytes_total{{{{{DISK}}}}}[1m])) / 1e6"),
    "netInMbps": ("node", f"sum by ({{g}}) (rate(node_network_receive_bytes_total{{{{{NET}}}}}[1m])) * 8 / 1e6"),
    "netOutMbps": ("node", f"sum by ({{g}}) (rate(node_network_transmit_bytes_total{{{{{NET}}}}}[1m])) * 8 / 1e6"),
    "netErrorsPerSec": (
        "node",
        f"sum by ({{g}}) (rate(node_network_receive_errs_total{{{{{NET}}}}}[5m]) + rate(node_network_transmit_errs_total{{{{{NET}}}}}[5m])"
        f" + rate(node_network_receive_drop_total{{{{{NET}}}}}[5m]) + rate(node_network_transmit_drop_total{{{{{NET}}}}}[5m]))",
    ),
    "tcpEstablished": ("node", "sum by ({g}) (node_netstat_Tcp_CurrEstab)"),
    "psiCpu": ("node", "avg by ({g}) (rate(node_pressure_cpu_waiting_seconds_total[1m]))"),
    "psiMemory": ("node", "avg by ({g}) (rate(node_pressure_memory_waiting_seconds_total[1m]))"),
    "psiIo": ("node", "avg by ({g}) (rate(node_pressure_io_waiting_seconds_total[1m]))"),
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
    "integrations": ("core", "sum by ({g}, exported_kind) (cord_integrations_active)"),
    "joinsPerMin": ("core", 'sum by ({g}) (rate(cord_joins_total{{result="ok"}}[5m])) * 60'),
    "failuresPerMin": ("core", 'sum by ({g}) (rate(cord_joins_total{{result!="ok"}}[5m])) * 60'),
    "clientErrorsPerMin": ("core", "sum by ({g}) (rate(cord_client_errors_total[5m])) * 60"),
    "loadLevel": ("core", "max by ({g}) (cord_server_load_level)"),
    "loadShare": ("core", "max by ({g}, exported_kind) (cord_server_load_share)"),
    "nodeRooms": ("core", "sum by ({g}, node) (cord_node_rooms)"),
    "nodeParticipants": ("core", "sum by ({g}, node) (cord_node_participants)"),
    "nodeUp": ("core", "min by ({g}, node) (cord_node_up)"),
    "version": ("core", "max by ({g}, version) (cord_build_info)"),
    # SFU.
    "sfuRooms": ("sfu", "sum by ({g}) (livekit_room_total)"),
    "sfuParticipants": ("sfu", "sum by ({g}) (livekit_participant_total)"),
    "sfuMbps": ("sfu", "sum by ({g}, direction) (rate(livekit_packet_bytes[1m])) * 8 / 1e6"),
    "sfuLossPercent": (
        "sfu",
        "sum by ({g}) (rate(livekit_packet_loss_percent_sum[5m])) / sum by ({g}) (rate(livekit_packet_loss_percent_count[5m]))",
    ),
    "sfuRttMs": ("sfu", "sum by ({g}) (rate(livekit_rtt_ms_sum[5m])) / sum by ({g}) (rate(livekit_rtt_ms_count[5m]))"),
    # Шлюз (Caddy).
    "gatewayRps": ("gateway", "sum by ({g}) (rate(caddy_http_requests_total[1m]))"),
    "gatewayInFlight": ("gateway", "sum by ({g}) (caddy_http_requests_in_flight)"),
    "gatewayErrorsPerSec": ("gateway", "sum by ({g}) (rate(caddy_http_request_errors_total[5m]))"),
}

# Ряды истории (последние минуты) для графиков на карточке машины: имя → (вид, PromQL).
HISTORY: dict[str, tuple[str, str]] = {
    "cpu": LIVE["cpu"],
    "netOutMbps": LIVE["netOutMbps"],
    "netInMbps": LIVE["netInMbps"],
    "connected": LIVE["connected"],
}

# Сколько держать снимок: несколько вкладок пульта не множат запросы к VictoriaMetrics.
SNAPSHOT_TTL = 2.0


def source_of(labels: dict[str, str]) -> str | None:
    """Вид источника строки: по `kind` у туннелей, по `job` у целей этой машины."""
    job = labels.get("job", "")
    if job == "nodes":
        return TUNNEL_KINDS.get(labels.get("kind", ""))
    return LOCAL_JOBS.get(job)


def machine_label(labels: dict[str, str]) -> str:
    """Метка машины строки; у целей этой машины до R212 метки нет — `@local`."""
    if labels.get("job") == "nodes" or labels.get("kind") == "local":
        return labels.get("machine") or LOCAL
    return LOCAL


def owns(machine: Machine, label: str) -> bool:
    """Строка с меткой `label` — этой машины: её `metrics.machine` или «эта машина» без метки."""
    wanted = (machine.metrics or {}).get("machine")
    if label == LOCAL:
        return machine.local
    return wanted is not None and wanted == label


def selector(machine: Machine) -> str:
    labels = machine.metrics or {"job": "node"}
    return ",".join(f'{key}="{value}"' for key, value in sorted(labels.items()))


def _float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _local_metric_label(labels: dict[str, str], name: str) -> str | None:
    """Метка ряда, которую цель вытеснила в `exported_<name>`; у этой машины до R212 — сама `name`."""
    if f"exported_{name}" in labels:
        return labels[f"exported_{name}"]
    before_r212 = labels.get("job") != "nodes" and labels.get("kind") != "local"
    return labels.get(name) if before_r212 else None


class Metrics:
    def __init__(self, metrics_url: str, alerts_url: str, client: httpx.AsyncClient | None = None) -> None:
        self.metrics_url = metrics_url
        self.alerts_url = alerts_url
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0))
        self._snapshot: tuple[float, tuple[str, ...], dict[str, Any]] | None = None
        self._lock = asyncio.Lock()

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

    async def query_range(self, promql: str, start: float, end: float, step: int) -> list[dict[str, Any]]:
        """Строки запроса за отрезок: `{"labels": {...}, "values": [[t, v], …]}`."""
        response = await self.client.get(
            self.metrics_url + "/api/v1/query_range",
            params={"query": promql, "start": int(start), "end": int(end), "step": step},
        )
        response.raise_for_status()
        rows = []
        for item in response.json().get("data", {}).get("result", []):
            values = [[int(float(t)), _float(v)] for t, v in item.get("values", [])]
            rows.append({"labels": dict(item.get("metric", {})), "values": values})
        return rows

    # ── Обзор: четыре ряда на машину ─────────────────────────────────────────────────────────────
    async def machines(self, machines: list[Machine]) -> dict[str, dict[str, Any]]:
        """Короткие ряды машин для обзора — из того же живого снимка."""
        snapshot = await self.live(machines)
        out: dict[str, dict[str, Any]] = {}
        for machine in machines:
            view = snapshot["machines"].get(machine.id) or self._empty()
            load, hardware = view["load"], view["hardware"]
            entry: dict[str, Any] = {
                "cpu": load["cpu"],
                "steal": load["steal"],
                "memUsed": load["memUsed"],
                "memTotalBytes": hardware["memTotalBytes"],
                "diskFreeBytes": load["diskFreeBytes"],
                "uplinkMbps": load["netOutMbps"],
            }
            if snapshot["error"] and all(value is None for value in entry.values()):
                entry["error"] = snapshot["error"]
            out[machine.id] = entry
        return out

    async def machine(self, machine: Machine) -> dict[str, Any]:
        return (await self.machines([machine]))[machine.id]

    # ── Живой снимок ─────────────────────────────────────────────────────────────────────────────
    async def live(self, machines: list[Machine]) -> dict[str, Any]:
        """Живой снимок флота: по машине — железо, нагрузка, контейнеры, ядро, SFU, шлюз (Р-125)."""
        ids = tuple(m.id for m in machines)
        async with self._lock:
            cached = self._snapshot
            if cached and cached[1] == ids and time.monotonic() - cached[0] < SNAPSHOT_TTL:
                return cached[2]
            snapshot = await self._live(machines)
            self._snapshot = (time.monotonic(), ids, snapshot)
            return snapshot

    async def _live(self, machines: list[Machine]) -> dict[str, Any]:
        views = {m.id: self._empty() for m in machines}
        if not self.metrics_url:
            return {"machines": views, "error": "Профиль monitoring на A не включён — метрик нет"}
        names = list(LIVE)
        results = await asyncio.gather(
            *(self.query(LIVE[name][1].format(g=GROUP)) for name in names), return_exceptions=True
        )
        failed = [name for name, rows in zip(names, results) if isinstance(rows, BaseException)]
        for name, rows in zip(names, results):
            if isinstance(rows, BaseException):
                continue
            wanted = LIVE[name][0]
            for machine in machines:
                mine = [
                    row
                    for row in rows
                    if owns(machine, machine_label(row["labels"]))
                    and (wanted == "*" or source_of(row["labels"]) == wanted)
                ]
                if mine:
                    self._fill(views[machine.id], name, mine)
        for view in views.values():
            self._finish(view)
        error = None
        if len(failed) == len(names):
            error = "VictoriaMetrics не отвечает"
        elif failed:
            error = "Часть рядов не прочитана: " + ", ".join(sorted(failed))
        return {"machines": views, "error": error}

    async def history(self, machines: list[Machine], minutes: int = 30) -> dict[str, Any]:
        """Ряды за последние `minutes` минут по машинам: ЦП, сеть, люди на связи — для графиков."""
        out: dict[str, Any] = {m.id: {name: [] for name in HISTORY} for m in machines}
        if not self.metrics_url:
            return {"machines": out, "error": "Профиль monitoring на A не включён — метрик нет", "step": None}
        end = time.time()
        start = end - minutes * 60
        step = max(15, minutes * 60 // 120)
        names = list(HISTORY)
        results = await asyncio.gather(
            *(self.query_range(HISTORY[name][1].format(g=GROUP), start, end, step) for name in names),
            return_exceptions=True,
        )
        failed = []
        for name, rows in zip(names, results):
            if isinstance(rows, BaseException):
                failed.append(name)
                continue
            wanted = HISTORY[name][0]
            for machine in machines:
                for row in rows:
                    if owns(machine, machine_label(row["labels"])) and source_of(row["labels"]) == wanted:
                        out[machine.id][name] = row["values"]
                        break
        error = "Часть рядов не прочитана: " + ", ".join(failed) if failed else None
        return {"machines": out, "error": error, "step": step}

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {
            "sources": {source: None for source in SOURCES},
            "hardware": {
                "cores": None,
                "memTotalBytes": None,
                "diskTotalBytes": None,
                "kernel": None,
                "os": None,
                "arch": None,
                "hostname": None,
                "virtualization": None,
                "bootTime": None,
            },
            "load": {
                key: None
                for key in (
                    "cpu",
                    "steal",
                    "iowait",
                    "load1",
                    "memUsed",
                    "memAvailableBytes",
                    "swapUsedBytes",
                    "diskUsed",
                    "diskFreeBytes",
                    "diskReadMBps",
                    "diskWriteMBps",
                    "netInMbps",
                    "netOutMbps",
                    "netErrorsPerSec",
                    "tcpEstablished",
                    "psiCpu",
                    "psiMemory",
                    "psiIo",
                )
            },
            "containers": {},
            "core": None,
            "sfu": None,
            "gateway": None,
        }

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
            "loadLevel": None,
            "loadShare": {},
            "version": None,
            "nodes": {},
        }

    @staticmethod
    def _fill(view: dict[str, Any], name: str, rows: list[dict[str, Any]]) -> None:
        first = rows[0]
        value = first["value"]
        labels = first["labels"]
        hardware, load = view["hardware"], view["load"]
        if name == "up":
            for row in rows:
                source = source_of(row["labels"])
                if source in view["sources"]:
                    up = bool(row["value"])
                    view["sources"][source] = up or bool(view["sources"][source])
        elif name == "cores":
            hardware["cores"] = int(value) if value is not None else None
        elif name in ("memTotalBytes", "diskTotalBytes", "bootTime"):
            hardware[name] = value
        elif name == "uname":
            hardware["kernel"] = labels.get("release")
            hardware["hostname"] = labels.get("nodename")
            hardware["arch"] = _local_metric_label(labels, "machine")
        elif name == "os":
            hardware["os"] = labels.get("pretty_name")
        elif name == "dmi":
            product, vendor = labels.get("product_name"), labels.get("system_vendor")
            hardware["virtualization"] = " · ".join(part for part in (product, vendor) if part) or None
        elif name in load:
            load[name] = value
        elif name.startswith("container"):
            field = {"containerCpu": "cpu", "containerMem": "memBytes", "containerIn": "inMbps", "containerOut": "outMbps"}[name]
            for row in rows:
                container = view["containers"].setdefault(
                    row["labels"].get("name", "?"), {"cpu": None, "memBytes": None, "inMbps": None, "outMbps": None}
                )
                container[field] = row["value"]
        elif name.startswith("sfu"):
            sfu = view["sfu"] or {"rooms": None, "participants": None, "inMbps": None, "outMbps": None, "lossPercent": None, "rttMs": None}
            view["sfu"] = sfu
            if name == "sfuMbps":
                for row in rows:
                    key = "inMbps" if row["labels"].get("direction") == "incoming" else "outMbps"
                    sfu[key] = (sfu[key] or 0) + (row["value"] or 0)
            else:
                sfu[{"sfuRooms": "rooms", "sfuParticipants": "participants", "sfuLossPercent": "lossPercent", "sfuRttMs": "rttMs"}[name]] = value
        elif name.startswith("gateway"):
            gateway = view["gateway"] or {"rps": None, "inFlight": None, "errorsPerSec": None}
            view["gateway"] = gateway
            gateway[{"gatewayRps": "rps", "gatewayInFlight": "inFlight", "gatewayErrorsPerSec": "errorsPerSec"}[name]] = value
        else:
            core = view["core"] or Metrics._core()
            view["core"] = core
            if name == "rooms":
                for row in rows:
                    core["live" if row["labels"].get("state") == "live" else "waiting"] = row["value"]
            elif name in ("integrations", "loadShare"):
                target = core["integrations" if name == "integrations" else "loadShare"]
                for row in rows:
                    kind = _local_metric_label(row["labels"], "kind") or "other"
                    target[kind] = row["value"]
            elif name in ("nodeRooms", "nodeParticipants", "nodeUp"):
                field = {"nodeRooms": "rooms", "nodeParticipants": "participants", "nodeUp": "up"}[name]
                for row in rows:
                    node = row["labels"].get("node") or "main"
                    entry = core["nodes"].setdefault(node, {"rooms": None, "participants": None, "up": None})
                    entry[field] = row["value"]
            elif name == "version":
                core["version"] = labels.get("version")
            elif name in core:
                core[name] = value

    @staticmethod
    def _finish(view: dict[str, Any]) -> None:
        load, hardware = view["load"], view["hardware"]
        total, available = hardware["memTotalBytes"], load["memAvailableBytes"]
        if total and available is not None:
            load["memUsed"] = max(0.0, min(1.0, 1 - available / total))
        disk, free = hardware["diskTotalBytes"], load["diskFreeBytes"]
        if disk and free is not None:
            load["diskUsed"] = max(0.0, min(1.0, 1 - free / disk))
        if load["load1"] is not None and hardware["cores"]:
            load["load1"] = load["load1"] / hardware["cores"]
        # Контейнеры — списком, самые тяжёлые по ЦП первыми.
        containers = [{"name": name, **values} for name, values in view["containers"].items()]
        containers.sort(key=lambda c: (-(c["cpu"] or 0), c["name"]))
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
                    "node": labels.get("node") or labels.get("machine"),
                    "state": item.get("state"),
                    "activeAt": item.get("activeAt"),
                    "summary": (item.get("annotations") or {}).get("summary"),
                }
            )
        return {"alerts": alerts, "error": None}
