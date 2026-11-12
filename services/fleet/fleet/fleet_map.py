"""Карта флота и состояние среды (R240, Р-148…Р-150; `docs/architecture/admin-console-v2.md` §4–§5).

КАРТА. Все машины и все их контейнеры одним ответом: главный экран пульта рисует из него вложенные прямоугольники
«машина → контейнер» и проваливается в них без нового запроса. Контейнеры — cAdvisor (имя, служба compose, образ,
ЦП, память и её предел, диск, время запуска), машина — тот же живой снимок, что у «Флот — live».

СВОИ И СОСЕДИ. На общих машинах cAdvisor видит весь Docker хоста. Контейнеры Cord узнаются по имени
(`modern-streaming-*`, `cord-*`); остальные помечены `neighbour` — пульт собирает их в одну плитку «соседи»: видно,
сколько машины они занимают, но рычагов к ним нет.

СЕТЬ. Контейнеры Cord работают на сети хоста, и счётчики сети cAdvisor у них общие — у каждого одно и то же число.
Поэтому трафик контейнера берётся только там, где его считает сама служба (SFU); у остальных — `None`, а не
одинаковая выдумка.

ЛЮДИ ПО УЗЛАМ. Встречи и люди на медиаузле — из рядов ядра среды `cord_node_rooms` и `cord_node_participants` по
`nodeId` машины, а не из списка встреч: поля узла в нём нет, и прежний обзор всегда показывал ноль.

СОСТОЯНИЕ СРЕДЫ. Одно слово и одна причина на среду («продукт», «стенд») — считается здесь, а не тремя способами в
экранах. Служебные оповещения (`severity: none|info`, вечный `Watchdog`) в него не входят; `page` — сбой, `warn` —
внимание. Среды не складываются: оповещение относится к среде своей машины, без машины — к стенду (на нём стоит
сам мониторинг).
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any

from .machines import Machine
from .metrics import GROUP, LIVE, Metrics, machine_label, owns, source_of

OURS = re.compile(r"^(modern-streaming|cord)[-_]")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
SERVICE = "container_label_com_docker_compose_service"
BY = f"{GROUP}, name, image, {SERVICE}"

# Групповые запросы контейнеров: поле → PromQL. Корневая cgroup и безымянные — не контейнеры.
CONTAINERS: dict[str, str] = {
    "cpu": f'sum by ({BY}) (rate(container_cpu_usage_seconds_total{{name!=""}}[1m]))',
    "memBytes": f'sum by ({BY}) (container_memory_working_set_bytes{{name!=""}})',
    "memLimitBytes": f'max by ({BY}) (container_spec_memory_limit_bytes{{name!=""}})',
    "diskBytes": f'sum by ({BY}) (container_fs_usage_bytes{{name!=""}})',
    "startedAt": f'max by ({BY}) (container_start_time_seconds{{name!=""}})',
}

# Ряды провала в машину: имя → (вид источника, PromQL).
MACHINE_HISTORY: dict[str, tuple[str, str]] = {
    "cpu": LIVE["cpu"],
    "steal": LIVE["steal"],
    "memUsed": (
        "node",
        "1 - sum by ({g}) (node_memory_MemAvailable_bytes) / sum by ({g}) (node_memory_MemTotal_bytes)",
    ),
    "netOutMbps": LIVE["netOutMbps"],
    "netInMbps": LIVE["netInMbps"],
}

SNAPSHOT_TTL = 2.0
LEVELS = {"ok": 0, "warn": 1, "bad": 2}
SEVERITY = {"page": "bad", "critical": "bad", "warn": "warn", "warning": "warn"}


def environment(machine: Machine) -> str:
    """Среда машины: стенд разработки с пультом или продукт. Числа сред не складываются (Р-149)."""
    return "dev" if machine.role == "dev+admin" else "product"


def group_of(name: str) -> str:
    return "cord" if OURS.match(name) else "neighbour"


def short_image(image: str) -> str:
    """`registry/repo:tag@sha256:…` → `repo:tag`: в плитке читается имя, а не адрес реестра."""
    bare = image.split("@", 1)[0]
    return bare.rsplit("/", 1)[-1] if "/" in bare else bare


def _ratio(part: float | None, whole: float | None) -> float | None:
    if part is None or not whole:
        return None
    return max(0.0, min(1.0, part / whole))


class FleetMap:
    def __init__(self, metrics: Metrics) -> None:
        self.metrics = metrics
        self._snapshot: tuple[float, tuple[str, ...], dict[str, Any]] | None = None
        self._lock = asyncio.Lock()

    async def snapshot(self, machines: list[Machine]) -> dict[str, Any]:
        ids = tuple(m.id for m in machines)
        async with self._lock:
            cached = self._snapshot
            if cached and cached[1] == ids and time.monotonic() - cached[0] < SNAPSHOT_TTL:
                return cached[2]
            built = await self._build(machines)
            self._snapshot = (time.monotonic(), ids, built)
            return built

    async def _build(self, machines: list[Machine]) -> dict[str, Any]:
        live = await self.metrics.live(machines)
        fields = list(CONTAINERS)
        results: list[Any] = [None] * len(fields)
        if self.metrics.enabled:
            results = await asyncio.gather(
                *(self.metrics.query(CONTAINERS[field]) for field in fields), return_exceptions=True
            )
        failed = [field for field, rows in zip(fields, results) if isinstance(rows, BaseException)]
        views = []
        for machine in machines:
            base = live["machines"][machine.id]
            hardware, load = base["hardware"], base["load"]
            containers: dict[str, dict[str, Any]] = {}
            for field, rows in zip(fields, results):
                if not rows or isinstance(rows, BaseException):
                    continue
                for row in rows:
                    labels = row["labels"]
                    if source_of(labels) != "containers" or not owns(machine, machine_label(labels)):
                        continue
                    name = labels.get("name", "")
                    entry = containers.setdefault(
                        name,
                        {
                            "name": name,
                            "service": labels.get(SERVICE) or None,
                            "image": short_image(labels.get("image", "")) or None,
                            "group": group_of(name),
                            "cpu": None,
                            "memBytes": None,
                            "memLimitBytes": None,
                            "diskBytes": None,
                            "startedAt": None,
                            "netInMbps": None,
                            "netOutMbps": None,
                        },
                    )
                    entry[field] = row["value"]
            total_memory = hardware["memTotalBytes"]
            for entry in containers.values():
                limit = entry["memLimitBytes"]
                # Предела нет — cAdvisor отдаёт 0 или число больше памяти машины: тогда доля считается от машины.
                if not limit or (total_memory and limit > total_memory):
                    entry["memLimitBytes"] = limit = None
                entry["cpuShare"] = _ratio(entry["cpu"], hardware["cores"])
                entry["memShare"] = _ratio(entry["memBytes"], limit or total_memory)
                if entry["service"] == "livekit" and base["sfu"]:
                    entry["netInMbps"], entry["netOutMbps"] = base["sfu"]["inMbps"], base["sfu"]["outMbps"]
            ordered = sorted(containers.values(), key=lambda c: (c["group"] != "cord", -(c["memBytes"] or 0), c["name"]))
            neighbours = [c for c in ordered if c["group"] == "neighbour"]
            views.append(
                {
                    "id": machine.id,
                    "title": machine.title or machine.id,
                    "role": machine.role,
                    "environment": environment(machine),
                    "nodeId": machine.node_id or None,
                    "host": machine.host,
                    "online": base["sources"]["node"],
                    "sources": base["sources"],
                    "version": (base["core"] or {}).get("version"),
                    "hardware": {key: hardware[key] for key in ("cores", "memTotalBytes", "diskTotalBytes", "bootTime")},
                    "load": {
                        key: load[key] for key in ("cpu", "steal", "memUsed", "diskUsed", "netInMbps", "netOutMbps")
                    },
                    "meetings": {"live": None, "people": None},
                    "containers": ordered,
                    "neighbours": {
                        "count": len(neighbours),
                        "cpu": sum(c["cpu"] or 0 for c in neighbours) if neighbours else None,
                        "memBytes": sum(c["memBytes"] or 0 for c in neighbours) if neighbours else None,
                    },
                }
            )
        self._place_meetings(machines, live, views)
        error = live["error"]
        if failed and not error:
            error = "Часть рядов контейнеров не прочитана: " + ", ".join(sorted(failed))
        return {"serverTime": int(time.time()), "error": error, "machines": views}

    @staticmethod
    def _place_meetings(machines: list[Machine], live: dict[str, Any], views: list[dict[str, Any]]) -> None:
        """Встречи и люди — на ту машину, где стоит их медиаузел (по рядам ядра своей среды)."""
        by_id = {view["id"]: view for view in views}
        for env in ("product", "dev"):
            members = [m for m in machines if environment(m) == env]
            cores = [m for m in members if live["machines"][m.id]["core"]]
            for core_machine in cores:
                core = live["machines"][core_machine.id]["core"]
                nodes = {entry["node"]: entry for entry in core["nodes"]}
                placed = False
                for member in members:
                    entry = nodes.get(member.node_id) if member.node_id else None
                    if entry and (entry["rooms"] is not None or entry["participants"] is not None):
                        by_id[member.id]["meetings"] = {
                            "live": int(entry["rooms"] or 0),
                            "people": int(entry["participants"] or 0),
                        }
                        placed = True
                # Ядро без реестра узлов (одна машина) — все встречи на нём самом.
                if not placed and (core["live"] is not None or core["connected"] is not None):
                    by_id[core_machine.id]["meetings"] = {
                        "live": int(core["live"] or 0),
                        "people": int(core["connected"] or 0),
                    }

    async def history(self, machine: Machine, container: str | None, minutes: int) -> dict[str, Any]:
        """Ряды провала: машины (ЦП, steal, память, сеть) или одного её контейнера (ЦП, память)."""
        if container is not None and not CONTAINER_NAME.match(container):
            raise ValueError("имя контейнера")
        if container is None:
            queries = {name: (kind, promql.format(g=GROUP)) for name, (kind, promql) in MACHINE_HISTORY.items()}
        else:
            match = f'{{name="{container}"}}'
            queries = {
                "cpu": ("containers", f"sum by ({GROUP}) (rate(container_cpu_usage_seconds_total{match}[1m]))"),
                "memBytes": ("containers", f"sum by ({GROUP}) (container_memory_working_set_bytes{match})"),
            }
        series: dict[str, list[list[Any]]] = {name: [] for name in queries}
        if not self.metrics.enabled:
            return {"series": series, "step": None, "error": "Профиль monitoring на A не включён — метрик нет"}
        end = time.time()
        step = max(15, minutes * 60 // 120)
        names = list(queries)
        results = await asyncio.gather(
            *(self.metrics.query_range(queries[name][1], end - minutes * 60, end, step) for name in names),
            return_exceptions=True,
        )
        failed = []
        for name, rows in zip(names, results):
            if isinstance(rows, BaseException):
                failed.append(name)
                continue
            for row in rows:
                if source_of(row["labels"]) == queries[name][0] and owns(machine, machine_label(row["labels"])):
                    series[name] = row["values"]
                    break
        return {
            "series": series,
            "step": step,
            "error": "Часть рядов не прочитана: " + ", ".join(failed) if failed else None,
        }


def environment_state(
    machines: list[Machine],
    live: dict[str, Any],
    alerts: dict[str, Any],
    nows: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    """Состояние каждой среды: уровень (`ok`, `warn`, `bad`), причина и перечень того, из чего он сложился."""
    # Метка оповещения — прежде всего метка рядов машины (`machine` в VictoriaMetrics), затем её имя в пульте и
    # только потом узел: у стенда и у продукта узел управления зовётся одинаково (`fra`).
    by_label: dict[str, Machine] = {}
    for label_of in (lambda m: (m.metrics or {}).get("machine"), lambda m: m.id, lambda m: m.node_id):
        for machine in machines:
            label = label_of(machine)
            if label:
                by_label.setdefault(label, machine)
    problems: dict[str, list[dict[str, Any]]] = {"product": [], "dev": []}

    def add(env: str, level: str, kind: str, summary: str, machine: Machine | None = None, since: str | None = None):
        problems[env].append(
            {"level": level, "kind": kind, "summary": summary, "machine": machine.id if machine else None, "since": since}
        )

    for machine in machines:
        env, title = environment(machine), machine.title or machine.id
        box = nows.get(machine.id)
        if box is not None and box.get("error"):
            add(env, "bad", "core", f"Ядро на {title} не отвечает пульту", machine)
        if live["machines"][machine.id]["sources"]["node"] is False:
            add(env, "warn", "metrics", f"Метрики машины {title} не приходят", machine)
    for alert in alerts.get("alerts", []):
        level = SEVERITY.get(str(alert.get("severity") or "").lower())
        if not level or alert.get("state") != "firing":
            continue
        machine = by_label.get(alert.get("node") or "")
        add(
            environment(machine) if machine else "dev",
            level,
            "alert",
            alert.get("summary") or alert.get("name") or "Оповещение",
            machine,
            alert.get("activeAt"),
        )
    out: dict[str, Any] = {}
    for env, found in problems.items():
        members = [m for m in machines if environment(m) == env]
        found.sort(key=lambda p: (-LEVELS[p["level"]], p["since"] or "~"))
        worst = found[0] if found else None
        out[env] = {
            "level": worst["level"] if worst else "ok",
            "reason": worst["summary"] if worst else None,
            "since": worst["since"] if worst else None,
            "problems": found,
            "machines": len(members),
            "online": sum(1 for m in members if live["machines"][m.id]["sources"]["node"]),
        }
    return out
