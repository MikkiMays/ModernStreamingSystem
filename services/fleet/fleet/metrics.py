"""Метрики машин и горящие алерты (§8.8): VictoriaMetrics и vmalert профиля `monitoring` на A.

Нет профиля — плашки говорят об этом, служба не падает: любая ошибка источника здесь превращается в
`None`-ряды и строку `error`, а не в отказ всего экрана.
"""

from __future__ import annotations

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


def selector(machine: Machine) -> str:
    labels = machine.metrics or {"job": "node"}
    return ",".join(f'{key}="{value}"' for key, value in sorted(labels.items()))


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

    async def machine(self, machine: Machine) -> dict[str, Any]:
        """Ряды машины; `null` — ряда нет; `error` — источник не ответил."""
        result: dict[str, Any] = {key: None for key in QUERIES}
        if not self.metrics_url:
            result["error"] = "Профиль monitoring на A не включён — метрик нет"
            return result
        sel = selector(machine)
        for key, template in QUERIES.items():
            try:
                response = await self.client.get(self.metrics_url + "/api/v1/query", params={"query": template.format(sel=sel)})
                response.raise_for_status()
                data = response.json()
            except (httpx.HTTPError, ValueError) as error:
                result["error"] = f"VictoriaMetrics не отвечает: {error.__class__.__name__}"
                return result
            rows = data.get("data", {}).get("result", [])
            if rows:
                try:
                    result[key] = float(rows[0]["value"][1])
                except (KeyError, IndexError, ValueError, TypeError):
                    result[key] = None
        return result

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
