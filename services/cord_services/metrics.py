"""Метрики службы для профиля `monitoring` (E10-B, docs/observability.md §4).

Текстовый формат Prometheus руками, без `prometheus_client`: чисел три, а зависимость — это ещё один
пакет в образе и в `requirements.lock`. В метках ничего нет: ни встречи, ни пользователя, ни ссылки —
только счёт (П8). Адрес `/metrics` слушает 127.0.0.1 службы; шлюз наружу проксирует только
`/api/v1/services/*`, поэтому снаружи сюда не дойти.
"""

from types import SimpleNamespace


def render(state: SimpleNamespace) -> str:
    music = getattr(state, "music", None)
    tasks = getattr(music, "tasks", {}) if music else {}
    sessions = sum(1 for task in tasks.values() if not task.done())
    store = getattr(state, "store", None)
    telegram = 1 if store is not None and store.state("bot_status") == "polling" else 0
    lines = [
        "# HELP cord_services_up Служба Cord отвечает.",
        "# TYPE cord_services_up gauge",
        "cord_services_up 1",
        "# HELP cord_music_sessions_active Встречи, где сейчас играет бот музыки.",
        "# TYPE cord_music_sessions_active gauge",
        f"cord_music_sessions_active {sessions}",
        "# HELP cord_telegram_connected Бот Telegram получает обновления.",
        "# TYPE cord_telegram_connected gauge",
        f"cord_telegram_connected {telegram}",
    ]
    return "\n".join(lines) + "\n"
