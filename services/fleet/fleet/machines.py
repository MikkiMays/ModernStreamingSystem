"""Машины флота (§6.1): кто есть, какую роль играет, где у неё установка и как к ней ходить.

Источник — `FLEET_MACHINES`: JSON прямо в переменной или путь к файлу. Учётные данные ядра машины — не в
JSON, а в `FLEET_CORE_<ID>` (`password:…` для стенда, `key:…` для продукта — Р-115), чтобы список машин
можно было показывать и хранить, не раскрывая секретов.

    [{"id": "a", "role": "dev+admin", "host": "108.165.32.75", "installDir": "/opt/ModernStreamingSystem",
      "core": {"url": "http://127.0.0.1:8080"}, "nodeId": "fra", "registry": "/nodes/registry.json"},
     {"id": "meet", "role": "product-core", "host": "108.165.32.23", "ssh": "root@108.165.32.23",
      "sshKey": "/keys/cord_fra", "installDir": "/opt/meet/ModernStreamingSystem",
      "core": {"url": "http://127.0.0.1:28080"}, "nodeId": "fra", "product": "cordcam.ru"}]
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import MACHINE_UNKNOWN, Problem

ID = re.compile(r"^[a-z][a-z0-9-]{0,15}$")
ROLES = ("dev+admin", "product-core", "media-node")


@dataclass(frozen=True)
class Core:
    url: str
    credential: str = ""  # `password:<…>` или `key:<…>`; пусто — ядро только показывается как адрес

    @property
    def kind(self) -> str:
        return self.credential.split(":", 1)[0] if ":" in self.credential else ""

    @property
    def secret(self) -> str:
        return self.credential.split(":", 1)[1] if ":" in self.credential else ""


@dataclass(frozen=True)
class Machine:
    id: str
    role: str
    host: str
    install_dir: str
    ssh: str = ""
    ssh_key: str = ""
    node_id: str = ""
    product: str = ""
    core: Core | None = None
    registry: str = ""  # путь к registry.json этой машины, если он читается с A напрямую
    title: str = ""
    metrics: dict[str, str] = field(default_factory=dict)  # метки рядов VictoriaMetrics: {"job": "node"} или {"node": "msk"}

    @property
    def local(self) -> bool:
        return self.host in ("127.0.0.1", "localhost") or not self.ssh

    def view(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title or self.id,
            "role": self.role,
            "host": self.host,
            "installDir": self.install_dir,
            "ssh": bool(self.ssh),
            "nodeId": self.node_id or None,
            "product": self.product or None,
            "core": {"url": self.core.url, "credential": self.core.kind or None} if self.core else None,
        }


def parse(source: str, credentials: dict[str, str]) -> list[Machine]:
    if not source:
        return []
    text = source
    if not source.lstrip().startswith("["):
        path = Path(source)
        if not path.exists():
            return []
        text = path.read_text(encoding="utf-8")
    raw = json.loads(text)
    if not isinstance(raw, list):
        raise ValueError("FLEET_MACHINES: ожидается список машин")
    machines: list[Machine] = []
    for item in raw:
        id = str(item.get("id", ""))
        if not ID.match(id):
            raise ValueError(f"FLEET_MACHINES: имя машины {id!r} — строчные латинские буквы, цифры и дефис")
        if any(m.id == id for m in machines):
            raise ValueError(f"FLEET_MACHINES: машина {id} дважды")
        role = item.get("role", "")
        if role not in ROLES:
            raise ValueError(f"FLEET_MACHINES: роль {role!r} у {id}; ожидается одна из {', '.join(ROLES)}")
        core_raw = item.get("core")
        core = None
        if core_raw:
            url = str(core_raw.get("url", "")).rstrip("/")
            if not url.startswith("http://127.0.0.1") and not url.startswith("http://localhost"):
                raise ValueError(f"FLEET_MACHINES: ядро {id} — только локальный адрес (туннель или магистраль), не {url}")
            core = Core(url, credentials.get(id.replace("-", "_"), ""))
        machines.append(
            Machine(
                id=id,
                role=role,
                host=str(item.get("host", "")),
                install_dir=str(item.get("installDir", "")),
                ssh=str(item.get("ssh", "")),
                ssh_key=str(item.get("sshKey", "")),
                node_id=str(item.get("nodeId", "")),
                product=str(item.get("product", "")),
                core=core,
                registry=str(item.get("registry", "")),
                title=str(item.get("title", "")),
                metrics={str(k): str(v) for k, v in (item.get("metrics") or {}).items()},
            )
        )
    return machines


class Machines:
    def __init__(self, machines: list[Machine]) -> None:
        self._by_id = {m.id: m for m in machines}

    def __iter__(self):
        return iter(self._by_id.values())

    def __len__(self) -> int:
        return len(self._by_id)

    def get(self, id: str) -> Machine:
        machine = self._by_id.get(id)
        if not machine:
            raise Problem(404, MACHINE_UNKNOWN, f"Машины {id} нет в списке пульта")
        return machine

    def views(self) -> list[dict[str, Any]]:
        return [m.view() for m in self._by_id.values()]
