# Воркер фона — классический, и на dev-сервере Vite он не поднимается

Факт (03.11.2026, R186): MediaPipe `@mediapipe/tasks-vision` грузит wasm-загрузчик через `importScripts`
(иначе — `document.createElement('script')`, которого в воркере нет), а в модульном воркере `importScripts`
запрещён. Поэтому `background.worker.ts` создаётся без `type: 'module'`: сборка Vite складывает его одним
файлом (`worker.format` = iife), и в продакшене сегментация идёт в воркере. Dev-сервер Vite воркеры не
собирает и отдаёт их только модулями (`workerType = isBundled ? … : 'module'` в `vite/dist/node/chunks/node.js`)
— там воркер падает на первом `import`, и `BackgroundEffect` штатно переезжает на главный поток
(`[cord] background worker unavailable, running on the main thread`). Это не ошибка: в dev проверяется
конвейер, а воркер — только `vite build` + `vite preview` или стенд.

Как применять: отладка движка фона — `scripts/background-probe.mjs` против dev-сервера (главный поток), проверка
воркера — против собранной страницы; ошибка воркера глушится `event.preventDefault()`, иначе она считается
ошибкой приложения (`[cord] app failed: bug`).
