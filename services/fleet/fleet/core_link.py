"""Связь с ядром (Р-115): админ-API `/api/v1/admin/*` по локальному адресу — стенд A напрямую, ядро продукта
через туннель или магистраль. Учётные данные — `password:<…>` (вход `POST /admin/session`, токен на 8 ч) или
`key:<…>` (токен `fleet.<ключ>`, принимается ядром без входа)."""

from __future__ import annotations

import time
from typing import Any

import httpx

from .errors import CORE_UNREACHABLE, MACHINE_NO_CORE, Problem
from .machines import Machine

ADMIN_HEADER = "X-Cord-Admin"


class CoreLink:
    def __init__(self, machine: Machine, client: httpx.AsyncClient | None = None) -> None:
        if not machine.core:
            raise Problem(409, MACHINE_NO_CORE, f"У машины {machine.id} нет ядра")
        self.machine = machine
        self.core = machine.core
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0))
        self._token: str | None = None
        self._token_until = 0.0

    async def close(self) -> None:
        await self.client.aclose()

    async def token(self) -> str:
        if self.core.kind == "key":
            return "fleet." + self.core.secret
        if self.core.kind != "password":
            raise Problem(409, MACHINE_NO_CORE, f"Для ядра {self.machine.id} не заданы учётные данные (FLEET_CORE_…)")
        if self._token and time.time() < self._token_until:
            return self._token
        data = await self._send("POST", "/api/v1/admin/session", json={"password": self.core.secret}, auth=False)
        self._token = str(data["token"])
        # Токен ядра живёт 8 ч; обновляем за минуту до конца.
        self._token_until = float(data.get("expiresAt", time.time() + 8 * 3600)) - 60
        return self._token

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._send("GET", path, params=params)

    async def post(self, path: str, json: Any = None, headers: dict[str, str] | None = None) -> Any:
        return await self._send("POST", path, json=json, headers=headers)

    async def put(self, path: str, json: Any = None, headers: dict[str, str] | None = None) -> Any:
        return await self._send("PUT", path, json=json, headers=headers)

    async def delete(self, path: str) -> Any:
        return await self._send("DELETE", path)

    async def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        auth: bool = True,
        headers: dict[str, str] | None = None,
    ) -> Any:
        extra = headers
        headers = dict(extra or {})
        if auth:
            headers[ADMIN_HEADER] = await self.token()
        try:
            response = await self.client.request(method, self.core.url + path, params=params, json=json, headers=headers)
        except httpx.HTTPError as error:
            raise Problem(502, CORE_UNREACHABLE, f"Ядро {self.machine.id} не отвечает: {error.__class__.__name__}") from error
        if response.status_code == 401 and auth and self.core.kind == "password" and self._token:
            # Токен протух раньше срока (сменили пароль) — один повтор с новым входом.
            self._token = None
            return await self._send(method, path, params=params, json=json, auth=auth, headers=extra)
        if response.status_code >= 400:
            problem = self._problem(response)
            raise Problem(
                response.status_code,
                str(problem.get("code") or "CORE_REFUSED"),
                str(problem.get("detail") or f"Ядро ответило {response.status_code}"),
                source="core",
                machine=self.machine.id,
            )
        if not response.content:
            return None
        return response.json()

    @staticmethod
    def _problem(response: httpx.Response) -> dict[str, Any]:
        try:
            data = response.json()
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}
