"""Подпись адресов и белый список хостов: то, на чём держится собственный прокси службы."""

from __future__ import annotations

import base64
import hmac
import time
from hashlib import sha256
from urllib.parse import urlencode, urlsplit

from fastapi import HTTPException


PREFIX = "/api/v1/services/cinema"

# Сколько живёт выданная подпись. Ссылки YouTube сами протухают за шесть часов, Twitch
# обновляет свои чаще; пять часов — меньше обоих сроков, и переоткрытие всё равно дешёвое.
SIGNATURE_TTL = 5 * 3600

ALLOWED_HOSTS = (
    "googlevideo.com",
    "youtube.com",
    "ytimg.com",
    "ggpht.com",
    # Картинки каналов YouTube лежат здесь, а не на `ytimg`. Пускать сюда можно только с нашей
    # подписью — как и всё остальное; без этого хоста страница канала была бы без лица.
    "googleusercontent.com",
    "ttvnw.net",
    "jtvnw.net",
    "twitchcdn.net",
    "twitch.tv",
    "akamaized.net",
)


def allowed(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return urlsplit(url).scheme == "https" and any(
        host == name or host.endswith("." + name) for name in ALLOWED_HOSTS
    )


class Signer:
    """Подпись адреса и срока. Ключ тот же, которым служба доказывает ядру, что она своя."""

    def __init__(self, secret: str):
        self._secret = (secret or "cord-cinema").encode()

    def sign(self, url: str, ttl: int = SIGNATURE_TTL) -> dict[str, str]:
        expires = str(int(time.time()) + ttl)
        packed = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        return {"u": packed, "e": expires, "s": self._digest(packed, expires)}

    def open(self, packed: str, expires: str, signature: str) -> str:
        if not hmac.compare_digest(signature, self._digest(packed, expires)):
            raise HTTPException(403, "Ссылка не подписана этим сервером")
        if not expires.isdigit() or int(expires) < time.time():
            raise HTTPException(410, "Ссылка устарела, откройте видео заново")
        try:
            url = base64.urlsafe_b64decode(packed + "=" * (-len(packed) % 4)).decode()
        except Exception:
            raise HTTPException(400, "Неразборчивая ссылка") from None
        if not allowed(url):
            raise HTTPException(403, "Этот адрес не обслуживается")
        return url

    def name(self, url: str) -> str:
        """Короткое имя адреса: то же самое доказательство, что и подпись, но без адреса внутри."""
        return self._digest(url, "reel")[:24]

    def _digest(self, packed: str, expires: str) -> str:
        return hmac.new(self._secret, f"{packed}|{expires}".encode(), sha256).hexdigest()[:32]


def proxied(signer: Signer, url: str, route: str, ttl: int = SIGNATURE_TTL) -> str:
    return f"{PREFIX}/{route}?" + urlencode(signer.sign(url, ttl))
