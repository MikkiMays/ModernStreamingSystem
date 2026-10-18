---
name: livekit-stereo-only-via-go
description: Почему музыка в Cord приходила в моно и почему стерео возможно только через Go-SDK
metadata: 
  node_type: memory
  type: reference
  originSessionId: bde17172-5ad2-4928-81df-2d9a5f97b544
  modified: 2026-09-15T19:26:34.861Z
---

Проверено на месте 15.09.2026, на работающем сервере [[meet-cord-system]].

**Клиент LiveKit для Python не умеет публиковать стерео.** В `TrackPublishOptions` (это
protobuf FFI rust-SDK) полей `stereo` нет — ни в 1.1.18, ни в `main` репозитория
`livekit/rust-sdks`. Сервер получает `AddTrackRequest.stereo = false`, отвечает обычным
`minptime=10;useinbandfec=1`, и libwebrtc кодирует **один канал**, каким бы ни был источник.
`ListParticipants` у самого SFU показывает `"stereo": false` — это и есть проверка.

Не помогает: `RoomOptions(single_peer_connection=True)`. Он действительно включается
(`single_pc_mode=true` в логах SDK при `LIVEKIT_RTC_DEBUG=1`) и SDK домунживает `stereo=1` в
**свой offer**, но ответ Pion-сервера этого не повторяет, а кодировщик смотрит на ответ.
Измерено: каналы по-прежнему побитово одинаковые.

**Стерео есть в Go-SDK**: `lksdk.TrackPublicationOptions{Stereo: true}` кладётся прямо в
`AddTrackRequest`. Go-SDK принимает уже закодированный Opus (`media.Sample`), поэтому кодирует
ffmpeg — и это лучше libwebrtc: `-c:a libopus -b:a 256k -vbr constrained -application audio`.
Два подводных камня: пакет должен быть ≤1200 байт (обычный `-vbr on` даёт пики по 1250 и
packetizer паникует), а Ogg-страница — **не** пакет: нужен разбор lacing-таблицы, иначе в
`WriteSample` уезжает несколько кадров разом.

Так это и сделано: `services/publisher` (Go) + `cord_services/publisher.py`, построчный JSON.

Связано: [[handoff-checkmarks-lie]] — в документации Cord стереопоток был обещан задолго до
того, как он появился.
