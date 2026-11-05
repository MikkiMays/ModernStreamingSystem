# LiveKit сам выключает камеру молча: `mute` → `pauseUpstream`, отказ при `ended` → `track.mute()`

Факт (05.11.2026, R189, воспроизведено на стенде): `livekit-client` 2.22 на камеру вешает своих слушателей (`LocalTrack.ts`).
Chromium шлёт `mute`, если кадров нет 25 ожидаемых интервалов (при 30 кадрах — 0,83 с); через 5 с LiveKit делает
`pauseUpstream`: `replaceTrack(null)` и `muted` всем зрителям, а локальный `isMuted` остаётся `false`, и кнопка горит. При `ended`
он один раз пробует `restartTrack`, а при отказе `getUserMedia` молча зовёт `track.mute()` и больше не пробует: в лог уходит
`could not restart track, muting instead`, в ошибки — ничего. Человек включает камеру руками.

Как применять: камеру сторожит `media/camera-guard.ts`; `pauseUpstream` перекрыт на экземпляре, обработчик `ended` снят —
после обновления `livekit-client` проверить, что они всё ещё работают (`e2e/camera-recovery.spec.ts`). На стороне сервера
этого не видно: SFU на уровне `warn` о камере молчит, след — `cord_client_errors_total{place="camera"}` и «Журнал камеры» в
«Диагностике». Синтетический `dispatchEvent('mute')` не ставит `track.muted = true`, поэтому ветка сторожа «muted ≥ 3 с»
так не проверяется: нужны юнит-тесты сторожа или настоящая камера.
