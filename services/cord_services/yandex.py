"""Yandex Music provider through the maintained, unofficial yandex-music client.

Device Flow keeps passwords on Yandex. Only complete, account-authorized audio
is accepted; previews and DRM containers are never promoted to full tracks.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import re
import secrets
import uuid
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field
from yandex_music import ClientAsync
from yandex_music.exceptions import DeviceAuthError, UnauthorizedError, YandexMusicError

from .media import MAX_FILE, probe
from .store import now


class Yandex:
    def __init__(self, store, music, secret: str):
        self.store, self.music = store, music
        self.vault = Fernet(
            base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())
        )
        self.client_factory = ClientAsync
        self.http = httpx.AsyncClient(
            timeout=httpx.Timeout(30, connect=8), follow_redirects=False
        )
        store.db.execute(
            "CREATE TABLE IF NOT EXISTS integrations(provider TEXT, scope TEXT, body TEXT NOT NULL, PRIMARY KEY(provider,scope))"
        )
        logging.getLogger("yandex_music").setLevel(logging.ERROR)

    def account(self, scope):
        row = self.store.db.execute(
            "SELECT body FROM integrations WHERE provider=? AND scope=?",
            ("yandex", scope),
        ).fetchone()
        if not row:
            return None
        try:
            return json.loads(self.vault.decrypt(row[0].encode()))
        except (InvalidToken, ValueError):
            return None

    def save(self, scope, value):
        encrypted = self.vault.encrypt(json.dumps(value).encode()).decode()
        self.store.db.execute(
            "INSERT INTO integrations VALUES (?,?,?) ON CONFLICT(provider,scope) DO UPDATE SET body=excluded.body",
            ("yandex", scope, encrypted),
        )

    def status(self, scope):
        account = self.account(scope)
        active = bool(
            account and (not account.get("expiresAt") or account["expiresAt"] > now())
        )
        return {"connected": active, "name": account.get("name") if active else None}

    def disconnect(self, scope):
        self.store.db.execute(
            "DELETE FROM integrations WHERE provider=? AND scope=?", ("yandex", scope)
        )
        pending = self.store.state("yandex-pending:" + scope)
        if pending:
            self.store.delete_claim(pending)
        return self.status(scope)

    async def request(self, awaitable):
        try:
            return await asyncio.wait_for(awaitable, 15)
        except UnauthorizedError:
            raise HTTPException(
                401, "Яндекс Музыка отклонила авторизацию. Подключите аккаунт заново"
            ) from None
        except (YandexMusicError, httpx.HTTPError, TimeoutError):
            raise HTTPException(
                502, "Яндекс Музыка временно не ответила. Повторите запрос"
            ) from None

    async def connect(self, scope, token, expires_in=None):
        status = await self.request(self.client_factory(token).account_status())
        if not status or not status.account or not status.account.uid:
            raise HTTPException(401, "Не удалось подтвердить аккаунт Яндекс Музыки")
        name = status.account.display_name or status.account.login or "Яндекс Музыка"
        self.save(
            scope,
            {
                "token": token,
                "name": name[:120],
                "expiresAt": now() + expires_in * 1000 if expires_in else None,
            },
        )
        return self.status(scope)

    async def start_auth(self, scope):
        async with self.music.locks["yandex-auth:" + scope]:
            pending = self.store.state("yandex-pending:" + scope)
            value = self.store.claim(pending) if pending else None
            if value and value["kind"] == "yandex-device":
                return self.auth_public(pending, value)
            code = await self.request(
                self.client_factory().request_device_code(device_name="Cord")
            )
            token = secrets.token_urlsafe(24)
            value = {
                "kind": "yandex-device",
                "scope": scope,
                "device": self.vault.encrypt(code.device_code.encode()).decode(),
                "userCode": code.user_code,
                "verificationUrl": code.verification_url,
                "interval": max(5, code.interval),
                "expiresAt": now() + code.expires_in * 1000,
                "nextPoll": now() + max(5, code.interval) * 1000,
            }
            parsed = urlparse(code.verification_url)
            if parsed.scheme != "https" or parsed.hostname not in (
                "ya.ru",
                "oauth.yandex.ru",
                "passport.yandex.ru",
                "id.yandex.ru",
            ):
                raise HTTPException(502, "Яндекс вернул неизвестный адрес авторизации")
            self.store.put_claim(token, value, code.expires_in * 1000)
            self.store.set_state("yandex-pending:" + scope, token)
            return self.auth_public(token, value)

    @staticmethod
    def auth_public(token, value):
        return {
            "id": token,
            "userCode": value["userCode"],
            "verificationUrl": value["verificationUrl"],
            "interval": value["interval"],
            "expiresAt": value["expiresAt"],
            "status": "pending",
        }

    async def poll_auth(self, scope, token):
        async with self.music.locks["yandex-auth:" + scope]:
            completed = self.store.receipt("yandex-auth:" + scope, token)
            if completed:
                return {"status": "connected", **self.status(scope)}
            value = self.store.claim(token)
            if not value or value["kind"] != "yandex-device" or value["scope"] != scope:
                raise HTTPException(410, "Код входа истёк. Получите новый")
            if now() < value["nextPoll"]:
                return self.auth_public(token, value)
            try:
                code = self.vault.decrypt(value["device"].encode()).decode()
                authorization = await asyncio.wait_for(
                    self.client_factory().poll_device_token(code), 15
                )
            except DeviceAuthError as error:
                if "slow_down" in str(error):
                    value["interval"] += 5
                    authorization = None
                else:
                    self.store.delete_claim(token)
                    raise HTTPException(
                        410, "Вход отменён или код истёк. Получите новый"
                    ) from None
            except (YandexMusicError, TimeoutError, InvalidToken):
                raise HTTPException(
                    502, "Не удалось проверить вход в Яндекс. Повторите"
                ) from None
            if authorization:
                status = await self.connect(
                    scope, authorization.access_token, authorization.expires_in
                )
                self.store.remember("yandex-auth:" + scope, token, {"done": True})
                self.store.delete_claim(token)
                return {"status": "connected", **status}
            value["nextPoll"] = now() + value["interval"] * 1000
            self.store.db.execute(
                "UPDATE claims SET body=? WHERE token=?", (json.dumps(value), token)
            )
            return self.auth_public(token, value)

    def client(self, scope):
        account = self.account(scope)
        if not account or not self.status(scope)["connected"]:
            raise HTTPException(
                401, "Сначала подключите аккаунт Яндекс Музыки в интеграциях Cord"
            )
        return self.client_factory(account["token"])

    @staticmethod
    def track_public(track):
        return {
            "id": str(track.id),
            "title": str(track.title or "Без названия")[:180],
            "artist": ", ".join(a.name for a in (track.artists or []))[:120],
            "duration": (track.duration_ms or 0) / 1000,
            "available": bool(track.available),
        }

    async def search(self, scope, query):
        client = self.client(scope)
        query = query.strip()
        if re.fullmatch(r"\d{1,18}", query):
            tracks = await self.request(client.tracks([query]))
        elif query.startswith(("https://", "http://")):
            parsed = urlparse(query)
            if parsed.hostname not in (
                "music.yandex.ru",
                "music.yandex.com",
                "music.yandex.kz",
                "music.yandex.by",
                "music.yandex.uz",
            ):
                raise HTTPException(
                    400, "Вставьте ссылку на трек Яндекс Музыки или введите название"
                )
            match = re.search(r"/(?:track|tracks)/(\d+)(?:/|$)", parsed.path)
            if not match:
                raise HTTPException(
                    400,
                    "Пока поддерживаются ссылки на отдельные треки. Альбом можно найти по названию",
                )
            tracks = await self.request(client.tracks([match[1]]))
        else:
            result = await self.request(client.search(query, type_="track"))
            tracks = result.tracks.results if result and result.tracks else []
        return [self.track_public(t) for t in tracks[:20]]

    @staticmethod
    def download_url(value):
        parsed = urlparse(value)
        host = parsed.hostname or ""
        if (
            parsed.scheme not in ("https", "http")
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 80, 443)
            or not any(
                host.endswith("." + suffix)
                for suffix in (
                    "yandex.ru",
                    "yandex.net",
                    "yandex.com",
                    "yandex.kz",
                    "yandex.by",
                    "yandex.uz",
                )
            )
        ):
            raise HTTPException(502, "Яндекс вернул неизвестный адрес аудиофайла")
        return parsed._replace(scheme="https", netloc=host).geturl()

    async def enqueue(self, room_id, scope, track_id, command_id, actor):
        async with self.music.locks["yandex-enqueue:" + room_id]:
            receipt = self.store.receipt("yandex-enqueue:" + room_id, command_id)
            if receipt:
                if receipt["trackId"] != track_id or receipt["scope"] != scope:
                    raise HTTPException(409, "Идентификатор команды уже использован")
                return self.store.public(room_id)
            client = self.client(scope)
            tracks = await self.request(client.tracks([track_id]))
            if not tracks or not tracks[0].available:
                raise HTTPException(
                    404, "Этот трек недоступен для подключённого аккаунта"
                )
            track = tracks[0]
            if not track.duration_ms or track.duration_ms > 3600000:
                raise HTTPException(400, "Максимальная длительность трека — 60 минут")
            infos = await self.request(client.tracks_download_info(track_id))
            # Одного трека Яндекс предлагает несколько вариантов, и берётся лучший доступный,
            # а не первый попавшийся: сначала без потерь, затем по битрейту, при равном —
            # aac выше mp3. Раньше фильтр отбрасывал всё, кроме mp3, поэтому аккаунт с более
            # качественным вариантом всё равно слушал mp3.
            rank = {"flac": 3, "aac": 2, "mp3": 1}
            full = sorted(
                [i for i in infos if not i.preview and i.codec in rank],
                key=lambda i: (
                    rank[i.codec] == 3,
                    i.bitrate_in_kbps or 0,
                    rank[i.codec],
                ),
                reverse=True,
            )
            if not full:
                raise HTTPException(
                    403,
                    "Аккаунт не получил полный аудиофайл. Проверьте подписку Яндекс Плюс и доступность трека",
                )
            self.download_url(full[0].download_info_url)
            url = self.download_url(await self.request(full[0].get_direct_link_async()))
            self.music.check_quota(room_id, 0)
            key = str(uuid.uuid4())
            path = self.store.files / key
            try:
                for _ in range(4):
                    async with self.http.stream("GET", url) as response:
                        if response.is_redirect:
                            url = self.download_url(
                                response.headers.get("location", "")
                            )
                            continue
                        if response.status_code != 200:
                            raise HTTPException(
                                502, "Яндекс не отдал аудиофайл. Попробуйте другой трек"
                            )
                        if int(response.headers.get("content-length", "0")) > MAX_FILE:
                            raise HTTPException(413, "Аудиофайл превышает 50 МБ")
                        size = 0
                        with path.open("xb") as output:
                            async for chunk in response.aiter_bytes(65536):
                                size += len(chunk)
                                if size > MAX_FILE:
                                    raise HTTPException(
                                        413, "Аудиофайл превышает 50 МБ"
                                    )
                                output.write(chunk)
                        break
                else:
                    raise HTTPException(502, "Не удалось получить аудиофайл")
                metadata = await probe(path)
                if metadata["duration"] < track.duration_ms / 1000 - 5:
                    raise HTTPException(
                        403,
                        "Яндекс вернул только фрагмент трека. Проверьте доступ аккаунта к полной версии",
                    )
                public = self.track_public(track)
                result = await self.music.enqueue(
                    room_id,
                    {
                        **public,
                        "id": key,
                        "file": key,
                        "duration": metadata["duration"],
                        "source": "yandex",
                        "addedBy": actor,
                        "createdAt": now(),
                    },
                )
                self.store.remember(
                    "yandex-enqueue:" + room_id,
                    command_id,
                    {"scope": scope, "trackId": track_id},
                )
                return result
            except BaseException as error:
                if not any(t["id"] == key for t in self.store.get(room_id)["queue"]):
                    path.unlink(missing_ok=True)
                if isinstance(error, httpx.HTTPError):
                    raise HTTPException(
                        502, "Загрузка из Яндекс Музыки прервалась. Повторите"
                    ) from None
                raise


class Search(BaseModel):
    query: str = Field(min_length=1, max_length=300)


class Enqueue(BaseModel):
    trackId: str = Field(pattern=r"^\d{1,18}$")
    commandId: uuid.UUID


class Token(BaseModel):
    token: str = Field(min_length=20, max_length=1000, pattern=r"^[A-Za-z0-9_.-]+$")


def routes(yandex, core):
    router = APIRouter(prefix="/api/v1/services/rooms/{room_id}/yandex")

    async def scope_for(room_id, authorization):
        _, member = await core.member(room_id, authorization, integration=True)
        return "room:" + room_id, member

    @router.get("")
    async def status(room_id: str, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return yandex.status(scope)

    @router.delete("")
    async def disconnect(room_id: str, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return yandex.disconnect(scope)

    @router.post("/token")
    async def token(room_id: str, value: Token, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return await yandex.connect(scope, value.token)

    @router.post("/auth")
    async def auth(room_id: str, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return await yandex.start_auth(scope)

    @router.post("/auth/{auth_id}")
    async def poll(room_id: str, auth_id: str, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return await yandex.poll_auth(scope, auth_id)

    @router.delete("/auth/{auth_id}")
    async def cancel(room_id: str, auth_id: str, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        value = yandex.store.claim(auth_id)
        if value and value.get("scope") == scope:
            yandex.store.delete_claim(auth_id)
        return {"cancelled": True}

    @router.post("/search")
    async def search(room_id: str, value: Search, authorization: str = Header()):
        scope, _ = await scope_for(room_id, authorization)
        return await yandex.search(scope, value.query)

    @router.post("/queue")
    async def queue(room_id: str, value: Enqueue, authorization: str = Header()):
        scope, member = await scope_for(room_id, authorization)
        return await yandex.enqueue(
            room_id, scope, value.trackId, str(value.commandId), member["name"]
        )

    return router
