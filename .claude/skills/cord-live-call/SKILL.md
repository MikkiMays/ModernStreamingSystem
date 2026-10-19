---
name: cord-live-call
description: Use when a Cord change touches media (camera, microphone, screen share, quality, reconnection, speaking indicator, music audio) and needs proof from a real call between two browsers through the SFU, not unit tests.
---

# Живой звонок Cord двумя браузерами

## Где

Стенд `https://cord.nikg.tech` (эта машина, свой SFU) — первый выбор; прод — после выкатки. Камере и
микрофону нужен настоящий https по имени: по IP захват не дают.

## Как

Готовые сценарии — `web/e2e/meeting.spec.ts` (камера, звук, чат), `screens.spec.ts` (два экрана через SFU),
`upstream.spec.ts`, `recovery.spec.ts`:

```bash
cd "$CORD_ROOT/ModernStreamingSystem/web"
PLAYWRIGHT_BASE_URL=https://cord.nikg.tech npx playwright test e2e/meeting.spec.ts e2e/screens.spec.ts
```

Конфиг уже даёт `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream` и автоселект
экрана. Свой сценарий — файл в `web/e2e/` (или временный в `web/.verify/`), два `browser.newContext()`.

## Что мерить

- **Размер своего захвата** — `videoHeight` у `video[aria-label="Камера: <имя>"]`.
- **Статистика WebRTC** — LiveKit не отдаёт `RTCPeerConnection`. Перехват до загрузки страницы:

```ts
await context.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  (window as any).__pcs = [];
  window.RTCPeerConnection = function (...a: any[]) { const pc = new Native(...a); (window as any).__pcs.push(pc); return pc; } as any;
  window.RTCPeerConnection.prototype = Native.prototype;
});
// потом: page.evaluate(async () => { for (const pc of (window as any).__pcs) for (const r of (await pc.getStats()).values())
//   if (r.type === 'inbound-rtp' && r.kind === 'video') return [r.frameWidth, r.frameHeight, r.framesPerSecond]; })
```

`outbound-rtp` даёт `encoderImplementation` и `qualityLimitationReason`; `inbound-rtp` у зрителя — что он
реально видит.
- **Fake-тон микрофона** вырезает шумоподавление — для замеров уровня выключить его в настройках звука.

## Ловушки

- Без `PLAYWRIGHT_BASE_URL` поднимется пустой dev-сервер — падает всё, это не прод.
- Хост этой машины замирает на 20–35 с (`journalctl -k | grep 'soft lockup'`) — «странность в звонке»
  сначала сверить с этим журналом.
- Сборка образов на той же машине душит SFU — не мерить качество во время `docker compose build`.
