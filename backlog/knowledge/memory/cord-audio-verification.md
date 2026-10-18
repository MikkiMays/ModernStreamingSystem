---
name: cord-audio-verification
description: "Как на этой машине послушать, что на самом деле приходит в комнату Cord"
metadata: 
  type: reference
---

Про звук нельзя верить ни коду, ни панели: статус в Cord показывал «играет», когда в комнате
была тишина. Способ, который даёт настоящий ответ (собран 15.09.2026, воспроизводится за пять
минут):

1. Образ-слушатель, потому что в `modern-streaming-services` больше нет ни livekit, ни numpy:
   `FROM python:3.12-slim-bookworm` + `pip install livekit==1.1.18 numpy httpx` + ffmpeg,
   тег `cord-audio-probe`.
2. Тестовый трек с **разными каналами**: слева свип 200→2000 Гц за 120 с
   (`aevalsrc=0.7*sin(2*PI*(200*t+7.5*t*t))`), справа ровные 1000 Гц, `amerge` в stereo flac.
   Частота слева = позиция в треке, разница каналов = стерео это или моно.
3. Скрипт: создать комнату через шлюз (его локальный адрес, заголовок `Host: meet.nikg.tech`),
   загрузить трек, включить музыку, взять `POST /api/v1/rooms/{id}/media/token`, подписаться
   `rtc.AudioStream(track, 48000, num_channels=2)` и считать RMS и число переходов через ноль
   по каждому каналу. Одинаковые каналы побитово = моно.
4. Запуск: `docker run --rm --network host -v "$PWD":/work:ro cord-audio-probe python ...`.

Так измеряются и задержки: время от ответа на команду до последнего громкого кадра — «пауза»
и «продолжение» в Cord держатся около 0,2 с.

`ListParticipants` у самого SFU (JWT HS256 собирается руками, грант `roomAdmin` + `roomList`
с именем комнаты) отвечает на вопрос «а что думает сервер»: `stereo`, `mimeType`, кодеки.

Связано: [[livekit-stereo-only-via-go]], [[meet-cord-system]].
