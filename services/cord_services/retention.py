"""Срок содержимого в службе (Р-134, `docs/architecture/data-retention.md`): всё, что принесли в комнату, — не
дольше суток от добавления.

Что держит служба и как оно уходит:

- очередь музыки и история «назад» — сутки от добавления трека (`store.TRACK_TTL`), вместе с файлами звука
  и обложек; запись о музыке комнаты, где ею не пользовались сутки, — тоже;
- номера ссылок кинозала «По ссылке» (`cinema_links`: адрес страницы и что на ней нашлось) — сутки от
  последней записи;
- вход Яндекса комнаты, у которой музыки больше нет, — сутки от подключения;
- память кинозала: кусочки видео (`Segments`, две минуты) и ответы площадок (`Memo`) — своим сроком, даже
  если их больше никто не спросит.

Уборка идёт каждые пять минут (`app.clean`) — чаще часа, которого требует правило. Сколько ушло — метрика
`cord_retention_deleted_total{kind}`: только вид, без комнат и людей (П8).
"""

from __future__ import annotations

import time
from collections import Counter
from typing import Any


class Retention:
    def __init__(self) -> None:
        self.deleted: Counter[str] = Counter()
        self.swept_at = 0.0

    def sweep(self, store: Any, cinema: Any = None, yandex: Any = None) -> dict[str, int]:
        """Один проход: стор, затем вход Яндекса комнат без музыки, затем память кинозала."""
        gone = dict(store.cleanup() or {})
        if yandex is not None:
            # Вход Яндекса комнаты уходит вместе с её музыкой (R157).
            gone["yandex_login"] = yandex.sweep_rooms({room["roomId"] for room in store.rooms()})
        if cinema is not None:
            for kind, count in cinema.sweep().items():
                gone[kind] = gone.get(kind, 0) + count
        self.deleted.update({kind: count for kind, count in gone.items() if count})
        self.swept_at = time.time()
        return gone

    def metric_lines(self) -> list[str]:
        name = "cord_retention_deleted_total"
        lines = [
            f"# HELP {name} Удалено по сроку хранения содержимого (Р-134): треки, ссылки, память кинозала.",
            f"# TYPE {name} counter",
        ]
        lines += [f'{name}{{kind="{kind}"}} {count}' for kind, count in sorted(self.deleted.items())]
        stamp = "cord_retention_last_sweep_timestamp_seconds"
        lines += [
            f"# HELP {stamp} Когда уборка содержимого службы прошла последний раз.",
            f"# TYPE {stamp} gauge",
            f"{stamp} {int(self.swept_at)}",
        ]
        return lines
