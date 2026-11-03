---
name: cord-screen-hint-livekit
description: "Почему «Чёткость» показа в Cord на AV1/VP9 не включала screen content coding и как это лечится одной строкой после publishTrack"
metadata:
  type: project
---

Разобрано 03.11.2026 (R184, Р-84) в [[meet-cord-system]]: показ в «Чёткости» публиковался AV1/VP9 с
`contentHint = 'detail'`, а инструменты экранного содержимого всё равно не включались.

**livekit-client сбивает подсказку внутри `publishTrack`.** При показе VP9/AV1 одним потоком SVC
(без раскладки по rid — так на LiveKit 1.13.6) `LocalParticipant.publish` ставит дорожке
`contentHint = 'motion'` с комментарием «Chrome does not allow more than 5 fps with L1T3». Для
libwebrtc подсказка — это и есть screencast-режим: `pc/rtp_sender.cc` переводит `detail`/`text` в
`is_screencast = true`, `motion` — в `false`. Без него нет `VP9E_SET_TUNE_CONTENT` (libvpx) и
`AOM_CONTENT_SCREEN` + палитры (libaom), включён шумодав и настройки под лица. Подсказка, выставленная
**до** `publishTrack`, бесполезна — её перезапишут.

**Предел в 5 кадров — не про наш путь.** Он живёт в `vp9/svc_config.cc` →
`ConfigureSvcScreenSharing` (`kMaxScreenSharingLayerFramerateFps = {5, 10, 30}` по слоям) и берётся
только когда слои VP9 заданы старым способом, без `scalabilityMode`. Cord и LiveKit ставят
`scalabilityMode: 'L1T3'` в encodings — тогда слои собирает `GetVp9SvcConfig` с полной частотой.
Единственное, что screencast-режим делает с частотой, — у застывшего экрана (пустой `update_rect`
пять кадров подряд) уходит на 5 кадров (`variable_framerate_screenshare`) — ровно как презентация
Meet.

**Лечится после публикации.** Смена `contentHint` у живой дорожки перенастраивает кодировщик
(`VideoRtpSender::OnChanged` → `SetSend`), поэтому `session.ts:applyScreenHint` возвращает `detail`
сразу после `publishTrack` — и в `publishScreen`, и в `applyProfile`. Проверка вживую: «Диагностика»
→ «Видео · Передача»: если при прокрутке на VP9 держится ровно 5 кадров — это старый путь, и возврат
надо снять.

Связано: [[cord-video-quality-levers]], [[cord-quality-ladder-and-reception]].
