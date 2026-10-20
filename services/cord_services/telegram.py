from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid

import httpx
from fastapi import HTTPException

from . import covers
from .cinema.limits import Window
from .core import Core
from .media import MAX_FILE, probe
from .music import Music
from .store import Store, now
from .webapp import (
    LINK_PREFIX,
    InitDataError,
    Memberships,
    Refusal,
    display_name,
    release,
    startapp_url,
    verify_init_data,
)

COMMANDS = [
    ("meet", "Открыть встречу этого чата"),
    ("new", "Создать и назначить новую встречу"),
    ("room", "Показать привязанную комнату"),
    ("bind", "Привязать комнату по коду из Cord"),
    ("unbind", "Отвязать комнату от чата"),
    ("search", "Найти треки в Яндекс Музыке"),
    ("play", "Добавить аудио: ответьте этой командой на файл"),
    ("pause", "Поставить музыку на паузу"),
    ("resume", "Продолжить музыку"),
    ("skip", "Следующий трек"),
    ("queue", "Показать музыкальную очередь"),
    ("now", "Что сейчас играет"),
    ("next", "Переместить трек следующим: /next 3"),
    ("remove", "Удалить трек по номеру: /remove 3"),
    ("shuffle", "Перемешать следующие треки"),
    ("repeat", "Повторять очередь: /repeat on или off"),
    ("stop", "Остановить текущий трек"),
    ("clear", "Очистить следующие треки"),
    ("help", "Все команды и подключение"),
    ("start", "Начать работу с Cord"),
]

HELP = """Cord — встречи и общая музыка.

/meet — открыть встречу чата; при первом вызове создать её
/new Название — новая комната по умолчанию (администратор)
/room — текущая привязка
/bind код — привязать свою комнату. Код выдаёт организатор в Cord → Интеграции → Telegram
/unbind — убрать привязку (администратор)

Перешлите аудиофайл в чат и ответьте на него /play@{bot}. Подходит и файл, найденный через другого бота. В личном чате можно просто отправить аудио.

/search название — поиск в Яндекс Музыке
/play название или ссылка — добавить трек из Яндекс Музыки
После /search можно выбрать /play 1. Для этого любой участник с разрешением на интеграции подключает аккаунт Яндекс Музыки в комнате.

/queue · /now · /pause · /resume · /skip
/next 3 · /remove 3 · /shuffle · /repeat on|off
/stop · /clear

Для простого @тега в подписи к аудио добавьте бота администратором или отключите Group Privacy в BotFather. Без этого используйте адресованную команду в ответ на файл.

Привязка отдельная для каждого чата и темы. Громкость для себя регулируется в Cord через ПКМ на участнике; плеер находится в блоке «Боты и интеграции». Telegram позволяет боту скачать файл до 20 МБ; в Cord можно загрузить до 50 МБ."""


