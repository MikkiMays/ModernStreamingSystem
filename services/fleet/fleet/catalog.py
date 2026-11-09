"""Каталог операций (Р-116): форма → проверенные аргументы → `argv` без оболочки.

Каждая операция знает свою группу (для прав агента), как превратить аргументы в команду на машине, какие у
неё предусловия и сколько ей можно идти. Свободных строк, уходящих в `sh -c`, здесь нет: имя узла, ветка,
служба — по шаблону или из перечня; всё остальное отклоняется до того, как задача создана.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .errors import OPERATION_INVALID, OPERATION_UNKNOWN, Problem
from .machines import Machine

NODE_ID = re.compile(r"^[a-z][a-z0-9-]{1,15}$")
REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$")
HOST = re.compile(r"^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
IPV4 = re.compile(r"^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$")
COUNTRY = re.compile(r"^[A-Z]{2}$")
TITLE = re.compile(r"^[^\s\"'`$\\;&|<>]{1,40}$")
SSH_TARGET = re.compile(r"^[a-z_][a-z0-9_-]{0,31}@(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$")
KEY_PATH = re.compile(r"^/[A-Za-z0-9._/-]{1,120}$")

SERVICES = ("gateway", "core", "services", "sniffer", "livekit", "edge", "backbone", "tusd", "postgres", "redis")
NODE_SERVICES = ("edge", "gateway", "livekit", "backbone", "node-exporter", "probe")

# Группы операций — для прав ключа агента (`FLEET_AGENT_OPS`).
READ, MAINTENANCE, DRAIN, DEPLOY, NODES, RELEASES = "read", "maintenance", "drain", "deploy", "nodes", "releases"


@dataclass(frozen=True)
class Operation:
    kind: str
    group: str
    title: str
    timeout: int
    build: Callable[[Machine, dict[str, Any]], list[list[str]]]
    cancellable: bool = False
    dangerous: bool = False
    preconditions: tuple[str, ...] = ()
    fields: dict[str, str] = field(default_factory=dict)

    def describe(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "group": self.group,
            "title": self.title,
            "timeoutSeconds": self.timeout,
            "cancellable": self.cancellable,
            "dangerous": self.dangerous,
            "preconditions": list(self.preconditions),
            "fields": self.fields,
        }


def _bad(field_name: str, why: str) -> Problem:
    return Problem(400, OPERATION_INVALID, f"Поле {field_name}: {why}")


def node_id(args: dict[str, Any], key: str = "node") -> str:
    value = str(args.get(key, "")).strip()
    if not NODE_ID.match(value):
        raise _bad(key, "имя узла — строчные латинские буквы, цифры и дефис, 2–16 знаков")
    return value


def services(args: dict[str, Any], allowed: tuple[str, ...] = SERVICES) -> list[str]:
    raw = args.get("services", [])
    if isinstance(raw, str):
        raw = [part for part in raw.replace(",", " ").split() if part]
    if not isinstance(raw, list) or not raw:
        raise _bad("services", "назовите хотя бы одну службу")
    chosen = []
    for item in raw:
        if item not in allowed:
            raise _bad("services", f"службы {item!r} нет; есть {', '.join(allowed)}")
        if item not in chosen:
            chosen.append(item)
    return chosen


def one_service(args: dict[str, Any], allowed: tuple[str, ...]) -> str | None:
    value = args.get("service")
    if value in (None, ""):
        return None
    if value not in allowed:
        raise _bad("service", f"службы {value!r} нет; есть {', '.join(allowed)}")
    return str(value)


def ref(args: dict[str, Any], key: str = "ref") -> str:
    value = str(args.get(key, "")).strip()
    if not REF.match(value) or ".." in value:
        raise _bad(key, "ветка или коммит — латиница, цифры, точка, дефис, косая черта")
    return value


def tail(args: dict[str, Any]) -> int:
    try:
        n = int(args.get("tail", 100))
    except (TypeError, ValueError) as error:
        raise _bad("tail", "число строк") from error
    if not 1 <= n <= 500:
        raise _bad("tail", "от 1 до 500 строк")
    return n


def flag(args: dict[str, Any], key: str) -> bool:
    value = args.get(key, False)
    if isinstance(value, bool):
        return value
    if value in ("true", "1", 1):
        return True
    if value in ("false", "0", 0, None, ""):
        return False
    raise _bad(key, "да или нет")


def _positive(args: dict[str, Any], key: str, low: int, high: int) -> int:
    try:
        n = int(args.get(key))
    except (TypeError, ValueError) as error:
        raise _bad(key, "целое число") from error
    if not low <= n <= high:
        raise _bad(key, f"от {low} до {high}")
    return n


# ── Команды ──────────────────────────────────────────────────────────────────────────────────────
def _status(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    return [
        ["git", "rev-parse", "--short", "HEAD"],
        ["docker", "compose", "ps", "--format", "json"],
        ["uptime", "-p"],
        ["df", "-h", "/"],
    ]


def _logs(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    service = one_service(args, SERVICES)
    return [["docker", "compose", "logs", "--no-color", "--tail", str(tail(args))] + ([service] if service else [])]


def _active_meetings(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    command = ["backlog/bin/active-meetings.sh"]
    if args.get("node"):
        command += ["--node", node_id(args)]
    return [command]


def _deploy(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    chosen = services(args)
    command = ["backlog/bin/deploy.sh"]
    if flag(args, "drain"):
        command.append("--drain")
    env = ["env", "CORD_DEPLOY_FORCE=1"] if flag(args, "force") else []
    steps = []
    if args.get("ref"):
        steps.append(["git", "fetch", "-q", "origin"])
        steps.append(["git", "checkout", "-q", "--detach", ref(args)])
    steps.append(env + command + chosen)
    return steps


def _rollback(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    chosen = services(args)
    return [
        ["git", "checkout", "-q", "--detach", ref(args, "commit")],
        ["backlog/bin/deploy.sh", "--drain"] + chosen,
    ]


def _node_action(action: str) -> Callable[[Machine, dict[str, Any]], list[list[str]]]:
    def build(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
        return [["backlog/bin/node.sh", node_id(args), action]]

    return build


def _node_logs(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    service = one_service(args, NODE_SERVICES)
    return [["backlog/bin/node.sh", node_id(args), "logs"] + ([service] if service else [])]


def _node_enabled(enabled: bool) -> Callable[[Machine, dict[str, Any]], list[list[str]]]:
    def build(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
        return [["node", "scripts/node-config.mjs", f"--node={node_id(args)}", f"--enabled={'true' if enabled else 'false'}"]]

    return build


def _node_update(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    id = node_id(args)
    return [
        ["node", "scripts/node-config.mjs", f"--node={id}", "--enabled=false"],
        ["backlog/bin/active-meetings.sh", "--node", id, "--wait", "900"],
        ["backlog/bin/node.sh", id, "deploy"],
        ["backlog/bin/node.sh", id, "check"],
        ["node", "scripts/node-config.mjs", f"--node={id}", "--enabled=true"],
    ]


def node_add_args(args: dict[str, Any]) -> dict[str, Any]:
    """Форма «Добавить сервер» (§8.3) → проверенные поля; имена доменов — по умолчанию из `id` и продукта."""
    id = node_id(args, "id")
    ip = str(args.get("ip", "")).strip()
    if not IPV4.match(ip):
        raise _bad("ip", "адрес IPv4")
    product = str(args.get("product", "")).strip().lower()
    if not HOST.match(product):
        raise _bad("product", "домен продукта, например cordcam.ru")
    hosts = {}
    for key, default in (("app", f"{id}.{product}"), ("rtc", f"rtc-{id}.{product}"), ("turn", f"turn-{id}.{product}")):
        value = str(args.get(key) or default).strip().lower()
        if not HOST.match(value):
            raise _bad(key, "имя DNS")
        hosts[key] = value
    if len(set(hosts.values())) != 3:
        raise _bad("rtc", "три имени должны различаться")
    country = str(args.get("country", "")).strip().upper()
    if not COUNTRY.match(country):
        raise _bad("country", "код страны ISO 3166-1 alpha-2, например FI")
    titles = {}
    for key in ("titleRu", "titleEn"):
        value = str(args.get(key, "")).strip()
        if not TITLE.match(value):
            raise _bad(key, "название без пробелов и кавычек, до 40 знаков")
        titles[key] = value
    ssh = str(args.get("ssh") or f"root@{ip}").strip()
    if not SSH_TARGET.match(ssh):
        raise _bad("ssh", "пользователь@IPv4")
    key_path = str(args.get("sshKey", "")).strip()
    if key_path and not KEY_PATH.match(key_path):
        raise _bad("sshKey", "абсолютный путь к ключу")
    return {
        "id": id,
        "ip": ip,
        "product": product,
        **hosts,
        "country": country,
        **titles,
        "uplinkMbps": _positive(args, "uplinkMbps", 10, 100000),
        "cores": _positive(args, "cores", 1, 128),
        "ssh": ssh,
        "sshKey": key_path,
        "dnsReady": flag(args, "dnsReady"),
    }


def node_add_dns(fields: dict[str, Any]) -> list[dict[str, str]]:
    return [{"name": fields[key], "type": "A", "value": fields["ip"], "proxied": False} for key in ("app", "rtc", "turn")]


def _node_add(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    f = node_add_args(args)
    config = [
        "node",
        "scripts/node-config.mjs",
        f"--node={f['id']}",
        f"--ip={f['ip']}",
    ]
    if f["dnsReady"]:
        config += [f"--app={f['app']}", f"--rtc={f['rtc']}", f"--turn={f['turn']}"]
    else:
        config += ["--mode=ip"]
    config += [
        f"--title-ru={f['titleRu']}",
        f"--title-en={f['titleEn']}",
        f"--country={f['country']}",
        f"--uplink-mbps={f['uplinkMbps']}",
        f"--cores={f['cores']}",
        f"--ssh={f['ssh']}",
    ]
    if f["sshKey"]:
        config.append(f"--ssh-key={f['sshKey']}")
    return [
        config,
        ["node", "scripts/node-config.mjs", "--write-env"],
        ["backlog/bin/node.sh", f["id"], "bootstrap"],
        ["backlog/bin/node.sh", f["id"], "deploy"],
        ["backlog/bin/node.sh", f["id"], "check"],
    ]


def _node_remove(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    id = node_id(args)
    if str(args.get("confirm", "")).strip() != id:
        raise _bad("confirm", "напечатайте имя узла, чтобы подтвердить удаление")
    return [["node", "scripts/node-config.mjs", f"--node={id}", "--remove"], ["node", "scripts/node-config.mjs", "--write-env"]]


def _env_flags(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    # Только имена флагов и их значения `true|false`: секретов эта команда прочитать не может.
    return [["grep", "-E", "^[A-Z_]+_ENABLED=(true|false)$", ".env"]]


def _publish_windows(machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    version = str(args.get("version", "")).strip()
    if not re.match(r"^\d+\.\d+\.\d+$", version):
        raise _bad("version", "версия вида 1.2.3")
    return [["backlog/bin/publish-windows.sh", version]]


OPERATIONS: dict[str, Operation] = {
    op.kind: op
    for op in (
        Operation("status", READ, "Состояние машины", 60, _status),
        Operation("logs", READ, "Хвост журнала службы", 60, _logs, fields={"service": "служба", "tail": "строк"}),
        Operation("active-meetings", READ, "Идущие встречи", 60, _active_meetings),
        Operation("env-flags", READ, "Флаги возможностей", 30, _env_flags),
        Operation(
            "deploy",
            DEPLOY,
            "Выкатить службы",
            40 * 60,
            _deploy,
            cancellable=True,
            dangerous=True,
            preconditions=("нет идущих встреч или включён дренаж", "коммит прошёл CI"),
            fields={"services": "службы", "ref": "ветка или коммит", "drain": "дренаж", "force": "несмотря на встречи"},
        ),
        Operation(
            "rollback",
            DEPLOY,
            "Откатить на коммит",
            40 * 60,
            _rollback,
            cancellable=True,
            dangerous=True,
            preconditions=("коммит из истории выкаток",),
            fields={"commit": "коммит", "services": "службы"},
        ),
        Operation("node.check", NODES, "Проверить узел", 5 * 60, _node_action("check"), fields={"node": "узел"}),
        Operation("node.logs", NODES, "Журнал узла", 60, _node_logs, fields={"node": "узел", "service": "служба"}),
        Operation("node.drain", DRAIN, "Дренаж узла", 60, _node_enabled(False), fields={"node": "узел"}),
        Operation("node.undrain", DRAIN, "Снять дренаж", 60, _node_enabled(True), fields={"node": "узел"}),
        Operation(
            "node.deploy",
            NODES,
            "Выкатить узел",
            30 * 60,
            _node_action("deploy"),
            cancellable=True,
            dangerous=True,
            preconditions=("узел дренирован", "на узле нет встреч"),
            fields={"node": "узел"},
        ),
        Operation(
            "node.update",
            NODES,
            "Обновить узел",
            50 * 60,
            _node_update,
            cancellable=True,
            dangerous=True,
            preconditions=("дренаж → ожидание конца встреч ≤ 15 мин → выкатка → проверка → снять дренаж",),
            fields={"node": "узел"},
        ),
        Operation(
            "node.add",
            NODES,
            "Добавить сервер",
            60 * 60,
            _node_add,
            cancellable=True,
            dangerous=True,
            preconditions=("DNS-записи добавлены владельцем (иначе — самоподписанный сертификат до DNS)",),
        ),
        Operation(
            "node.remove",
            NODES,
            "Удалить узел",
            60,
            _node_remove,
            dangerous=True,
            preconditions=("узел дренирован", "на узле нет встреч", "имя напечатано"),
            fields={"node": "узел", "confirm": "имя узла"},
        ),
        Operation("publish-windows", RELEASES, "Выложить версию Windows", 10 * 60, _publish_windows, fields={"version": "версия"}),
    )
}


def operation(kind: str) -> Operation:
    op = OPERATIONS.get(kind)
    if not op:
        raise Problem(404, OPERATION_UNKNOWN, f"Операции {kind!r} нет в каталоге")
    return op


def plan(kind: str, machine: Machine, args: dict[str, Any]) -> list[list[str]]:
    """Команды операции на машине (`cwd` — каталог установки). Ошибка в аргументах — `Problem` 400."""
    return operation(kind).build(machine, args)


def shell_words(argv: list[str]) -> str:
    """Для показа человеку: как это выглядело бы в терминале. Исполняется не это, а список."""
    import shlex

    return " ".join(shlex.quote(part) for part in argv)
