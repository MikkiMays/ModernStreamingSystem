"""Настройки пульта — из окружения (`.local/fleet.env`, Р-120). Секретов продукта здесь нет.

    FLEET_PASSWORD_HASH   scrypt$<n>,<r>,<p>$<соль base64>$<хэш base64>  — `node scripts/fleet-setup.mjs`
    FLEET_TOTP_SECRET     base32, 20 байт
    FLEET_ALLOW_IPS       CIDR через запятую; пусто — любые адреса
    FLEET_ADMIN_HOST      имя пульта (`admin.callcord.ru`) — проверка Origin; пусто — Origin должен совпасть с Host
    FLEET_AGENT_KEY       ключ агент-сессии (только с 127.0.0.1); пусто — агента нет
    FLEET_AGENT_OPS       операции агента через запятую (по умолчанию read,maintenance,drain)
    FLEET_MACHINES        JSON со списком машин (§6.1) или путь к файлу
    FLEET_EXECUTOR        dry-run (по умолчанию) | ssh
    FLEET_SSH_MACHINES    машины, к которым разрешён ssh (при FLEET_EXECUTOR=ssh)
    FLEET_METRICS_URL     VictoriaMetrics (http://127.0.0.1:8428); пусто — метрик нет
    FLEET_ALERTS_URL      vmalert (http://127.0.0.1:8880); пусто — алертов нет
    FLEET_DATA            каталог состояния (/data)
    FLEET_INSECURE_DEV    1 — кука без `Secure` и без префикса `__Host-` (только dev по http)
    FLEET_CORE_<ID>       учётные данные ядра машины <ID>: `password:<…>` или `key:<…>`
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

SESSION_LIFETIME = 8 * 3600
SESSION_IDLE = 60 * 60
LOGIN_PER_MINUTE = 5
LOCK_AFTER_FAILURES = 10
LOCK_SECONDS = 15 * 60
AUDIT_KEEP_DAYS = 400

DEFAULT_AGENT_OPS = ("read", "maintenance", "drain")


@dataclass(frozen=True)
class Settings:
    password_hash: str = ""
    totp_secret: str = ""
    allow_ips: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...] = ()
    admin_host: str = ""
    agent_key: str = ""
    agent_ops: tuple[str, ...] = DEFAULT_AGENT_OPS
    machines_source: str = ""
    executor: str = "dry-run"
    ssh_machines: tuple[str, ...] = ()
    metrics_url: str = ""
    alerts_url: str = ""
    data_dir: Path = Path("/data")
    insecure_dev: bool = False
    core_credentials: dict[str, str] = field(default_factory=dict)
    # R211: вход по клиентскому сертификату — его проверяет `edge` на имени пульта, а шлюз пульта ставит
    # `X-Cord-Edge-Cert: verified`. Тогда пароль и код не нужны (владелец 08.11: «только по сертификату»).
    edge_cert: bool = False

    @property
    def enabled(self) -> bool:
        """Без пароля и секрета кода входа нет — пульт отвечает 404 на всё, кроме здоровья."""
        return self.edge_cert or bool(self.password_hash and self.totp_secret)

    @property
    def cookie_name(self) -> str:
        return "fleet" if self.insecure_dev else "__Host-fleet"

    def allows(self, ip: str | None) -> bool:
        if not self.allow_ips:
            return True
        try:
            address = ipaddress.ip_address(ip or "")
        except ValueError:
            return False
        return any(address in network for network in self.allow_ips)

    def ssh_allowed(self, machine: str) -> bool:
        return self.executor == "ssh" and machine in self.ssh_machines


def _list(value: str | None) -> tuple[str, ...]:
    return tuple(part.strip() for part in (value or "").split(",") if part.strip())


def from_env(env: dict[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    networks = []
    for cidr in _list(env.get("FLEET_ALLOW_IPS")):
        networks.append(ipaddress.ip_network(cidr, strict=False))
    executor = env.get("FLEET_EXECUTOR", "dry-run").strip() or "dry-run"
    if executor not in ("dry-run", "ssh"):
        raise ValueError(f"FLEET_EXECUTOR: ожидается dry-run или ssh, получено {executor!r}")
    credentials = {
        key[len("FLEET_CORE_") :].lower(): value
        for key, value in env.items()
        if key.startswith("FLEET_CORE_") and value
    }
    return Settings(
        password_hash=env.get("FLEET_PASSWORD_HASH", "").strip(),
        totp_secret=env.get("FLEET_TOTP_SECRET", "").strip().replace(" ", ""),
        allow_ips=tuple(networks),
        admin_host=env.get("FLEET_ADMIN_HOST", "").strip().lower(),
        agent_key=env.get("FLEET_AGENT_KEY", "").strip(),
        agent_ops=_list(env.get("FLEET_AGENT_OPS")) or DEFAULT_AGENT_OPS,
        machines_source=env.get("FLEET_MACHINES", "").strip(),
        executor=executor,
        ssh_machines=_list(env.get("FLEET_SSH_MACHINES")),
        metrics_url=env.get("FLEET_METRICS_URL", "").strip().rstrip("/"),
        alerts_url=env.get("FLEET_ALERTS_URL", "").strip().rstrip("/"),
        data_dir=Path(env.get("FLEET_DATA", "/data")),
        insecure_dev=env.get("FLEET_INSECURE_DEV", "") == "1",
        core_credentials=credentials,
        edge_cert=env.get("FLEET_AUTH", "").strip() == "edge-cert",
    )