class Telegram:
    def __init__(
        self,
        token: str,
        store: Store,
        core: Core,
        music: Music,
        public_url: str,
        yandex=None,
        *,
        webapp: bool = False,
        short_name: str = "",
        init_data_age: int = 3600,
    ):
        self.yandex = yandex
        # Mini App (E09, `TELEGRAM_WEBAPP_ENABLED`): кнопка «Открыть встречу» в беседе и вход по ней.
        self.webapp = webapp
        self.short_name = short_name
        self.init_data_age = init_data_age
        self.memberships = Memberships()
        # Вход через Mini App — на пользователя Telegram: перезагрузка WebView и пара повторов — да,
        # перебор кнопок разных бесед — нет.
        self.entries = Window(
            20, 600, "Слишком много входов подряд. Подождите несколько минут"
        )
        self.token = token
        self.store = store
        self.core = core
        self.music = music
        self.public_url = public_url
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(40, connect=10), follow_redirects=False
        )
        self.username = store.state("bot_username", "cord_meet_bot")
        self.ready = False
        self.me_id = None
        # Пределы бота (A11 docs/abuse-model.md). Новые встречи — на пользователя Telegram в час:
        # иначе `/new` в личке создавал комнату на каждое сообщение. Команды — на чат в минуту:
        # лишние остаются без ответа, и поток спама из одного чата не задерживает остальные.
        self.meetings = Window(
            int(os.environ.get("TELEGRAM_MEETINGS_PER_USER", "3")),
            3600,
            "Слишком много новых встреч за час. Попробуйте позже или откройте прежнюю: /meet",
        )
        self.commands = Window(int(os.environ.get("TELEGRAM_COMMANDS_PER_CHAT", "20")), 60, "")

    async def api(self, method: str, data: dict | None = None):
        try:
            response = await self.client.post(
                "https://api.telegram.org/bot" + self.token + "/" + method,
                json=data or {},
            )
            body = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, "Telegram временно недоступен") from None
        if not body.get("ok"):
            # Never propagate request URLs: Telegram embeds the bot token in the path.
            raise HTTPException(
                503, "Telegram отклонил запрос. Проверьте права бота в чате"
            )
        return body["result"]

    async def configure(self):
        """Готовит бота к работе: кто он и можно ли получать обновления.

        Оформление — имя, описание, список команд, права по умолчанию — сюда не входит:
        его применяет `describe`, и его отказ ничего не останавливает.
        """
        me = await self.api("getMe")
        self.username = me["username"]
        self.me_id = me["id"]
        self.store.set_state("bot_username", self.username)
        info = await self.api("getWebhookInfo")
        if info.get("url"):
            raise HTTPException(
                409, "У бота уже настроен webhook; сначала отключите его"
            )
        await self.describe()
        self.ready = True
        self.store.set_state("bot_status", "polling")

    async def describe(self):
        """Имя, описание, команды и права по умолчанию — вежливость, а не условие работы.

        ЗАЧЕМ ОТДЕЛЬНО. Telegram ограничивает смену имени жёстко: после нескольких
        обращений подряд `setMyName` отвечает 429 с ожиданием в часы. Раньше это делалось
        при каждом запуске процесса и внутри той же попытки, что и `getMe`, поэтому
        несколько перезапусков сервиса подряд — обычное дело при выкатке — оставляли бота
        молчащим на полдня: он бесконечно повторял настройку и ни разу не доходил до
        получения обновлений. Оформление применяется, только когда оно изменилось, а его
        отказ не мешает боту отвечать: без отметки следующая попытка повторит его сама.
        """
        commands = [
            {"command": command, "description": description}
            for command, description in COMMANDS
        ]
        name = "Cord · встречи и музыка"
        description = (
            (
                "Cord — видеовстречи прямо из чата. Создатель встречи привязывает её к беседе, и в "
                "чате появляется кнопка «Открыть встречу»: Cord открывается на весь экран, без "
                "регистрации. /help — подключение и все команды."
            )
            if self.webapp
            else (
                "Создавайте встречи Cord прямо в Telegram, связывайте комнаты с чатами и "
                "темами, отправляйте музыку в общую очередь. /help — подключение и все команды."
            )
        )
        short = "Встречи Cord и общая музыкальная очередь. Добавьте в чат и отправьте /meet."
        rights = {
            "for_channels": False,
            "rights": {
                "is_anonymous": False,
                "can_manage_chat": True,
                "can_delete_messages": False,
                "can_manage_video_chats": False,
                "can_restrict_members": False,
                "can_promote_members": False,
                "can_change_info": False,
                "can_invite_users": False,
                # Кнопку Mini App бот закрепляет в беседе при привязке (E09).
                "can_pin_messages": True,
                "can_post_stories": False,
                "can_edit_stories": False,
                "can_delete_stories": False,
            },
        }
        requests = [
            ("setMyCommands", {"commands": commands}),
            ("setMyCommands", {"commands": commands, "language_code": "ru"}),
            ("setMyName", {"name": name}),
            ("setMyDescription", {"description": description}),
            ("setMyShortDescription", {"short_description": short}),
            ("setChatMenuButton", {"menu_button": {"type": "commands"}}),
            ("setMyDefaultAdministratorRights", rights),
        ]
        stamp = hashlib.sha256(
            json.dumps(requests, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        if self.store.state("bot_profile") == stamp:
            return
        try:
            for method, payload in requests:
                await self.api(method, payload)
        except HTTPException:
            return
        self.store.set_state("bot_profile", stamp)

    @staticmethod
    def scope(message: dict) -> str:
        return f"{message['chat']['id']}:{message.get('message_thread_id', 0)}"

    async def admin(self, message: dict):
        if message["chat"]["type"] == "private":
            return
        if (
            message["chat"]["type"] == "channel"
            and message.get("sender_chat", {}).get("id") == message["chat"]["id"]
        ):
            return
        user = message.get("from", {})
        if not user.get("id") or user.get("is_bot"):
            raise HTTPException(
                403, "Команду должен отправить администратор от своего имени"
            )
        member = await self.api(
            "getChatMember", {"chat_id": message["chat"]["id"], "user_id": user["id"]}
        )
        if member.get("status") not in ("creator", "administrator"):
            raise HTTPException(403, "Менять привязку комнаты может администратор чата")

    async def reply(self, message: dict, text: str, keyboard=None):
        data = {
            "chat_id": message["chat"]["id"],
            "text": text[:4096],
            "link_preview_options": {"is_disabled": True},
            "reply_parameters": {
                "message_id": message["message_id"],
                "allow_sending_without_reply": True,
            },
        }
        if message.get("message_thread_id"):
            data["message_thread_id"] = message["message_thread_id"]
        if keyboard:
            data["reply_markup"] = {"inline_keyboard": keyboard}
        update_id = message.get("_cord_update_id")
        if update_id is not None:
            self.store.remember("telegram-outbox", str(update_id), data)
        return await self.api("sendMessage", data)

    @staticmethod
    def actor(message: dict) -> str:
        user = message.get("from", {})
        return (
            " ".join(filter(None, (user.get("first_name"), user.get("last_name"))))
            or "Участник Telegram"
        )[:40]

    def on_behalf(self, message: dict) -> dict:
        """
        Чей это запрос для пределов ядра (A11): `X-Cord-Actor: tg:<HMAC номера>`.

        Все запросы бота приходят в ядро с одного адреса, и без этого заголовка пользователи бота
        делили бы одну корзину пределов. Ядро верит заголовку только вместе с секретом службы, а
        номер пользователя видит лишь его HMAC.
        """
        return self.actor_header(message.get("from", {}).get("id") or message["chat"]["id"])

    def actor_header(self, who: int) -> dict:
        mark = hmac.new(self.core.secret.encode(), f"telegram-actor:{who}".encode(), hashlib.sha256)
        return {"X-Cord-Actor": "tg:" + mark.hexdigest()[:32]}

    async def reopen(self, binding: dict, headers: dict) -> dict:
        """Закрытую встречу беседы открыть заново — входом её создателя по избранному, как `/meet`."""
        await self.core.request(
            "POST",
            f"/api/v1/favorites/{binding['roomId']}/join",
            {"commandId": str(uuid.uuid4()), "name": binding["ownerName"]},
            binding["profile"],
            headers=headers,
        )
        return await self.core.request("GET", f"/internal/services/{binding['roomId']}")

    async def ensure_room(
        self, message: dict, create: bool = False, title: str = "", update_id: int = 0
    ):
        scope = self.scope(message)
        binding = self.store.binding(scope)
        info = None
        if binding is not None and create and message["chat"]["type"] == "private":
            # `/new` в личке, когда своя встреча ещё идёт, отвечает ею же: новая комната на каждое
            # сообщение — тот же поток встреч, что и от скрипта (A11).
            try:
                info = await self.core.request("GET", f"/internal/services/{binding['roomId']}")
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                info = None
            create = bool(info is None or info.get("closedAt"))
            if create:
                info = None
        if binding is not None and not create and info is None:
            # Встречу чата могло не стать: ядро удаляет комнату, в которую неделю никто не
            # заходил, и привязка после этого указывает в пустоту. Без этой ветки чат
            # оставался бы заперт навсегда — `/meet` спрашивал бы удалённую комнату и
            # отвечал «не найдена», а создать новую мешала бы та же самая привязка.
            #
            # Забытая встреча — это ровно то же состояние, что и «привязки ещё нет»:
            # возвращаться некуда, и разговор начинается заново. Все прочие ошибки идут
            # наверх как раньше: недоступное ядро — не повод заводить вторую комнату.
            try:
                info = await self.core.request(
                    "GET", f"/internal/services/{binding['roomId']}"
                )
            except HTTPException as error:
                if error.status_code != 404:
                    raise
                self.store.unbind(scope)
                binding = None
        if binding is None or create:
            if message["chat"]["type"] == "channel":
                raise HTTPException(
                    400,
                    "Создайте комнату в Cord и привяжите канал командой /bind. Так права организатора останутся у вас",
                )
            await self.admin(message)
            self.meetings.take(str(message.get("from", {}).get("id") or message["chat"]["id"]))
            profile_key = "tg-profile:" + str(self.me_id) + ":" + str(update_id)
            profile = self.store.state(profile_key) or secrets.token_urlsafe(32)
            self.store.set_state(profile_key, profile)
            command_id = str(
                uuid.uuid5(
                    uuid.NAMESPACE_URL, f"cord-telegram-room:{self.me_id}:{update_id}"
                )
            )
            admission = await self.core.request(
                "POST",
                "/api/v1/rooms",
                {
                    "commandId": command_id,
                    "title": (
                        title or message["chat"].get("title") or "Разговор в Telegram"
                    )[:80],
                    "name": self.actor(message),
                    "approvalRequired": False,
                },
                headers=self.on_behalf(message),
            )
            await self.core.request(
                "PUT",
                f"/api/v1/favorites/{admission['roomId']}",
                {"roomCredential": admission["credential"]},
                profile,
            )
            binding = {
                "roomId": admission["roomId"],
                "profile": profile,
                "title": admission["snapshot"]["title"],
                "ownerId": message["from"]["id"],
                "ownerName": self.actor(message),
            }
            self.store.bind(scope, binding)
            info = None
        if info is None:
            info = await self.core.request(
                "GET", f"/internal/services/{binding['roomId']}"
            )
        if info.get("closedAt"):
            info = await self.reopen(binding, self.on_behalf(message))
        return binding, info

    def link_for(self, message: dict, binding: dict) -> dict:
        """
        Номер привязки для кнопки Mini App этой беседы — действующий или новый.

        Номер — `b` и 16 случайных байт base64url: по нему нельзя угадать ни встречу, ни беседу, а
        код комнаты в открытую в кнопку не попадает. Привязка сменилась на другую встречу — старый
        номер отзывается, и его кнопка отвечает «привязка снята».
        """
        scope = self.scope(message)
        link = self.store.active_telegram_link(scope)
        if link and link["roomId"] == binding["roomId"]:
            return link
        if link:
            self.store.revoke_telegram_link(link["id"])
        link_id = LINK_PREFIX + secrets.token_urlsafe(16)
        body = {
            "chatId": message["chat"]["id"],
            "threadId": message.get("message_thread_id", 0),
            "chatTitle": message["chat"].get("title") or self.actor(message),
            "messageId": None,
            "pinned": False,
        }
        self.store.put_telegram_link(link_id, scope, binding["roomId"], body)
        return self.store.telegram_link(link_id)

    def webapp_button(self, link: dict) -> dict:
        return {
            "text": "Открыть встречу",
            "url": startapp_url(self.username, link["id"], self.short_name),
            # Bot API 9.4: выделенная кнопка. Старый клиент поле не знает и рисует обычную.
            "style": "primary",
        }

    async def bound(self, message: dict, binding: dict):
        """Ответ на привязку. С Mini App — сообщение с кнопкой «Открыть встречу», закреплённое в чате."""
        text = (
            "Комната «"
            + binding["title"]
            + "» привязана к этому чату или теме. /meet — вход, /play — музыка."
        )
        if not self.webapp:
            await self.reply(message, text)
            return
        previous = self.store.active_telegram_link(self.scope(message))
        if previous:
            await release(self.store, previous, self.api, keep_binding=True)
        link = self.link_for(message, binding)
        sent = await self.reply(
            message,
            "Встреча «" + binding["title"] + "» привязана к этому чату. Кнопка ниже открывает её "
            "прямо в Telegram, на весь экран. /meet — ссылка для браузера, /play — музыка.",
            [[self.webapp_button(link)]],
        )
        message_id = sent.get("message_id") if isinstance(sent, dict) else None
        pinned = False
        if message_id:
            try:
                await self.api(
                    "pinChatMessage",
                    {
                        "chat_id": message["chat"]["id"],
                        "message_id": message_id,
                        "disable_notification": True,
                    },
                )
                pinned = True
            except HTTPException:
                # Нет права закрепа — кнопка остаётся в сообщении, просто без закрепа.
                pinned = False
        body = {k: link[k] for k in ("chatId", "threadId", "chatTitle")}
        self.store.update_telegram_link(
            link["id"], {**body, "messageId": message_id, "pinned": pinned}
        )

    async def webapp_enter(self, raw: str, clock: float | None = None) -> dict:
        """
        Вход через Mini App: `initData` → привязка → членство → приглашение во встречу.

        Ответ — `{roomId, title, name, inviteUrl}`: браузер входит по приглашению сам, со своего
        адреса и своим профилем устройства, а имя берёт отсюда, из проверенной строки.
        """
        try:
            data = verify_init_data(
                raw, self.token, time.time() if clock is None else clock, self.init_data_age
            )
        except InitDataError:
            raise Refusal(
                401, "TELEGRAM_INIT_DATA", "Ссылка устарела. Откройте встречу заново из чата"
            ) from None
        user = data.get("user")
        if not isinstance(user, dict) or not isinstance(user.get("id"), int):
            raise Refusal(401, "TELEGRAM_INIT_DATA", "Ссылка устарела. Откройте встречу заново из чата")
        self.entries.take(str(user["id"]))
        link = self.store.telegram_link(data.get("start_param", ""))
        if link is None:
            raise Refusal(
                404, "TELEGRAM_LINK_UNKNOWN", "Откройте встречу кнопкой из чата, к которому она привязана"
            )
        if link["revokedAt"]:
            raise Refusal(
                410, "TELEGRAM_LINK_REVOKED", "Привязка снята. Попросите создателя встречи привязать её заново"
            )
        if not await self.memberships.check(self.api, link["chatId"], user["id"]):
            raise Refusal(403, "TELEGRAM_NOT_MEMBER", "Вы не состоите в чате, к которому привязана встреча")
        binding = self.store.binding(link["scope"])
        if not binding or binding["roomId"] != link["roomId"]:
            self.store.revoke_telegram_link(link["id"])
            raise Refusal(
                410, "TELEGRAM_LINK_REVOKED", "Привязка снята. Попросите создателя встречи привязать её заново"
            )
        try:
            info = await self.core.request("GET", f"/internal/services/{binding['roomId']}")
        except HTTPException as error:
            if error.status_code != 404:
                raise
            await release(self.store, link, self.api)
            raise Refusal(
                410, "TELEGRAM_MEETING_GONE", "Этой встречи больше нет. Создайте новую в чате: /meet"
            ) from None
        if info.get("closedAt"):
            info = await self.reopen(binding, self.actor_header(user["id"]))
        invite = await self.core.request("POST", f"/internal/services/{binding['roomId']}/invite")
        return {
            "roomId": binding["roomId"],
            "title": info["title"],
            "name": display_name(user),
            "inviteUrl": invite["url"],
        }

    async def show_meeting(self, message: dict, update_id: int, create=False, title=""):
        binding, info = await self.ensure_room(message, create, title, update_id)
        invite = await self.core.request(
            "POST", f"/internal/services/{binding['roomId']}/invite"
        )
        buttons = [[{"text": "Войти во встречу", "url": invite["url"]}]]
        if self.webapp:
            # Mini App — первой: прямо в Telegram, на весь экран; ссылка в браузер — запасной путь.
            buttons.insert(0, [self.webapp_button(self.link_for(message, binding))])
        text = f"{info['title']}\nКод: {info['code'][:3]}-{info['code'][3:6]}-{info['code'][6:]}\nПо ссылке можно войти без ожидания допуска."
        if (
            message.get("from", {}).get("id") == binding["ownerId"]
            and not info["ownerPresent"]
        ):
            token = secrets.token_urlsafe(18)
            self.store.put_claim(token, {"kind": "telegram-host", **binding})
            buttons.append(
                [
                    {
                        "text": "Войти организатором",
                        "url": f"https://t.me/{self.username}?start=host_{token}",
                    }
                ]
            )
        await self.reply(message, text, buttons)

    async def host_link(self, message: dict, token: str):
        if message["chat"]["type"] != "private":
            raise HTTPException(
                403, "Ссылка организатора выдаётся в личном чате с ботом"
            )
        value = self.store.claim(token)
        if (
            not value
            or value["kind"] != "telegram-host"
            or value["ownerId"] != message["from"]["id"]
        ):
            raise HTTPException(
                403, "Эта ссылка предназначена создателю встречи или уже истекла"
            )
        web_token = secrets.token_urlsafe(24)
        self.store.put_claim(web_token, {**value, "kind": "web-host"})
        self.store.delete_claim(token)
        await self.reply(
            message,
            "Ваш вход организатора. Ссылка действует 15 минут и используется один раз.",
            [
                [
                    {
                        "text": "Открыть Cord",
                        "url": self.public_url + "/host#token=" + web_token,
                    }
                ]
            ],
        )

    @staticmethod
    def audio_from(message: dict):
        # A quote from another chat uses external_reply, rather than reply_to_message.
        for source in (message, message.get("reply_to_message") or {}, message.get("external_reply") or {}):
            for kind in ("audio", "voice", "document"):
                if source.get(kind, {}).get("file_id"):
                    return source[kind]
        return None

    def recent_audio_key(self, message: dict):
        actor = message.get("from", {}).get("id") or message.get("sender_chat", {}).get("id")
        return self.scope(message) + ":" + str(actor)

    async def add_audio(self, message: dict, binding: dict, update_id: int):
        audio = self.audio_from(message)
        if not audio or not audio.get("file_id"):
            raise HTTPException(
                400,
                f"Перешлите аудиофайл и ответьте на него /play@{self.username}. Ссылка на каталог или поисковый запрос не является аудиофайлом",
            )
        if audio.get("file_size", 0) > 20 * 1024 * 1024:
            raise HTTPException(
                413,
                "Telegram отдаёт ботам файлы до 20 МБ. Этот файл можно загрузить в Cord через Интеграции → Музыка (до 50 МБ)",
            )
        room_id = binding["roomId"]
        # A room-to-chat binding is explicit host consent for members of that chat to control its music.
        if not self.store.get(room_id)["enabled"]:
            await self.music.enable(
                room_id,
                str(
                    uuid.uuid5(uuid.NAMESPACE_URL, f"tg-music:{self.me_id}:{update_id}")
                ),
            )
        key = str(uuid.uuid5(uuid.NAMESPACE_URL, f"tg-audio:{self.me_id}:{update_id}"))
        if self.store.receipt("tg-audio", key):
            return
        self.music.check_quota(room_id, audio.get("file_size", 0))
        remote = await self.api("getFile", {"file_id": audio["file_id"]})
        remote_path = remote.get("file_path", "")
        if not re.fullmatch(
            r"[A-Za-z0-9_./-]+", remote_path
        ) or ".." in remote_path.split("/"):
            raise HTTPException(400, "Telegram не вернул аудиофайл")
        path = self.store.files / key
        cover = None
        try:
            total = 0
            async with self.client.stream(
                "GET",
                "https://api.telegram.org/file/bot" + self.token + "/" + remote_path,
            ) as response:
                if response.status_code != 200:
                    raise HTTPException(503, "Не удалось скачать аудио из Telegram")
                with path.open("wb") as output:
                    async for chunk in response.aiter_bytes(65536):
                        total += len(chunk)
                        if total > MAX_FILE:
                            raise HTTPException(413, "Аудиофайл слишком большой")
                        output.write(chunk)
            metadata = await probe(path)
            cover = await covers.extract(path, self.store.files)
            title = str(
                audio.get("title")
                or metadata["title"]
                or audio.get("file_name")
                or "Аудио из Telegram"
            )[:180]
            track = {
                "id": key,
                "file": key,
                **metadata,
                "title": title,
                "artist": str(audio.get("performer") or metadata["artist"])[:120],
                "addedBy": self.actor(message),
                "source": "telegram",
                "createdAt": now(),
                "cover": cover,
            }
            await self.music.enqueue(room_id, track)
            self.store.remember("tg-audio", key, {"id": key})
            if message.get("_cord_recent_key"):
                self.store.remember("tg-recent-audio", message["_cord_recent_key"], {"used": True})
            await self.reply(message, "Добавлено в очередь: " + title)
        except BaseException:
            if not any(t["id"] == key for t in self.store.get(room_id)["queue"]):
                path.unlink(missing_ok=True)
                if cover:
                    (self.store.files / cover).unlink(missing_ok=True)
            raise

    async def left(self, change: dict):
        """Бота исключили из беседы или он вышел: её привязки Mini App отзываются."""
        status = change.get("new_chat_member", {}).get("status")
        if status not in ("left", "kicked"):
            return
        chat_id = change.get("chat", {}).get("id")
        for link in self.store.chat_telegram_links(chat_id):
            await release(self.store, link)

    async def handle(self, update: dict):
        if update.get("my_chat_member"):
            await self.left(update["my_chat_member"])
            return
        message = update.get("message") or update.get("channel_post")
        if not message or message.get("from", {}).get("is_bot"):
            return  # Prevent bot-to-bot loops; a user-forwarded file is accepted.
        update_id = update["update_id"]
        if self.store.receipt("telegram-update", str(update_id)):
            return
        message["_cord_update_id"] = update_id
        outbox = self.store.receipt("telegram-outbox", str(update_id))
        if outbox:
            await self.api("sendMessage", outbox)
            self.store.remember("telegram-update", str(update_id), {"done": True})
            return
        text = (message.get("text") or message.get("caption") or "").strip()
        match = re.match(r"^/([a-z_]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$", text, re.S)
        command, arg = "", ""
        if match:
            command, target, arg = match.groups()
            arg = arg or ""
            if target and target.casefold() != self.username.casefold():
                return
        elif "@" + self.username.casefold() in text.casefold():
            command = (
                "play"
                if any(key in message for key in ("audio", "voice", "document"))
                or message.get("reply_to_message")
                else "meet"
            )
        elif message["chat"]["type"] == "private" and any(
            key in message for key in ("audio", "voice", "document")
        ):
            command = "play"
        else:
            # A forwarded file and the following /play are separate Telegram updates.
            # Keep metadata only, scoped to the sender and the current chat/topic/room.
            audio = self.audio_from(message)
            binding = self.store.binding(self.scope(message))
            if audio and binding:
                self.store.remember("tg-recent-audio", self.recent_audio_key(message),
                    {"audio": audio, "at": now(), "roomId": binding["roomId"]})
                self.store.remember("telegram-update", str(update_id), {"done": True})
            return
        if command:
            try:
                self.commands.take(str(message["chat"]["id"]))
            except HTTPException:
                # Лишняя команда чата — без ответа: ответ на каждую и был бы тем потоком, ради
                # которого спамят.
                self.store.remember("telegram-update", str(update_id), {"done": True})
                return
        if command == "play" and not arg and not self.audio_from(message) and not message.get("reply_to_message") and not message.get("external_reply"):
            key = self.recent_audio_key(message)
            recent = self.store.receipt("tg-recent-audio", key)
            binding = self.store.binding(self.scope(message))
            if recent and not recent.get("used") and now() - recent["at"] < 300000 and binding and binding["roomId"] == recent["roomId"]:
                message["audio"] = recent["audio"]
                message["_cord_recent_key"] = key
        if (
            command == "start"
            and arg
            and not arg.startswith("host_")
            and message["chat"]["type"] in ("group", "supergroup")
        ):
            # «Добавить бота в группу» из Cord (`startgroup=<код>`): Telegram добавил бота и прислал
            # в группу `/start <код>` от того, кто добавлял, — это та же привязка, что `/bind <код>`.
            command = "bind"
        try:
            if command == "start" and arg.startswith("host_"):
                await self.host_link(message, arg[5:])
            elif command in ("start", "help"):
                await self.reply(message, HELP.format(bot=self.username))
            elif command in ("meet", "new"):
                await self.show_meeting(message, update_id, command == "new", arg)
            elif command == "bind":
                await self.admin(message)
                claim = self.store.claim(arg)
                if not claim or claim["kind"] != "bind":
                    raise HTTPException(
                        400,
                        "Получите свежий код: Cord → Интеграции → Telegram → Связать с чатом",
                    )
                binding = {
                    **claim,
                    "ownerId": message.get("from", {}).get("id", message["chat"]["id"]),
                }
                self.store.bind(self.scope(message), binding)
                self.store.delete_claim(arg)
                await self.bound(message, binding)
            elif command == "unbind":
                await self.admin(message)
                link = self.store.active_telegram_link(self.scope(message))
                if link:
                    # Закреп снимается, кнопка из сообщения уходит, старые ссылки отвечают «снята».
                    await release(self.store, link, self.api)
                self.store.unbind(self.scope(message))
                await self.reply(
                    message, "Привязка удалена. Сама встреча продолжает работать."
                )
            else:
                binding = self.store.binding(self.scope(message))
                if not binding:
                    raise HTTPException(
                        400,
                        "Для этого чата пока нет комнаты. /meet — создать, /bind — привязать существующую",
                    )
                room_id = binding["roomId"]
                if command in {
                    "play",
                    "search",
                    "pause",
                    "resume",
                    "skip",
                    "stop",
                    "clear",
                    "repeat",
                    "shuffle",
                    "remove",
                    "next",
                }:
                    info = await self.core.request(
                        "GET", f"/internal/services/{room_id}"
                    )
                    # Люди беседы — не участники встречи, снимка «глазами» каждого нет. За них
                    # отвечает ядро: `participantCan` — что может обычный участник. Привязавший
                    # беседу — создатель встречи (команду `/bind` выдаёт только ему
                    # `telegram.link`), и ему музыку можно всегда. Старое ядро поля не знает —
                    # тогда прежний флаг.
                    allowed = info.get("participantCan")
                    if (
                        "music.control" not in allowed
                        if isinstance(allowed, list)
                        else not info.get("integrationsAllowed", True)
                    ) and message.get("from", {}).get("id") != binding["ownerId"]:
                        raise HTTPException(
                            403,
                            "Организатор разрешил управление интеграциями только себе",
                        )
                if command == "search" or (
                    command == "play"
                    and arg
                    and not message.get("reply_to_message")
                    and not message.get("external_reply")
                    and not self.audio_from(message)
                ):
                    if not self.yandex:
                        raise HTTPException(
                            503, "Коннектор Яндекс Музыки ещё не подключён"
                        )
                    if not arg:
                        raise HTTPException(
                            400, "Напишите /search и название трека или исполнителя"
                        )
                    selection_key = (
                        self.scope(message)
                        + ":"
                        + str(message.get("from", {}).get("id"))
                    )
                    previous = self.store.receipt("tg-yandex-search", selection_key)
                    if (
                        command == "play"
                        and arg.isdigit()
                        and previous
                        and 1 <= int(arg) <= len(previous["tracks"])
                    ):
                        tracks = [previous["tracks"][int(arg) - 1]]
                    else:
                        tracks = await self.yandex.search("room:" + room_id, arg)
                    if not tracks:
                        raise HTTPException(
                            404, "Треки не найдены. Попробуйте другое название"
                        )
                    if command == "search":
                        tracks = tracks[:10]
                        self.store.remember(
                            "tg-yandex-search", selection_key, {"tracks": tracks}
                        )
                        lines = [
                            f"{i + 1}. {t['title']} — {t['artist']}"
                            for i, t in enumerate(tracks)
                        ]
                        await self.reply(
                            message,
                            "\n".join(lines) + "\n\n/play 1 — добавить выбранный трек",
                        )
                    else:
                        await self.ensure_room(message)
                        operation_id = str(
                            uuid.uuid5(
                                uuid.NAMESPACE_URL,
                                f"tg-yandex:{self.me_id}:{update_id}",
                            )
                        )
                        if not self.store.get(room_id)["enabled"]:
                            await self.music.enable(room_id, operation_id)
                        await self.yandex.enqueue(
                            room_id,
                            "room:" + room_id,
                            tracks[0]["id"],
                            operation_id,
                            self.actor(message),
                        )
                        await self.reply(
                            message, "Добавлено из Яндекс Музыки: " + tracks[0]["title"]
                        )
                elif command == "room":
                    info = await self.core.request(
                        "GET", f"/internal/services/{room_id}"
                    )
                    await self.reply(
                        message,
                        f"Комната: {info['title']}\nКод: {info['code']}\n/meet — открыть, /bind — сменить привязку",
                    )
                elif command == "play" and (
                    message.get("reply_to_message")
                    or message.get("external_reply")
                    or self.audio_from(message)
                ):
                    await self.ensure_room(message)
                    await self.add_audio(message, binding, update_id)
                elif command in ("queue", "now"):
                    state = self.store.get(room_id)
                    tracks = (
                        state["queue"][:1] if command == "now" else state["queue"][:30]
                    )
                    lines = [
                        f"{i + 1}. {t['title']}"
                        + (f" — {t['artist']}" if t["artist"] else "")
                        for i, t in enumerate(tracks)
                    ]
                    await self.reply(
                        message,
                        ("На паузе\n" if state["paused"] else "Сейчас и далее\n")
                        + ("\n".join(lines) or "Очередь пуста"),
                    )
                elif command in {
                    "pause",
                    "resume",
                    "play",
                    "skip",
                    "stop",
                    "clear",
                    "repeat",
                    "shuffle",
                    "remove",
                    "next",
                }:
                    if command in ("play", "resume") and not self.store.get(room_id)["queue"]:
                        raise HTTPException(400, f"Очередь пуста: трек не получен. Ответьте на сообщение с аудиофайлом /play@{self.username} или добавьте эту команду в подпись к файлу. Отдельная команда не передаёт боту предыдущее сообщение, если Telegram его скрыл.")
                    if (
                        command in ("play", "resume")
                        and not self.store.get(room_id)["enabled"]
                    ):
                        await self.ensure_room(message)
                        await self.music.enable(
                            room_id,
                            str(
                                uuid.uuid5(
                                    uuid.NAMESPACE_URL,
                                    f"tg-enable:{self.me_id}:{update_id}",
                                )
                            ),
                        )
                    data = {
                        "commandId": str(
                            uuid.uuid5(
                                uuid.NAMESPACE_URL,
                                f"tg-command:{self.me_id}:{update_id}",
                            )
                        ),
                        "action": "play" if command == "resume" else command,
                    }
                    if command in ("remove", "next"):
                        queue = self.store.get(room_id)["queue"]
                        if not arg.isdigit() or not 1 <= int(arg) <= len(queue):
                            raise HTTPException(
                                400,
                                "Укажите номер из /queue, например /" + command + " 3",
                            )
                        data["trackId"] = queue[int(arg) - 1]["id"]
                    if command == "repeat":
                        if arg.casefold() not in ("on", "off", "вкл", "выкл"):
                            raise HTTPException(
                                400, "Используйте /repeat on или /repeat off"
                            )
                        data["enabled"] = arg.casefold() in ("on", "вкл")
                    await self.music.command(room_id, data)
                    await self.reply(
                        message,
                        {
                            "pause": "Музыка на паузе",
                            "resume": "Продолжаем музыку",
                            "play": "Продолжаем музыку из очереди. Чтобы включить пересланный трек, ответьте на него /play@" + self.username,
                            "skip": "Переключаем трек",
                            "stop": "Воспроизведение остановлено",
                            "clear": "Следующие треки удалены",
                            "shuffle": "Следующие треки перемешаны",
                            "repeat": "Режим повтора изменён",
                            "remove": "Трек удалён",
                            "next": "Трек будет следующим",
                        }[command],
                    )
                else:
                    await self.reply(
                        message, "Неизвестная команда. /help — список возможностей"
                    )
            self.store.remember("telegram-update", str(update_id), {"done": True})
        except HTTPException as error:
            if self.store.receipt("telegram-outbox", str(update_id)):
                raise  # The mutation completed. Retry only its durable reply, never the command.
            await self.reply(message, str(error.detail))
            self.store.remember("telegram-update", str(update_id), {"done": True})

    async def run(self):
        while not self.ready:
            try:
                await self.configure()
            except HTTPException:
                self.store.set_state("bot_status", "configuration-retry")
                await asyncio.sleep(10)
        while True:
            try:
                offset = int(self.store.state("telegram_offset", "0"))
                updates = await self.api(
                    "getUpdates",
                    {
                        "offset": offset,
                        "timeout": 25,
                        # `my_chat_member` — бота убрали из беседы: её кнопка Mini App больше не
                        # ведёт никуда, и привязка отзывается (E09).
                        "allowed_updates": ["message", "channel_post", "my_chat_member"],
                        "limit": 20,
                    },
                )
                for update in updates:
                    await self.handle(update)
                    self.store.set_state(
                        "telegram_offset", str(update["update_id"] + 1)
                    )
                self.store.set_state("bot_status", "polling")
            except asyncio.CancelledError:
                raise
            except Exception:
                # No raw exception logging here: client exceptions can contain token-bearing URLs.
                self.store.set_state("bot_status", "retrying")
                await asyncio.sleep(3)
