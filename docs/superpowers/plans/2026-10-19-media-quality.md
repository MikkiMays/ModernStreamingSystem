# Качество из конфигурации, показ после кадра, resume при смене сети — план (E05: T44, T48, T50)

**Спецификация:** `docs/superpowers/specs/2026-10-19-media-quality.md` (при расхождении права она).
**Схема настроек и контрактов:** `docs/architecture/target-2026-10.md` → 1.4, 2.1, 3.1 (решения 3, 4).
**Ветка:** `epic/E05-quality` от `epic/E05-media`. Коммиты по-русски, маленькие, не пушить.

## Ограничения

- Контракты не перегенерировать (`contracts/openapi.json`, `generated.ts`) — очередь у интегрирующей
  сессии. Веб читает `capabilities.quality` защитно, через `media/capabilities.ts`.
- Горячие файлы (`session.ts`, `Settings.tsx`, `Stage.tsx`, `preferences.ts`, `StreamProperties.java`,
  `application.yml`, `OpenApiConfig.java`) — минимальные точки подключения; новое — в новых модулях.
- Не трогать: `RoomService.java` (E06-A), `services/`, кинозал (E07), игры (E08).
- Машина медленная: vitest только `npx vitest run <файлы> --pool=threads --testTimeout=60000`;
  `tsc -b` один раз в конце, в фоне; ядро — `./mvnw -B -pl server -am test -Dtest=…` точечно.

## Шаги

### Ядро

1. **`config/Level.java` + `LevelConverter.java`** — разбор `720p30`, допустимые множества, тест
   `LevelTest` (красный → зелёный).
2. **`StreamProperties.Media.Quality`** (`@Name("default")`, `ceiling`, `settle: Duration`,
   `cameraYieldsToScreen`), `@AssertTrue` «умолчание не выше потолка»; `application.yml` блок
   `stream.media.quality` с переменными окружения. Тест `QualityRulesTest` на проверку.
3. **`ApiController.Capabilities.quality`** (`QualityRules{default, ceiling, settleMs,
   cameraYieldsToScreen}`), `resolutions`/`frameRates` из потолка; `OpenApiConfig`: `QualityRules`,
   `Level` в required-список.
4. **`media/ScreenGrace`** + использование в `MediaReconciler.reconcile` (запасной `screenObserved`
   не раньше `settle`); тест `ScreenGraceTest`.
5. Формат `./mvnw -B -q -pl server com.spotify.fmt:fmt-maven-plugin:format`; тесты шагов 1–4.

### Веб

6. **`media/capabilities.ts`** (+ тест): `rememberQuality(raw)`, `qualityRules()`, `qualityLevels()`,
   `nearestLevel()`, `settleMs()`, `cameraYieldsToScreen()`; запись в `localStorage`; вызов из
   `core/session.ts serverInfo()` и `HomeEntry.tsx` (queryFn → `serverInfo`).
7. **`media/profiles.ts`**: без `automatic`; `captureCeiling` → выбранный уровень; один набор опций
   публикации; `cameraHint` = `motion`. Тест `profiles.test.ts` переписать.
8. **`media/hold.ts`** (+ тест): `HoldLevel` — окно `settle`, одна ступень разрешения вниз не ниже
   720p, частота прежняя, возврат через 10 спокойных опросов.
9. **`media/upstream.ts`**: `UpstreamBudget` на `HoldLevel`; роль `companion` только при
   `cameraYieldsToScreen`; удалить `auto-quality.ts` и тест; переписать `upstream.test.ts`.
10. **`core/preferences.ts`**: `profile()` → `nearestLevel`; умолчания — с сервера; тест миграции
    («Авто» → умолчание, 1440p60 → 1080p60).
11. **`media/screen-ready.ts`** (+ тест): `ScreenReadiness`.
12. **`media/reconnect-plan.ts`** (+ тест): `reconnectAction`. `link-quality.ts`: `ice` из `transport`
    (+ тест).
13. **`media/session.ts`** (один коммит): убрать пути «Авто»; `settle` из `capabilities`; гейт
    `screen.started` через `ScreenReadiness`; `nudge(trigger)` по `online` и `ice-disconnected`;
    `outbound.settling`; `session.test.ts` — новые случаи, старые «Авто» убрать.
14. **`core/control.ts`**: `probe()` по `online` (ping, 3 с на pong); `control.test.ts`.
15. **UI**: `Settings.tsx` `QualityFields` без «Авто»/1440 из `qualityLevels()`; `Stage.tsx` «Готовится
    показ…» + `room-layout.css`; `outbound-note.ts` «разгон канала».
16. **e2e**: `upstream.spec.ts` → камера держит 720 во время показа; `screens.spec.ts` — ждать
    «Готовится показ…» перед «Смотреть стрим» (мягко: `toBeVisible` c таймаутом).
17. **Документация**: `docs/frontend.md` → «Качество» (что теперь, что было), `docs/architecture.md`
    → «Восстановление и поколения» (resume при смене сети), `docs/capacity.md` (камера не уступает по
    умолчанию), заметка памяти `livekit-resume-on-network-change`, `DECISIONS.md` «Решено агентом»,
    `STATUS.md`, журнал `backlog/journal/2026-10-19-E05-quality.md`.
18. `npx tsc -b` в фоне; `npm run format:check` на тронутых файлах (`npx prettier --check <files>`);
    живой прогон против стенда, если `/api/v1/ping` отвечает, иначе — команды в журнал.
