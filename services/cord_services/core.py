from __future__ import annotations

import uuid

import httpx
from fastapi import HTTPException

# Права решает ядро (`server/.../room/Permissions.java`): снимок участника несёт готовый список
# `you.can`, и служба спрашивает его по имени действия. Своего правила у службы нет.
#
# Этот словарь — не правило, а совместимость: какой класс у действия, если ядро ещё старое и `you`
# в снимке нет. Классы те же, что у матрицы ядра (docs/superpowers/specs/2026-10-19-permissions.md),
# поэтому и со старым ядром убрать музыку может каждый, кому разрешены интеграции (T14).
CREATOR = "creator"
INTEGRATIONS = "integrations"
PARTICIPANT = "participant"
ACTIONS = {
    "telegram.link": CREATOR,
    "music.view": PARTICIPANT,
    "music.enable": INTEGRATIONS,
    "music.control": INTEGRATIONS,
    "music.upload": INTEGRATIONS,
    "music.remove": INTEGRATIONS,
    "music.search": INTEGRATIONS,
    "music.link": INTEGRATIONS,
    "yandex.connect": INTEGRATIONS,
    "yandex.search": INTEGRATIONS,
    "yandex.queue": INTEGRATIONS,
    "yandex.disconnect": INTEGRATIONS,
    "cinema.browse": PARTICIPANT,
    "cinema.resolve": PARTICIPANT,
}
ABSENT = "Сначала войдите во встречу"
REFUSALS = {
    CREATOR: "Это действие доступно создателю встречи",
    INTEGRATIONS: "Организатор разрешил интеграции только себе",
}


def present(room: dict, member: dict | None) -> bool:
    """Участник во встрече и вправе действовать хоть как-то — факты снимка, не права."""
    return bool(
        member
        and not room.get("closedAt")
        and member.get("status") in ("JOINING", "CONNECTED", "RECOVERING")
        and not member.get("service")
    )


def refusal(room: dict, member: dict | None, action: str) -> str:
    """Отказ словами: не вошёл — так и сказать, иначе — чьё это действие."""
    if not present(room, member):
        return ABSENT
    return REFUSALS.get(ACTIONS[action], ABSENT)


def granted(room: dict) -> list[str] | None:
    """Что ядро разрешило этому участнику, или None — ядро старое и `you` не знает."""
    you = room.get("you")
    if isinstance(you, dict) and isinstance(you.get("can"), list):
        return you["can"]
    return None


class Core:
    def __init__(self, url: str, secret: str):
        self.url = url.rstrip("/")
        self.secret = secret
        self.client = httpx.AsyncClient(timeout=8, follow_redirects=False)

    async def request(
        self,
        method: str,
        path: str,
        data=None,
        credential: str | None = None,
        headers=None,
    ):
        # Two headers, one secret, two different statements. X-Internal-Secret means
        # "this request arrived through our own gateway" — the gateway stamps it on
        # everything it forwards, including a browser's. X-Service-Secret means "the
        # caller is one of our services", which is what lets the bots past a server
        # access password: they never see the connect screen and have no one to ask.
        combined = {
            "X-Internal-Secret": self.secret,
            "X-Service-Secret": self.secret,
            **(headers or {}),
        }
        if credential:
            combined["Authorization"] = (
                credential
                if credential.startswith("Bearer ")
                else "Bearer " + credential
            )
        try:
            response = await self.client.request(
                method, self.url + path, json=data, headers=combined
            )
        except httpx.HTTPError:
            raise HTTPException(503, "Сервер встречи временно недоступен") from None
        if not response.is_success:
            try:
                detail = response.json().get("detail", "Запрос к встрече отклонён")
            except ValueError:
                detail = "Запрос к встрече отклонён"
            raise HTTPException(response.status_code, detail)
        return response.json() if response.content else None

    async def member(self, room_id: str, credential: str, *, action: str):
        """Снимок и участник — если ядро разрешает ему `action` (имя из `ACTIONS`)."""
        if action not in ACTIONS:
            raise ValueError("Неизвестное действие: " + action)
        try:
            uuid.UUID(room_id)
        except ValueError:
            raise HTTPException(404, "Комната не найдена") from None
        room = await self.request(
            "GET", f"/api/v1/rooms/{room_id}", credential=credential
        )
        member_id = credential.removeprefix("Bearer ").split(".", 1)[0]
        member = next((p for p in room["participants"] if p["id"] == member_id), None)
        can = granted(room)
        if can is not None:
            if member and action in can:
                return room, member
            raise HTTPException(403, refusal(room, member, action))
        # Старое ядро: прежние проверки участника и класс действия по той же матрице.
        if not present(room, member):
            raise HTTPException(403, ABSENT)
        kind = ACTIONS[action]
        if (
            kind == INTEGRATIONS
            and not room.get("integrationsAllowed", True)
            and not member["owner"]
        ) or (kind == CREATOR and not member["owner"]):
            raise HTTPException(403, REFUSALS[kind])
        return room, member

    async def command(
        self,
        admission: dict,
        kind: str,
        target: str | None = None,
        command_id: str | None = None,
    ):
        return await self.request(
            "POST",
            f"/api/v1/rooms/{admission['roomId']}/commands",
            {
                "commandId": command_id or str(uuid.uuid4()),
                "type": kind,
                "targetId": target,
            },
            admission["credential"],
        )

    async def add_music(self, room_id: str, command_id: str):
        return await self.request(
            "POST", f"/internal/services/{room_id}/music", {"commandId": command_id}
        )
