"""Уведомления владельцу в Telegram: итоги дня из аналитики и сбой задачи пульта.

Бот — отдельный бот оповещений владельца (тот же, куда пишет Alertmanager): `ALERT_TELEGRAM_BOT_TOKEN` и
`ALERT_TELEGRAM_CHAT_ID` из `.local/alerts.env`. Нет токена или чата — уведомлений нет, пульт работает как раньше.
В сообщениях нет ни имён, ни адресов, ни номеров встреч: только числа дня и название задачи. Токен в журнал не
попадает: ошибка сети называется именем, а не текстом с адресом запроса.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

log = logging.getLogger(__name__)


class Telegram:
    def __init__(self, token: str, chat: str, client: httpx.AsyncClient | None = None) -> None:
        self.token = token.strip()
        self.chat = chat.strip()
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0))

    @property
    def enabled(self) -> bool:
        return bool(self.token and self.chat)

    async def send(self, text: str) -> bool:
        """Отправить сообщение владельцу. Никогда не бросает: уведомление не должно ронять то, что его вызвало."""
        if not self.enabled:
            return False
        try:
            response = await self.client.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": int(self.chat), "text": text[:4000], "disable_web_page_preview": True},
            )
        except (httpx.HTTPError, ValueError) as error:
            log.warning("уведомление владельцу не отправлено: %s", error.__class__.__name__)
            return False
        if response.status_code != 200:
            log.warning("уведомление владельцу не отправлено: Telegram ответил %s", response.status_code)
            return False
        return True

    async def close(self) -> None:
        await self.client.aclose()


def _number(value: Any, digits: int = 0) -> str:
    if value is None:
        return "—"
    text = f"{value:,.{digits}f}".replace(",", " ").replace(".", ",")
    return text


def _share(value: Any) -> str:
    return "—" if value is None else f"{_number(value * 100, 1)} %"


def _change(tile: dict[str, Any]) -> str:
    change = tile.get("change")
    if change is None or abs(change) < 0.005:
        return ""
    return f" ({'▲' if change > 0 else '▼'} {_number(abs(change) * 100, 0)} %)"


def digest_text(day: str, pulse: dict[str, Any], errors: dict[str, Any] | None, traffic: dict[str, Any] | None, url: str) -> str:
    """Итоги дня словами продукта (`contracts/insight-reports.md`): люди, разговоры, вход, ошибки, роботы."""
    tiles = pulse.get("tiles", {})

    def tile(name: str) -> dict[str, Any]:
        return tiles.get(name) or {}

    date = datetime.strptime(day, "%Y-%m-%d").strftime("%d.%m")
    lines = [
        f"Cord · итоги {date}",
        f"Люди: {_number(tile('people').get('value'))}{_change(tile('people'))}, новых — {_number(tile('new_people').get('value'))}",
        f"Собеседники: {_number(tile('interlocutors').get('value'))}{_change(tile('interlocutors'))}, за неделю — {_number(tile('weekly_interlocutors').get('value'))}",
        f"Разговоры: {_number(tile('talk_hours').get('value'), 1)} ч{_change(tile('talk_hours'))}",
        f"Вход: {_share(tile('join_success').get('value'))} успешных, сессий без ошибок — {_share(tile('error_free_sessions').get('value'))}",
    ]
    if errors:
        totals = errors.get("totals", {})
        new = totals.get("new_groups") or 0
        lines.append(
            f"Ошибки: {_number(totals.get('events'))} ({_number(totals.get('groups'))} видов"
            + (f", новых — {_number(new)}" if new else "")
            + f"), затронуто людей — {_number(totals.get('people_affected'))}"
        )
    if traffic:
        totals = traffic.get("totals", {})
        robots = (totals.get("bot") or 0) + (totals.get("automation") or 0)
        lines.append(f"Заходы: {_number(totals.get('visits'))}, из них люди — {_share(totals.get('human_share'))}, роботы — {_number(robots)}")
    if url:
        lines.append(f"Подробно: {url}")
    return "\n".join(lines)


class Daily:
    """Раз в сутки, в назначенный час по поясу аналитики, — итоги вчерашнего дня продукта."""

    def __init__(
        self,
        telegram: Telegram,
        report: Callable[[str, dict[str, str]], Awaitable[dict[str, Any]]],
        *,
        hour: int,
        offset_hours: int = 3,
        marker: Path | None = None,
        url: str = "",
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self.telegram = telegram
        self.report = report
        self.hour = hour
        self.zone = timezone(timedelta(hours=offset_hours))
        self.marker = marker
        self.url = url
        self.now = now or (lambda: datetime.now(self.zone))

    @property
    def enabled(self) -> bool:
        return self.telegram.enabled and 0 <= self.hour <= 23

    def _sent(self) -> str:
        try:
            return self.marker.read_text().strip() if self.marker else ""
        except OSError:
            return ""

    def due(self) -> str | None:
        """День, итоги которого пора отправить: вчера, если назначенный час наступил и вчера ещё не отправлено."""
        now = self.now()
        if now.hour < self.hour:
            return None
        day = (now - timedelta(days=1)).strftime("%Y-%m-%d")
        return None if self._sent() == day else day

    async def tick(self) -> bool:
        day = self.due()
        if not day:
            return False
        params = {"from": day, "to": day, "compare": "1"}
        try:
            pulse = await self.report("pulse", params)
        except Exception as error:  # noqa: BLE001 — аналитика лежит: попробуем в следующий раз
            log.warning("итоги дня: отчёт не получен: %s", error.__class__.__name__)
            return False

        async def optional(section: str) -> dict[str, Any] | None:
            try:
                return (await self.report(section, params)).get("data")
            except Exception:  # noqa: BLE001 — без этого раздела итоги короче, но всё равно уходят
                return None

        text = digest_text(day, pulse.get("data", {}), await optional("errors"), await optional("traffic"), self.url)
        if not await self.telegram.send(text):
            return False
        if self.marker:
            try:
                self.marker.write_text(day)
            except OSError:
                log.warning("итоги дня: отметка об отправке не записана")
        return True

    async def run(self) -> None:
        if not self.enabled:
            return
        while True:
            try:
                await self.tick()
            except Exception:  # noqa: BLE001
                log.exception("итоги дня: сбой")
            await asyncio.sleep(600)
