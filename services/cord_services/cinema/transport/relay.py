"""
Ответ чужого сервера — зрителю: каким видом он уходит с нашего адреса и чем закрыт от исполнения.

ПОЧЕМУ. Прокси отдаёт байты площадки со своего адреса — с адреса Cord. Площадка «По ссылке» подписывает
любой адрес, который назвала вставленная страница: картинку `og:image`, файл, строку своего плейлиста.
Отдай прокси вид ответа, который выбрал чужой сервер, — `text/html`, `image/svg+xml`, `text/javascript`, —
и страница по ссылке нашего прокси исполнила бы чужой код от имени Cord: CSP шлюза (`script-src 'self'`) и
`nosniff` такой скрипт пропускают, он ведь «свой». Поэтому вид ответа — только из белого списка
(`media_type`), остальное — `application/octet-stream`, у всех площадок и на каждом пути прокси. И каждый
ответ подписанных маршрутов несёт три заголовка (`SEALED`): открыть его вкладкой — значит скачать файл,
исполнить — нельзя, угадать вид по содержимому — тоже. `<video>`, `<img>`, `<track>`, hls.js и dash.js
ни на один из трёх не смотрят.
"""

from __future__ import annotations

import re
from typing import Mapping

OCTET = "application/octet-stream"

# Ответ, который браузер не исполнит и не покажет страницей: вкладка его скачивает, CSP запрещает в нём всё,
# а вид не угадывается по содержимому.
SEALED: Mapping[str, str] = {
    "Content-Disposition": "attachment",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
}

# Виды, которые прокси отдаёт как есть: кусочки видео и звука, готовые файлы, постеры и субтитры. Видео и
# звук — всем семейством (`video/*`, `audio/*`), картинки — только растровые: SVG — это документ со
# скриптами.
KINDS = frozenset(
    {
        "application/mp4",
        OCTET,
        "text/vtt",
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/avif",
    }
)
FAMILIES = ("video/", "audio/")
# Один вид — два токена через косую черту, как их пишет RFC 9110; «video/mp4, text/html» (два заголовка
# склеены через запятую) — уже не один вид, и браузер взял бы из них последний.
TOKEN = re.compile(r"[a-z0-9!#$%&'*+.^_`|~-]+/[a-z0-9!#$%&'*+.^_`|~-]+")
# Такой вид браузер открыл бы документом, как бы ни звалось семейство: `video/x+xml` для него — XML.
DOCUMENT = re.compile(r"xml|html|script")


def media_type(value: str | None, default: str = OCTET) -> str:
    """
    Вид ответа для зрителя: из белого списка, без параметров и строчными — или `application/octet-stream`.
    Площадка вида не назвала — `default`, если он сам из списка.
    """
    if value is None or not value.strip():
        value = default
    essence = value.partition(";")[0].strip().lower()
    if not TOKEN.fullmatch(essence) or DOCUMENT.search(essence):
        return OCTET
    if essence in KINDS or essence.startswith(FAMILIES):
        return essence
    return OCTET
