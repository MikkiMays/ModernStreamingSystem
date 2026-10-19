#!/usr/bin/env python3
"""Реестр кодов ошибок ядра: contracts/errors.json.

Ядро отвечает RFC 7807 с русским `detail` и стабильным `code`. Тексты для других языков собирает
клиент по коду (E14), поэтому список кодов должен быть один и проверяемый. Скрипт находит в
исходниках ядра `new Problem(статус, "КОД", "текст")` и `Problem.conflict("КОД", "текст")` и пишет
реестр: код → статус и русский текст. Текст, склеенный из переменных, остаётся шаблоном с `{}` на
месте вставок — по нему видно, какие параметры у сообщения.

    python3 scripts/errors_registry.py            # переписать contracts/errors.json
    python3 scripts/errors_registry.py --check    # CI: реестр совпадает с кодом
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "server" / "src" / "main" / "java"
TARGET = ROOT / "contracts" / "errors.json"

CALL = re.compile(
    r'(?:new\s+Problem\(\s*(?P<status>\d{3})\s*,|Problem\.conflict\()\s*"(?P<code>[A-Z][A-Z0-9_]+)"\s*,\s*(?P<message>[^;]*?)\)\s*[;:]',
    re.S,
)
LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')


def message_template(expression: str) -> str:
    parts, last = [], 0
    for match in LITERAL.finditer(expression):
        between = expression[last : match.start()].strip(" +\n\t")
        if between and parts:
            parts.append("{}")
        parts.append(match.group(1).encode().decode("unicode_escape").encode("latin-1").decode("utf-8"))
        last = match.end()
    if expression[last:].strip(" +\n\t)"):
        parts.append("{}")
    return "".join(parts)


def collect() -> dict:
    registry: dict = {}
    for path in sorted(SOURCES.rglob("*.java")):
        text = path.read_text(encoding="utf-8")
        for match in CALL.finditer(text):
            code = match.group("code")
            entry = {
                "status": int(match.group("status") or 409),
                "ru": message_template(match.group("message")),
            }
            previous = registry.get(code)
            if previous and previous != entry:
                # Один код с разными текстами — оставляем первый, остальные перечисляем.
                previous.setdefault("variants", [])
                if entry["ru"] not in previous["variants"] and entry["ru"] != previous["ru"]:
                    previous["variants"].append(entry["ru"])
                continue
            registry[code] = entry
    # Коды без текста, которые ядро ставит само (`Problem.forbidden()`, фильтр запросов).
    registry.setdefault("FORBIDDEN", {"status": 403, "ru": "Недостаточно прав"})
    registry.setdefault("INVALID_REQUEST", {"status": 400, "ru": "Проверьте данные запроса"})
    registry.setdefault("SERVER_PASSWORD_REQUIRED", {"status": 401, "ru": "Нужен пароль сервера"})
    return dict(sorted(registry.items()))


def main() -> int:
    content = json.dumps(collect(), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != content:
            print("contracts/errors.json устарел: python3 scripts/errors_registry.py", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(content, encoding="utf-8")
    print(f"{TARGET.relative_to(ROOT)}: {content.count(chr(10) + '  \"')} кодов")
    return 0


if __name__ == "__main__":
    sys.exit(main())
