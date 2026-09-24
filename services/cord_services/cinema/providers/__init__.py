"""Площадки кинозала. Порядок в этом списке — порядок в ответе `providers` и в журнале."""

from .rutube import Rutube
from .twitch import Twitch
from .vk import Vk
from .youtube import YouTube

PROVIDERS = (YouTube, Twitch, Rutube, Vk)
