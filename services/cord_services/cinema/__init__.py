"""Кинозал: комната смотрит с площадок реестра (YouTube, Twitch, Rutube, VK Видео, ivi, «По ссылке»),
а видео берёт **сервер**, не браузер.

ПОЧЕМУ НЕ ВСТРАИВАЕМЫЙ ПЛЕЕР. Он был, и с машины сервера работал. У человека — нет: из его
сети `youtube.com` и `twitch.tv` попросту недоступны, и встраивание в этом случае не лечится
ничем — рамка чужая, ходит она из браузера. Поэтому источник переехал на сервер: он достаёт
плейлист и сегменты, а комнате отдаёт их со своего адреса. Заодно исчезли и чужие скрипты на
странице, и послабления в CSP, и «выберите качество в шестерёнке YouTube» — качество теперь
настоящий список уровней HLS, которым управляет наш собственный плеер.

ЧТО ИМЕННО ПРОКСИРУЕТСЯ. Только то, на что мы сами выдали подпись: маршрут, площадка, адрес и
срок под HMAC на `INTERNAL_SECRET`, да ещё и хост из политики **этой** площадки. Без этого
открытый прокси чужого трафика на своей машине — вопрос одного любопытного, а не времени. У
длинных плейлистов подпись заменена нумерацией — см. {@link Reels}, — но правило то же: наружу
уходит только то, что мы сами туда записали.

Поиск и каталог не требуют ни ключей, ни аккаунтов: YouTube — через yt-dlp (`ytsearch` и
вкладка `/videos` канала), Twitch — через их публичный GraphQL с тем же клиентским
идентификатором, которым пользуются streamlink и twitch-dl.
"""

import time  # noqa: F401 -- тест патчит cord_services.cinema.time.time, а не сам time.time

# Явный реэкспорт (`... as ...`): пакет заменил модуль, и это то же самое публичное имя.
from .facade import Cinema as Cinema
from .facade import Resolve as Resolve
from .memo import Memo as Memo
from .paging import PAGE as PAGE
from .paging import absolute as absolute
from .paging import offset_of as offset_of
from .paging import page as page
from .routes import routes as routes
from .transport.playlists import Reels as Reels
from .transport.playlists import finished_playlist as finished_playlist
from .transport.playlists import master_playlist as master_playlist
from .transport.playlists import rewrite as rewrite
from .transport.segments import Segments as Segments
from .transport.signer import PREFIX as PREFIX
from .transport.signer import Signer as Signer
from .transport.signer import allowed as allowed
