"""Площадки кинозала. Порядок в этом списке — порядок в ответе `providers` и в журнале."""

from .link import Link
from .rutube import Rutube
from .twitch import Twitch
from .vk import Vk
from .youtube import YouTube

# «По ссылке» — последней: это не площадка каталога, а общий путь для ссылок, которых не узнала
# ни одна площадка выше.
PROVIDERS = (YouTube, Twitch, Rutube, Vk, Link)
