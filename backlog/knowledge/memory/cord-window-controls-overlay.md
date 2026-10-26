---
name: cord-window-controls-overlay
description: "Почему в клиенте Windows 1.0.8 кнопки окна ложились на шапку развёрнутого окна и почему веб больше не верит одной зоне Window Controls Overlay"
metadata:
  type: project
---

R122 (26.10.2026). Клиент Windows — Electron 44.9 с `titleBarStyle: 'hidden'` + `titleBarOverlay`
(36 px). Веб берёт поле справа из `env(titlebar-area-*)` / `navigator.windowControlsOverlay`
(`styles/tokens.css`, `core/titlebar.ts`).

- **Симптом:** на фото владельца окно с «☐» (не развёрнуто) — поле есть, с «⧉» (развёрнуто) — звезда,
  ссылка и гарнитура шапки лежат под «— ⧉ ×»: `--titlebar-end` = 0.
- **Где ломается:** с Electron 44.4 (electron#53811, бэкпорт #53639) зона доходит до страницы через
  `WebContentsView::SendWindowControlsOverlay` — перевод в координаты вида и обрезка по его границам,
  плюс синхронная отправка в `OnContentsBoundsChanging`. Тот же путь в 44.4 уже ломал окна с
  `titleBarOverlay` (electron#54025, `ready-to-show` не приходил). Пустая зона → Chromium снимает
  `env(titlebar-area-*)` и `visible = false`. Живого Windows на машине нет — точный шаг не пойман.
- **Что сделано в вебе:** в клиенте Windows (мост v2 + Windows в строке браузера) поле и высота полосы
  не меньше самих кнопок — 137×36 DIP (`WinCaptionButton`: три по 45 и зазор 1) с поправкой на масштаб
  страницы (`outerWidth/innerWidth`); пересчёт и по `geometrychange`, и по `resize`/`fullscreenchange`;
  во весь экран — нули. `data-titlebar` на `<html>`: шапки встречи и предвхода — заголовок окна высотой
  полосы, кнопки шапки на одной линии с «— ⧉ ×» (как у Discord).
- **Как проверить без Windows:** `web/.local/r108/titlebar-shots.mjs` — мост v2, строка браузера Windows,
  поддельный `navigator.windowControlsOverlay` (`visible`/`hidden`/`full`) и нарисованные поверх страницы
  кнопки 137×36; считает кнопки шапки под ними.
- `display-mode: fullscreen` в Electron 44.9 всегда `browser` (переопределения `GetDisplayMode` из
  electron#51396 в 44.9.1 нет): полный экран веб узнаёт по `document.fullscreenElement`; окно во весь
  экран по F11 (меню Electron по умолчанию) оставит поле 145 px — лишнее место, а не наложение.
- **Владелец после R122 (26.10.2026):** сжатие шапок до полосы 36 отменено — «верни, был отличный
  размер». Шапки встречи и предвхода снова 56 (`max(56px, --titlebar-h)`), правое поле под кнопками окна
  осталось. Ровную линию даёт оболочка: с 1.0.10 `titleBarOverlay.height` = 56 (`TITLEBAR_HEIGHT`,
  `shared/bridge.ts` клиента) и она же уходит странице в `bootstrap.titlebarHeight` — `core/titlebar.ts`
  берёт её нижней границей вместо 36 (оболочки до 1.0.10 её не шлют — там прежние 36 и кнопки шапки на
  10 px ниже «— ⧉ ×», как до R122).
