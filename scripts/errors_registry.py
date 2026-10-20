#!/usr/bin/env python3
"""Реестр кодов ошибок ядра: contracts/errors.json.

Ядро отвечает RFC 7807 с русским `detail` и стабильным `code`. Тексты для других языков собирает
клиент по коду (E14), поэтому список кодов должен быть один и проверяемый. Скрипт находит в
исходниках ядра `new Problem(статус, "КОД", текст[, Map.of(...)])`, `Problem.conflict("КОД", текст)`
и готовый JSON отказа (`{"code":"КОД","detail":"текст"}` в фильтре запросов), а в службах —
`Refusal(статус, "КОД", "текст")` (`services/cord_services`, E09), и пишет реестр: код →
статус, русский текст и, если есть, имена значений, которые отказ несёт рядом с кодом (`params`).
Текст, склеенный из переменных, остаётся шаблоном с `{}` на месте вставок — по нему видно, какие
вставки у сообщения.

    python3 scripts/errors_registry.py            # переписать contracts/errors.json
    python3 scripts/errors_registry.py --check    # CI: реестр совпадает с кодом
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES = ROOT / "server" / "src" / "main" / "java"
SERVICES = ROOT / "services" / "cord_services"
TARGET = ROOT / "contracts" / "errors.json"

START = re.compile(r"new\s+Problem\s*\(|Problem\.conflict\s*\(")
LITERAL = re.compile(r'"((?:[^"\\]|\\.)*)"')
CODE = re.compile(r'^"([A-Z][A-Z0-9_]+)"$')
RAW = re.compile(r'\\"code\\":\\"(?P<code>[A-Z][A-Z0-9_]+)\\",\\"detail\\":\\"(?P<message>(?:[^"\\]|\\[^"])*)\\"')
STATUS = re.compile(r"setStatus\(\s*(\d{3})\s*\)")
# Отказ службы с кодом (`cord_services/webapp.py`): тот же порядок аргументов, что у `new Problem`.
REFUSAL = re.compile(r"\bRefusal\s*\(")


def arguments(text: str, start: int) -> tuple[list[str], int]:
    """Аргументы вызова верхнего уровня от открывающей скобки до парной — с учётом строк и скобок."""
    args, depth, current, index = [], 0, [], start
    while index < len(text):
        char = text[index]
        if char == '"':
            end = index + 1
            while text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            current.append(text[index : end + 1])
            index = end + 1
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            if depth == 0:
                args.append("".join(current).strip())
                return args, index
            depth -= 1
        elif char == "," and depth == 0:
            args.append("".join(current).strip())
            current = []
            index += 1
            continue
        current.append(char)
        index += 1
    raise ValueError("незакрытый вызов")


def unescape(literal: str) -> str:
    return literal.encode().decode("unicode_escape").encode("latin-1").decode("utf-8")


def message_template(expression: str) -> str:
    """Склейка строк и переменных → текст с `{}` на месте каждой вставки."""
    parts, last = [], 0
    for match in LITERAL.finditer(expression):
        if expression[last : match.start()].strip(" +\n\t"):
            parts.append("{}")
        parts.append(unescape(match.group(1)))
        last = match.end()
    if expression[last:].strip(" +\n\t"):
        parts.append("{}")
    return "".join(parts)


def params(expression: str) -> list[str]:
    """Имена значений из `Map.of("roomId", …, "title", …)` — ключи стоят на чётных местах."""
    match = re.match(r"Map\.of\s*\(", expression)
    if not match:
        return []
    values, _ = arguments(expression, match.end())
    return [unescape(value[1:-1]) for value in values[::2] if value.startswith('"')]


def add(registry: dict, code: str, entry: dict) -> None:
    previous = registry.get(code)
    if previous is None:
        registry[code] = entry
        return
    # Один код с разными текстами — оставляем первый, остальные перечисляем.
    if entry["ru"] != previous["ru"] and entry["ru"] not in previous.get("variants", []):
        previous.setdefault("variants", []).append(entry["ru"])


def collect() -> dict:
    registry: dict = {}
    for path in sorted(SOURCES.rglob("*.java")):
        text = path.read_text(encoding="utf-8")
        for match in START.finditer(text):
            args, _ = arguments(text, match.end())
            conflict = match.group(0).startswith("Problem.conflict")
            if conflict:
                args = ["409", *args]
            if len(args) < 3 or not args[0].isdigit():
                continue
            code = CODE.match(args[1])
            if not code:
                continue  # `new Problem(409, code, message)` в самом `Problem.conflict`
            entry = {"status": int(args[0]), "ru": message_template(args[2])}
            names = params(args[3]) if len(args) > 3 else []
            if names:
                entry["params"] = names
            add(registry, code.group(1), entry)
        for match in RAW.finditer(text):
            status = STATUS.findall(text, 0, match.start())
            entry = {"status": int(status[-1]) if status else 400, "ru": unescape(match.group("message"))}
            add(registry, match.group("code"), entry)
    for path in sorted(SERVICES.rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        for match in REFUSAL.finditer(text):
            args, _ = arguments(text, match.end())
            if len(args) < 3 or not args[0].isdigit():
                continue  # объявление класса и прочие упоминания
            code = CODE.match(args[1])
            if code:
                add(registry, code.group(1), {"status": int(args[0]), "ru": message_template(args[2])})
    return dict(sorted(registry.items()))


def main() -> int:
    content = json.dumps(collect(), ensure_ascii=False, indent=2) + "\n"
    if "--check" in sys.argv:
        if not TARGET.exists() or TARGET.read_text(encoding="utf-8") != content:
            print("contracts/errors.json устарел: python3 scripts/errors_registry.py", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(content, encoding="utf-8")
    print(f"{TARGET.relative_to(ROOT)}: {len(json.loads(content))} кодов")
    return 0


if __name__ == "__main__":
    sys.exit(main())
