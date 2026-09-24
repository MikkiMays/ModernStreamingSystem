"""Площадки кинозала. Порядок в этом списке — порядок в ответе `providers` и в журнале."""

from .twitch import Twitch
from .youtube import YouTube

PROVIDERS = (YouTube, Twitch)
