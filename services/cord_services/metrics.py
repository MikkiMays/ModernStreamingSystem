"""Метрики службы для профиля `monitoring` (E10-B, docs/observability.md §4).

Текстовый формат Prometheus руками, без `prometheus_client`: чисел немного, а зависимость — это ещё
один пакет в образе и в `requirements.lock`. В метках ничего нет: ни встречи, ни пользователя, ни
ссылки — только счёт (П8); у кинозала — имя площадки и её состояние, перечисления, а не люди.
Адрес `/metrics` слушает 127.0.0.1 службы; шлюз наружу проксирует только `/api/v1/services/*`,
поэтому снаружи сюда не дойти.
"""

from types import SimpleNamespace

# Сторож издателя музыки (W1b шаг 3): имя метрики → поле `music.Counters`, тип, описание.
MUSIC_COUNTERS = (
    (
        "cord_music_underrun_total",
        "underruns",
        "Сколько раз декодер музыки голодал: 10 кадров тишины подряд при живом треке.",
    ),
    (
        "cord_music_starved_seconds_total",
        "starved_seconds",
        "Секунды тишины вместо музыки, которая должна была играть.",
    ),
    (
        "cord_music_reconnects_total",
        "reconnects",
        "Сколько раз издатель музыки поднимался заново после обрыва связи с SFU.",
    ),
    (
        "cord_music_decoder_restarts_total",
        "decoder_restarts",
        "Сколько раз декодер музыки перезапущен после 5 с тишины (сторож издателя).",
    ),
    (
        "cord_music_tracks_skipped_total",
        "skipped",
        "Треки, которые источник не отдал: пропущены, комната играет следующий.",
    ),
)


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
    counters = getattr(music, "counters", None)
    for name, field, text in MUSIC_COUNTERS:
        value = getattr(counters, field, 0) if counters is not None else 0
        lines += [f"# HELP {name} {text}", f"# TYPE {name} counter", f"{name} {value}"]
    # Доступность площадок кинозала с этого сервера и занятые ими потоки yt-dlp (R112).
    cinema = getattr(state, "cinema", None)
    if cinema is not None:
        lines += cinema.metric_lines()
    # Площадки музыки без двойника в кинозале (SoundCloud, Яндекс) — тем же автоматом, своим именем.
    sources = getattr(state, "sources", None)
    if sources is not None:
        lines += sources.metric_lines()
    return "\n".join(lines) + "\n"
