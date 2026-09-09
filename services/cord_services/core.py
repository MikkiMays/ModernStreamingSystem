from __future__ import annotations

import uuid

import httpx
from fastapi import HTTPException


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
        combined = {"X-Internal-Secret": self.secret, **(headers or {})}
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

    async def member(
        self,
        room_id: str,
        credential: str,
        owner: bool = False,
        integration: bool = False,
    ):
        try:
            uuid.UUID(room_id)
        except ValueError:
            raise HTTPException(404, "Комната не найдена") from None
        room = await self.request(
            "GET", f"/api/v1/rooms/{room_id}", credential=credential
        )
        member_id = credential.removeprefix("Bearer ").split(".", 1)[0]
        member = next((p for p in room["participants"] if p["id"] == member_id), None)
        if (
            room.get("closedAt")
            or not member
            or member["status"] not in ("JOINING", "CONNECTED", "RECOVERING")
            or member.get("service")
        ):
            raise HTTPException(403, "Сначала войдите во встречу")
        if (
            integration
            and not room.get("integrationsAllowed", True)
            and not member["owner"]
        ):
            raise HTTPException(403, "Организатор разрешил интеграции только себе")
        if owner and not member["owner"]:
            raise HTTPException(403, "Это действие доступно организатору")
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
