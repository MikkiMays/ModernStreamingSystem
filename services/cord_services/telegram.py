from __future__ import annotations

import asyncio
import re
import secrets
import uuid

import httpx
from fastapi import HTTPException

from .core import Core
from .media import MAX_FILE, probe
from .music import Music
from .store import Store, now

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

Привязка отдельная для каждого чата и темы. Громкость для себя регулируется в Cord, в списке участников. Telegram позволяет боту скачать файл до 20 МБ; в Cord можно загрузить до 50 МБ."""


class Telegram:
    def __init__(
        self,
        token: str,
        store: Store,
        core: Core,
        music: Music,
        public_url: str,
        yandex=None,
    ):
        self.yandex = yandex
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
        me = await self.api("getMe")
        self.username = me["username"]
        self.me_id = me["id"]
        self.store.set_state("bot_username", self.username)
        commands = [
            {"command": command, "description": description}
            for command, description in COMMANDS
        ]
        await self.api("setMyCommands", {"commands": commands})
        await self.api("setMyCommands", {"commands": commands, "language_code": "ru"})
        await self.api("setMyName", {"name": "Cord · встречи и музыка"})
        await self.api(
            "setMyDescription",
            {
                "description": "Создавайте встречи Cord прямо в Telegram, связывайте комнаты с чатами и темами, отправляйте музыку в общую очередь. /help — подключение и все команды."
            },
        )
        await self.api(
            "setMyShortDescription",
            {
                "short_description": "Встречи Cord и общая музыкальная очередь. Добавьте в чат и отправьте /meet."
            },
        )
        await self.api("setChatMenuButton", {"menu_button": {"type": "commands"}})
        await self.api(
            "setMyDefaultAdministratorRights",
            {
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
                    "can_post_stories": False,
                    "can_edit_stories": False,
                    "can_delete_stories": False,
                },
            },
        )
        info = await self.api("getWebhookInfo")
        if info.get("url"):
            raise HTTPException(
                409, "У бота уже настроен webhook; сначала отключите его"
            )
        self.ready = True
        self.store.set_state("bot_status", "polling")

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

    async def ensure_room(
        self, message: dict, create: bool = False, title: str = "", update_id: int = 0
    ):
        scope = self.scope(message)
        binding = self.store.binding(scope)
        if binding is None or create:
            if message["chat"]["type"] == "channel":
                raise HTTPException(
                    400,
                    "Создайте комнату в Cord и привяжите канал командой /bind. Так права организатора останутся у вас",
                )
            await self.admin(message)
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
        info = await self.core.request("GET", f"/internal/services/{binding['roomId']}")
        if info.get("closedAt"):
            await self.core.request(
                "POST",
                f"/api/v1/favorites/{binding['roomId']}/join",
                {"commandId": str(uuid.uuid4()), "name": binding["ownerName"]},
                binding["profile"],
            )
            info = await self.core.request(
                "GET", f"/internal/services/{binding['roomId']}"
            )
        return binding, info

    async def show_meeting(self, message: dict, update_id: int, create=False, title=""):
        binding, info = await self.ensure_room(message, create, title, update_id)
        invite = await self.core.request(
            "POST", f"/internal/services/{binding['roomId']}/invite"
        )
        buttons = [[{"text": "Войти во встречу", "url": invite["url"]}]]
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

    async def add_audio(self, message: dict, binding: dict, update_id: int):
        source = message.get("reply_to_message") or message
        audio = source.get("audio") or source.get("voice") or source.get("document")
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
            }
            await self.music.enqueue(room_id, track)
            self.store.remember("tg-audio", key, {"id": key})
            await self.reply(message, "Добавлено в очередь: " + title)
        except BaseException:
            if not any(t["id"] == key for t in self.store.get(room_id)["queue"]):
                path.unlink(missing_ok=True)
            raise

    async def handle(self, update: dict):
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
            return
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
                self.store.bind(
                    self.scope(message),
                    {
                        **claim,
                        "ownerId": message.get("from", {}).get(
                            "id", message["chat"]["id"]
                        ),
                    },
                )
                self.store.delete_claim(arg)
                await self.reply(
                    message,
                    "Комната «"
                    + claim["title"]
                    + "» привязана к этому чату или теме. /meet — вход, /play — музыка.",
                )
            elif command == "unbind":
                await self.admin(message)
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
                    if (
                        not info.get("integrationsAllowed", True)
                        and message.get("from", {}).get("id") != binding["ownerId"]
                    ):
                        raise HTTPException(
                            403,
                            "Организатор разрешил управление интеграциями только себе",
                        )
                if command == "search" or (
                    command == "play"
                    and arg
                    and not message.get("reply_to_message")
                    and not any(k in message for k in ("audio", "voice", "document"))
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
                    or any(k in message for k in ("audio", "voice", "document"))
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
                            "play": "Продолжаем музыку",
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
                        "allowed_updates": ["message", "channel_post"],
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
