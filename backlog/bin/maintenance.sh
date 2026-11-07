#!/usr/bin/env bash
# Окно технических работ (R194, Р-95): рычаг владельца. Запускать из каталога репы на сервере, рядом с .env.
#
#   backlog/bin/maintenance.sh status
#   backlog/bin/maintenance.sh now [--grace СЕКУНДЫ] [--until ВРЕМЯ] [--reason ТЕКСТ]   # срочно
#   backlog/bin/maintenance.sh schedule НАЧАЛО [--until ВРЕМЯ] [--reason ТЕКСТ]         # заранее
#   backlog/bin/maintenance.sh extend ВРЕМЯ                                             # сдвинуть обещанный конец
#   backlog/bin/maintenance.sh finish                                                   # отменить или закончить
#
# Время — ISO-8601 со смещением: `2026-11-10T04:00:00+03:00`. Пример окна с 4 до 5 утра по Москве:
#   backlog/bin/maintenance.sh schedule 2026-11-10T04:00:00+03:00 --until 2026-11-10T05:00:00+03:00 --reason "Обновление"
#
# В начале окна все встречи завершаются, вход закрыт, люди видят страницу работ. Забытое окно закроется само:
# через час после обещанного конца, и не позже шести часов от начала. Пароль берётся из .env и в командную строку не попадает.
set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
[[ -f .env ]] || { echo "Нет .env: запускайте из рабочего каталога сервера" >&2; exit 1; }
password=$(sed -n 's/^ADMIN_PASSWORD=//p' .env | head -1)
[[ -n $password ]] || { echo "В .env нет ADMIN_PASSWORD" >&2; exit 1; }
CORD_CORE="http://127.0.0.1:${CORE_PORT:-8080}" ADMIN_PASSWORD=$password exec python3 - "$@" <<'PY'
import argparse, json, os, sys, urllib.error, urllib.request

core = os.environ["CORD_CORE"]
parser = argparse.ArgumentParser(prog="maintenance.sh")
commands = parser.add_subparsers(dest="command", required=True)
commands.add_parser("status")
now = commands.add_parser("now")
now.add_argument("--grace", type=int)
now.add_argument("--until")
now.add_argument("--reason")
schedule = commands.add_parser("schedule")
schedule.add_argument("starts_at")
schedule.add_argument("--until")
schedule.add_argument("--reason")
extend = commands.add_parser("extend")
extend.add_argument("ends_at")
commands.add_parser("finish")
args = parser.parse_args()


def call(method, path, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        core + path, data, {"Content-Type": "application/json", **(headers or {})}, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        print(f"{error.code}: {error.read().decode(errors='replace')[:400]}", file=sys.stderr)
        sys.exit(1)


token = call("POST", "/api/v1/admin/session", {"password": os.environ["ADMIN_PASSWORD"]})["token"]
admin = {"X-Cord-Admin": token}
base = "/api/v1/admin/maintenance/window"
present = lambda **fields: {key: value for key, value in fields.items() if value is not None}
if args.command == "status":
    result = call("GET", base, headers=admin)
elif args.command == "now":
    result = call("POST", base + "/now", present(graceSeconds=args.grace, endsAt=args.until, reason=args.reason), admin)
elif args.command == "schedule":
    result = call("POST", base + "/schedule", present(startsAt=args.starts_at, endsAt=args.until, reason=args.reason), admin)
elif args.command == "extend":
    result = call("POST", base + "/extend", {"endsAt": args.ends_at}, admin)
else:
    result = call("DELETE", base, headers=admin)
print(json.dumps(result, ensure_ascii=False, indent=2))
PY
