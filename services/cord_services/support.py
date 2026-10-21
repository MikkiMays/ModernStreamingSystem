"""Обращения в поддержку — из очереди ядра в Telegram владельца Cord (E13, T36).

Ядро хранит обращение и держит очередь недонесённых (`/internal/support/outbox`); бот её спрашивает,
отправляет каждое обращение готовым текстом в чат владельца и отмечает донесённым. Так обращение не
теряется, если Telegram недоступен или служба перезапускается посреди отправки: не отмеченное уйдёт
на следующем круге. Чат владельца знает ядро (`stream.support.notify-telegram-chat`), токен бота —
только служба.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from fastapi import HTTPException

log = logging.getLogger(__name__)

# Обращение — редкость; раз в 20 секунд хватает, чтобы владелец узнал почти сразу, и ничего не стоит.
INTERVAL = 20
# Отказ Telegram (чат не найден, бот не в чате) повторять каждые 20 секунд бессмысленно.
BACKOFF = 300


class SupportRelay:
    def __init__(self, send: Callable[[str, dict], Awaitable[object]], core):
        self.send = send
        self.core = core

    async def deliver(self) -> int:
        """Один круг: донести всё, что ждёт. Сколько донесено."""
        pending = await self.core.request("GET", "/internal/support/outbox") or []
        done = 0
        for ticket in pending:
            await self.send(
                "sendMessage",
                {
                    "chat_id": ticket["chat"],
                    "text": ticket["text"],
                    "disable_web_page_preview": True,
                },
            )
            await self.core.request("POST", f"/internal/support/{ticket['id']}/sent")
            done += 1
        return done

    async def run(self):
        while True:
            try:
                await self.deliver()
                await asyncio.sleep(INTERVAL)
            except asyncio.CancelledError:
                raise
            except HTTPException:
                # Текст отказа Telegram не пишем: в нём может оказаться адрес с токеном бота.
                log.warning("Обращение в поддержку не донесено, повтор через %s с", BACKOFF)
                await asyncio.sleep(BACKOFF)
            except Exception:
                log.warning("Очередь обращений недоступна, повтор через %s с", BACKOFF)
                await asyncio.sleep(BACKOFF)
