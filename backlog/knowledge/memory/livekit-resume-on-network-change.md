---
name: livekit-resume-on-network-change
description: Почему livekit-client не замечает смену сети (VPN) и как попросить у него бесшовный resume без полного connect
metadata:
  type: reference
---

Разобрано 19.10.2026 для T50 в [[meet-cord-system]] по жалобе «переподключение при включении и
выключении VPN не всегда корректно и быстро». Проверено по коду `livekit-client 2.22.3`
(`dist/livekit-client.esm.mjs`), живой замер — после подъёма стенда.

**SDK чинит связь бесшовно, но замечает обрыв поздно.** Путь `resumeConnection` — новый сигнальный
WS с `reconnect=1`, `triggerIceRestart()`, те же дорожки и SSRC у зрителей. Запускается он из
`handleDisconnect`, а туда ведут три дороги, и все медленные: таймаут пинга сигнального WS (значение
присылает сервер в JoinResponse, порядка пятнадцати секунд); ICE в состоянии **`failed`** —
`disconnected`, в которое Chrome уходит через секунды после исчезновения интерфейса, SDK не считает
поводом; `ConnectionQuality.LOST` от SFU плюс `connectionQualityLostTimeout = 10 s` — и это уже
**полный** reconnect, с новыми дорожками. Отдельный сторож `connectionReconcile` раз в 4 с ждёт три
промаха `verifyTransport` и тоже делает полный.

**`online` браузера SDK слушает сам, но VPN его не даёт.** `handleBrowserOnLine` делает HEAD к серверу и
немедленный `attemptReconnect` — только если сигнал уже в `RECONNECTING` или до этого был `offline`.
Включение и выключение VPN не меняет `navigator.onLine`, события нет, SDK сидит «подключённым». Клиент
Windows шлёт странице `network.changed` при смене адреса — это единственный честный знак на этой
платформе; в браузере остаётся ICE `disconnected` из `transport.iceState` в `getStats` (Chrome; Firefox
поля не отдаёт).

**Как попросить resume.** Публичной ручки «переподключись сейчас» нет. `room.simulateScenario('signal-reconnect')`
(помечена «для тестов», но в `Room.d.ts` публична) зовёт `engine.client.handleOnClose(...)` — ровно то, что
делает таймаут пинга: сигнал закрывается, `handleDisconnect('signal')` → `attemptReconnect` с первой
задержкой из нашей `reconnectPolicy` (0 мс) → `resumeConnection`. Другие сценарии не годятся:
`'resume-reconnect'` ставит `failNext()` и нарочно валит первую попытку, `'full-reconnect'` и
`engine.reconnect()` делают полный reconnect. На живом соединении лишний resume почти бесплатен (ICE
restart не рвёт медиа), поэтому толчок идёт без проверки пути, но не чаще раза в три секунды.

Связано: [[cord-call-in-pocket]] (окно восстановления и телефон в кармане), [[cord-playout-buffer]].
