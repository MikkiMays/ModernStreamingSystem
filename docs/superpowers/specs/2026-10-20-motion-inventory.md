# Движение в веб-клиенте Cord: инвентарь — справка (E15-A, T57)

Дата: 20.10.2026. Исходник: `main` на `020eb66`. Статус: снимок того, что клиент показывает
сейчас. Код не менялся. Таблицы зеркалятся в Figma, страница «Движение» файла
https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA. Ими пользуются редизайн (E15-B) и миграция
на токены (E16, шаг 5).

Как собрано. Просмотрены все 26 CSS-файлов `web/src/**/*.css`, `web/index.html` и
`web/src/**/*.{ts,tsx}` без тестов. Тесты читались только ради намерения. Поиск —
`grep -rn` по образцам `@keyframes`, `animation`, `transition`, `view-transition`,
`scroll-behavior`, `smooth`, `will-change`, `prefers-reduced-motion`, `starting-style`,
`ending-style`, `\.animate(`, `requestAnimationFrame`, `scrollIntoView`, `scrollBy`, `scrollTo`,
`setTimeout`/`setInterval`, `animationDelay`, `animationDuration`, `@property`, `offset-path`.
Отдельно проверены классы Tailwind (`animate-*`, `transition-*`, `duration-*`, `motion-safe`):
их нет. Для каждого совпадения найдено правило и прочитан триггер в TSX. Движение есть в 22 CSS-файлах.
В `accessibility.css`, `desktop-home.css`, `ui/meeting-elsewhere.css` и `ui/kit/showcase.css`
его нет.

Пути ниже даны от корня репозитория. «Кадры» — строка `@keyframes`. Длительности и кривые
записаны так, как они стоят в коде. Если стоит токен, рядом его значение.

## 1. Токены движения

Объявлены в `web/src/styles/tokens.css:110–115`. Под `prefers-reduced-motion: reduce` длительности
обнуляются в `tokens.css:327–333`.

| Токен               | Значение                       | Под `reduce` | Вхождений `var()` | Где                                                                                                      |
| ------------------- | ------------------------------ | ------------ | ----------------: | -------------------------------------------------------------------------------------------------------- |
| `--motion-fast`     | `120ms`                        | `0ms`        |                45 | `ui/kit/kit.css` 16, `ui/home/home.css` 12, `ui/settings/settings.css` 7, `home-entry.css` 3, `ui/meeting-header.css` 2, `ui/meeting-panel.css` 2, `ui/shell.css` 2, `ui/stage.css` 1 |
| `--motion-base`     | `200ms`                        | `0ms`        |                19 | `kit.css` 11, `settings.css` 3, `home.css` 2, `home-entry.css` 1, `ui/call-dock.css` 1, `stage.css` 1 |
| `--motion-slow`     | `320ms`                        | `0ms`        |                 6 | `home.css` 4, `stage.css` 1, `meeting-panel.css` 1                                                       |
| `--ease-standard`   | `cubic-bezier(0.2, 0, 0, 1)`   | —            |                57 | `kit.css` 19, `home.css` 14, `settings.css` 8, `meeting-header.css` 4, `home-entry.css` 3, `meeting-panel.css` 3, `stage.css` 3, `shell.css` 2, `call-dock.css` 1 |
| `--ease-emphasized` | `cubic-bezier(0.05, 0.7, 0.1, 1)` | —         |                13 | `kit.css` 7, `home.css` 4, `home-entry.css` 1, `settings.css` 1                                          |
| `--ease-exit`       | `cubic-bezier(0.3, 0, 0.8, 0.15)` | —         |             **0** | нигде                                                                                                   |

Токены читают только 9 файлов: оболочка и главная, набор, встреча и настройки. В загрузке,
кинозале, всех играх, `styles.css`, `room-layout.css` и `game-*.css` стоят только литералы. В
`index.html` это вынужденно: токены ещё не загружены. TS-код токенов не читает: уход загрузки
задан литералами `200`/`120` мс и `ease-in` (`ui/loader/boot.ts:22`, `ui/loader/FullscreenLoader.tsx:80`).

## 2. Политика reduced motion

**Глобальное правило** — `web/src/styles.css:1023–1031`:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}
```

`styles.css` подключается первым (`web/src/main.tsx:3`). В собранном `index.html` CSS стоит
`<link>` в `<head>` (проверено по `web/dist/index.html` основной копии), поэтому правило
действует и на статичную загрузку с первого кадра. Оно гасит все CSS-анимации и переходы,
включая псевдоэлементы и переходы слоёв Base UI (`data-starting-style`/`data-ending-style`).
WAAPI (`element.animate`), циклы `requestAnimationFrame` и инлайн-обновления оно не трогает.
Перебить его может только `!important` с большей специфичностью. Так сделано в одном месте,
`web/src/game-polish.css:410–416`: кольцо хода покера под `reduce` остаётся, потому что это
информация.

**Остальные механизмы:**

- Токены → `0ms` (`tokens.css:327`). При глобальном правиле это избыточно: у правил на
  токенах переход и так `none`. В `accessibility.css` правил движения нет.
- Местные правила `@media (prefers-reduced-motion: reduce)`, 14 блоков:
  - Повторяют глобальное (`animation`/`transition: none`): `web/index.html:149`,
    `ui/loader/loader.css:195`, `room-layout.css:171`, `ui/meeting-header.css:169`,
    `ui/stage.css:317`, `ui/cinema/theater.css:542`, `game-people.css:110`, `gartic.css:1747`,
    `chess.css:686`, `poker.css:2254` (14 селекторов, `!important`).
  - Заменяют движение: `settings.css:403` — ровная подсветка вместо затухания.
  - Хотят иного, но проигрывают глобальному `!important`:
    - `index.html:149` и `loader.css:195` намеренно оставляют проявление `fl-in`;
    - `loader.css:201` оставляет дыхание тени при `data-reduced='breathe'`;
    - `theater.css:66` замедляет спиннер до 2.4s.
  - `game-polish.css:246`: `.game-card-flight { display: none }`, а у всех `.poker *` и
    `.durak *`, кроме колец хода, длительности становятся `0.001ms !important`.
  - `game-polish.css:410`: кольцо хода сохраняется. Правило для `.durak .durak-ring-run`
    (`durak-drain`) мёртвое: такого элемента и таких `@keyframes` нет.
- Обратный подход, 4 блока: `@media (prefers-reduced-motion: no-preference)` в
  `durak.css:240`, `:573`, `:605`, `:805`. Анимация объявлена только для тех, кто движение не
  выключал.
- JS: `useMediaQuery('(prefers-reduced-motion: reduce)')` (`ui/primitives.tsx:43`) проверяют 4
  места: `ui/GamePresentation.tsx:66`, `ui/DurakMotion.tsx:80`, `ui/ChessTable.tsx:850`,
  `ui/GarticCanvas.tsx:83`. У WAAPI-уходов загрузки (`boot.ts:27`, `FullscreenLoader.tsx:79`)
  проверки нет. Проп `FullscreenLoader reducedMotion` только ставит `data-reduced`
  (`FullscreenLoader.tsx:105`).

**Обозначения в столбце «reduced motion»:**

- «выкл. (глоб.)» — движение гасит только `styles.css:1023`.
- «выкл. (глоб. + `файл:строка`)» — есть и своё правило.
- «JS: не запускается» — код сам не начинает движение.
- «заменено» — вместо движения статичное состояние.
- «сохраняется» — движение оставлено намеренно.
- «**не обработано**» — движение идёт и под `reduce`.
- «н/п» — прямое управление (за пальцем) или шаговое обновление данных; анимации как таковой нет.

После «→» — что человек видит под `reduce`, если это не просто «стоит на месте».

## 3. Инвентарь

### 3.1 Загрузка

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **З1** Проявление сцены и марки (`.fl__fade`, `fl-in`) | `web/index.html:73` (кадры `:118`); копия `web/src/ui/loader/loader.css:42` (`:152`) | открытие страницы / монтирование `FullscreenLoader`; задержка `--fl-delay` 150ms (`index.html:60`, `showAfterMs` в `FullscreenLoader.tsx:42`) | 240ms | ease-out, forwards | opacity 0→1 | выкл. (глоб.). Местные `index.html:149` и `loader.css:195` его оставляют, но `!important` (`styles.css:1027`) гасит → `.fl__fade` остаётся `opacity: 0` (`index.html:72`): видно только фон |
| **З2** Покачивание сцены марки (`.fl__scene`, `fl-sway`) | `web/index.html:85` (кадры `:123`); `loader.css:54` (`:157`) | пока экран загрузки на странице | 6s, бесконечно, alternate | ease-in-out | transform: rotateX/rotateY (3D, `perspective: 800px`) | выкл. (глоб. + `index.html:149`, `loader.css:195`) |
| **З3** Дыхание тени (`.fl__shadow`, `fl-breathe`) | `web/index.html:93` (кадры `:131`); `loader.css:62` (`:165`) | то же | 3s, бесконечно, alternate | ease-in-out | transform: scaleX; opacity | выкл. (глоб. + местные). Режим `data-reduced='breathe'` (`loader.css:201`) должен её оставить, но проигрывает глобальному |
| **З4** Полоски знака подпрыгивают (`.fl-cord__bar`, `fl-bob`) | `web/index.html:111` (кадры `:141`); `loader.css:80` (`:175`) | то же; сдвиг фазы `--i × −0.4s` | 1.2s, бесконечно, alternate | cubic-bezier(0.45, 0, 0.55, 1) | transform: translateZ/translateY/rotate | выкл. (глоб. + местные) |
| **З5** Уход статичной загрузки `#cord-boot` | `web/src/ui/loader/boot.ts:27` (WAAPI) | первый кадр экрана: `BootGate` → `requestAnimationFrame` (`ui/loader/BootGate.tsx:12`); затем узел удаляется | 200 мс, если сцена не проявилась — 120 мс (`boot.ts:22`, литералы); страховка `duration × 2` (`:23`) | ease-in, fill forwards | opacity 1→0 | **не обработано** (WAAPI). Под `reduce` всегда 120 мс: сцена так и не проявилась |
| **З6** Карты разлетаются в 3D, сцена `cards` (`.fl-card`, `fl-fly`) | `loader.css:97` (кадры `:183`); `will-change: transform` `:95` | `FullscreenLoader scene="cards"`; сейчас только витрина `/kit` (`ui/kit/Showcase.tsx:426`) | `--T` = 2.8s, бесконечно; фаза `i × T / −7` (`:98`) | cubic-bezier(0.33, 0, 0.67, 1) | transform: translate3d + rotateX/Y/Z (переворот через `backface-visibility`) | выкл. (глоб. + `loader.css:195`) → веер в покое |
| **З7** Строка «Сеть медленная» (`.fl__slow`, `fl-in`) | `loader.css:147` | через `slowAfterMs`: по умолчанию 12000 мс (`FullscreenLoader.tsx:44`, `:58`), в витрине `/kit` — 1500 мс (`ui/kit/Showcase.tsx:434`); только `/kit` | 240ms | ease-out, forwards | opacity 0→1 | выкл. (глоб.) → строка и кнопка «Повторить» остаются `opacity: 0` (`loader.css:146`): невидимы, но нажимаются |
| **З8** Уход `FullscreenLoader` | `web/src/ui/loader/FullscreenLoader.tsx:79` (WAAPI) | `ready`; только `/kit` | 200 мс / 120 мс (`:80`, литералы) | ease-in, fill forwards | opacity 1→0 | **не обработано** (WAAPI) |

`FullscreenLoader` и `loader.css` попадают только в ленивый чанк витрины `/kit`
(`App.tsx:397–400`). Продукт видит статичную загрузку из `index.html` (З1–З5).

### 3.2 Оболочка и главная

Сюда входят экран подключения (`ui/Connect.tsx`), главная (`ui/home/*`) и поле «Код встречи»
(`ui/HomeEntry.tsx`).

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **О1** Ссылка «Скачать» на экране подключения | `web/src/ui/shell.css:61` | наведение | `--motion-fast` (120ms) | `--ease-standard` | color | выкл. (глоб.) |
| **О2** Треугольник у ошибки подключения | `web/src/ui/shell.css:163` | открытие `<details>` | `--motion-fast` (120ms) | `--ease-standard` | transform: rotate(−180deg) | выкл. (глоб.) |
| **О3** Рамка поля «Код встречи» | `web/src/home-entry.css:68` | наведение, фокус, ошибка | `--motion-fast` (120ms) | `--ease-standard` | box-shadow | выкл. (глоб.) |
| **О4** Кнопка «Войти» у поля | `web/src/home-entry.css:91` | наведение | `--motion-fast` (120ms) | `--ease-standard` | background-color, color | выкл. (глоб.) |
| **О5** Стрелка в кнопке «Войти» | `web/src/home-entry.css:100` | наведение — translateX(2px) | `--motion-base` (200ms) | `--ease-emphasized` | transform | выкл. (глоб.) |
| **О6** Пункты навигации слева | `web/src/ui/home/home.css:81` | наведение | `--motion-fast` (120ms) | `--ease-standard` | background-color, color | выкл. (глоб.) |
| **О7** Кнопка «Группа» | `web/src/ui/home/home.css:139` | наведение; нажатие — scale(0.94) (`:156`) | `--motion-fast` (120ms) | `--ease-standard` | background-color, color, box-shadow, transform | выкл. (глоб.) |
| **О8** Плюс в «Группа» поворачивается | `web/src/ui/home/home.css:146` | наведение — rotate(90deg) (`:153`) | `--motion-slow` (320ms) | `--ease-emphasized` | transform | выкл. (глоб.) |
| **О9** Раздел — подсветка цели перетаскивания | `web/src/ui/home/home.css:177` | `data-dropping` | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **О10** Группа — подсветка цели перетаскивания | `web/src/ui/home/home.css:230` | `data-dropping` | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **О11** Шеврон группы | `web/src/ui/home/home.css:270` | свернуть/развернуть (`data-collapsed`) | `--motion-base` (200ms) | `--ease-standard` | transform: rotate(90deg ↔ 0) | выкл. (глоб.) |
| **О12** Черновик новой группы появляется (`home-draft-in`) | `web/src/ui/home/home.css:301` (кадры `:306`) | появление поля названия группы | `--motion-slow` (320ms) | `--ease-emphasized` | opacity, transform: translateY(−6px) scale(0.98) | выкл. (глоб.) |
| **О13** Строка комнаты | `web/src/ui/home/home.css:319` | наведение/фокус/открытое меню; при перетаскивании opacity 0.4 (`:328`) | `--motion-fast` (120ms) | `--ease-standard` | background-color, opacity | выкл. (глоб.) |
| **О14** «…» у группы | `web/src/ui/home/home.css:423` | наведение/фокус на заголовок группы | `--motion-fast` (120ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **О15** «…» у комнаты | `web/src/ui/home/home.css:435` | наведение/фокус на строку; маска названия встаёт без перехода (`:448`) | `--motion-fast` (120ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **О16** Плашка «Вы во встрече» (`.home-here`, `home-draft-in`) | `web/src/ui/home/home.css:548` | монтирование `ActiveMeetingNotice` (`ui/home/ActiveMeetingNotice.tsx:48`) | `--motion-slow` (320ms) | `--ease-emphasized` | opacity, transform: translateY(−6px) scale(0.98) | выкл. (глоб.) |
| **О17** Подложка выдвижной панели (телефон) | `web/src/ui/home/home.css:621` (состояния `:623`) | открытие/закрытие меню-бургера, Base UI `data-starting-style`/`data-ending-style` (`ui/home/HomeShell.tsx:119`) | `--motion-base` (200ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **О18** Выдвижная панель (телефон) | `web/src/ui/home/home.css:638` (состояния `:640`) | то же (`HomeShell.tsx:120`) | `--motion-slow` (320ms), и на уход | `--ease-emphasized`, и на уход | transform: translateX(−100% ↔ 0) | выкл. (глоб.) |

### 3.3 Набор (kit): кнопки, меню, диалоги, тосты, переключатели

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Н1** Кнопка `.ui-button` | `web/src/ui/kit/kit.css:67` | наведение; нажатие — translateY(0.5px) (`:75`) | `--motion-fast` (120ms) | `--ease-standard` | background-color, transform, box-shadow | выкл. (глоб.) |
| **Н2** Спиннер в кнопке (`.ui-spinner`, `ui-spin`) | `web/src/ui/kit/kit.css:136` (кадры `:138`) | `loading` (`ui/kit/Button.tsx:55`) | 0.8s, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.) → неподвижная дуга |
| **Н3** Кнопка-значок `.ui-icon-button` | `web/src/ui/kit/kit.css:156` | наведение; нажатие — scale(0.96) (`:165`) | `--motion-fast` (120ms) | `--ease-standard` | background-color, color, transform | выкл. (глоб.) |
| **Н4** Поле `.ui-input` | `web/src/ui/kit/kit.css:261` | наведение/фокус | `--motion-fast` (120ms) | `--ease-standard` | box-shadow | выкл. (глоб.) |
| **Н5** Бегунок ползунка `.ui-slider` | `web/src/ui/kit/kit.css:341` | наведение/нажатие — scale(1.12) (`:353`), только WebKit/Blink; у `::-moz-range-thumb` (`:343`) нет ни перехода, ни масштаба | `--motion-fast` (120ms) | `--ease-standard` | transform | выкл. (глоб.) |
| **Н6** Переключатель: дорожка | `web/src/ui/kit/kit.css:380` | `data-checked` | `--motion-base` (200ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **Н7** Переключатель: бегунок | `web/src/ui/kit/kit.css:398` | `data-checked` — translateX(16px) | `--motion-base` (200ms); в `ui/kit/Switch.tsx:6` написано `--motion-fast` | `--ease-emphasized` | transform | выкл. (глоб.) |
| **Н8** Вкладки: цвет подписи | `web/src/ui/kit/kit.css:463` | наведение/выбор | `--motion-fast` (120ms) | `--ease-standard` | color | выкл. (глоб.) |
| **Н9** Вкладки: подложка выбранной | `web/src/ui/kit/kit.css:490` | смена вкладки (Base UI `--active-tab-*`; «Чат/Люди» и др.) | `--motion-base` (200ms) | `--ease-emphasized` | translate, **width** | выкл. (глоб.) |
| **Н10** Меню `.ui-menu`: пульт, раскладка, камера, комнаты и группы на главной | `web/src/ui/kit/kit.css:530` (состояния `:534`) | открытие/закрытие, Base UI | opacity — `--motion-fast` (120ms); transform — `--motion-base` (200ms) | opacity — `--ease-standard`; transform — `--ease-emphasized`; уход теми же | opacity, transform: scale(0.96) translateY(−4px) от `--transform-origin` | выкл. (глоб.) |
| **Н11** Подложка диалога `.ui-dialog__backdrop` (диалог, окно настроек) | `web/src/ui/kit/kit.css:612` (состояния `:614`) | открытие/закрытие | `--motion-base` (200ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **Н12** Диалог `.ui-dialog` | `web/src/ui/kit/kit.css:639`; появление `:643`; уход `:647` (длительность `:650`); телефон `:697` | открытие/закрытие (`ui/MeetingElsewhere.tsx`) | появление `--motion-base` (200ms); уход `--motion-fast` (120ms) | opacity — `--ease-standard`; transform — `--ease-emphasized`, и на уход | opacity, transform: scale(0.96) translateY(8px), уход — scale(0.98); ≤767px — translateY(24px) | выкл. (глоб.) |
| **Н13** Тост `.ui-toast` | `web/src/ui/kit/kit.css:728` (состояния `:741`) | `toast.add` — сейчас только на главной (`ui/home/FavoritesNav.tsx:121`, `:133`); уходит сам через 5 с (Base UI, `ui/kit/Toast.tsx:10`) | `--motion-base` (200ms) | opacity — `--ease-standard`; transform — `--ease-emphasized` | opacity, transform: translateY(12px) scale(0.98) | выкл. (глоб.) |
| **Н14** Интерактивная карточка `.ui-card--interactive` | `web/src/ui/kit/kit.css:862` | наведение; нажатие — scale(0.995) | `--motion-fast` (120ms) | `--ease-standard` | background-color, transform, box-shadow | выкл. (глоб.); в продукте не используется, только `/kit` |
| **Н15** Ручка-разделитель: фон | `web/src/ui/kit/kit.css:901` | наведение/перетаскивание/фокус (`ResizeHandle`: панель встречи, главная) | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **Н16** Ручка-разделитель: полоска | `web/src/ui/kit/kit.css:910` | то же | opacity — `--motion-fast` (120ms); transform — `--motion-base` (200ms) | opacity — `--ease-standard`; transform — `--ease-emphasized` | opacity, transform: scaleY(0.6→1) | выкл. (глоб.) |

### 3.4 Прихожая

Своих правил движения у прихожей (`ui/Prejoin.tsx`) нет. Кнопки и поля берут старое базовое
правило `button` (Пр1).

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **П1** Спиннер «Подключаемся к комнате…» и в кнопке входа (`.spin`) | правило `web/src/styles.css:897` (кадры `:899`); `web/src/ui/Prejoin.tsx:171`, `:449` | автовход по ссылке / отправка формы (`busy`) | 1s, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.) → значок стоит, остаётся текст |

### 3.5 Встреча: сцена, плитки, говорящий, пульт, панели, чат

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **В1** Обводка говорящего на плитке (`.person-voice`) | `web/src/ui/stage.css:165`; при загорании перехода нет (`:168`) | смена ступени громкости `data-voice` (`ui/Stage.tsx:167`). Уровень опрашивается `requestAnimationFrame` не чаще `MAX_RATE_HZ` = 30 Гц (`media/levels.ts:367`, `:46`); спад — `RELEASE_DB_PER_S` = 120 дБ/с (`:44`) | загорается мгновенно, гаснет за `--motion-slow` (320ms) | `--ease-standard` | box-shadow (inset, четыре оттенка `--voice-1..4`) | выкл. (глоб.) → гаснет мгновенно; спад уровня в JS (≈130–250 мс) остаётся |
| **В2** Переливание на плитке демонстрации без кадра (`.screen-preview:not([style])`, `preview-drift`) | `web/src/ui/stage.css:307` (кадры `:309`) | плитка того, кто показывает экран, пока нет снимка (первый через 400 мс, дальше раз в `PREVIEW_INTERVAL` = 10000 мс; `media/screen-preview.ts:102`, `:24`) | 14s, бесконечно, alternate | ease-in-out | transform: scale(1.18→1.3) translate3d(±3%, ±2%) поверх `filter: blur(18px)` | выкл. (глоб. + `stage.css:317`) |
| **В3** Кнопки линз камеры | `web/src/ui/stage.css:271` | выбор линзы (`aria-pressed`) | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **В4** Пульт во весь экран прячется (`.call-footer`) | `web/src/ui/call-dock.css:150`; скрытое состояние `:152` | 3000 мс без движения, опрос раз в 200 мс (`ui/MeetingView.tsx:74`, `:80`, литералы) → класс `controls-hidden` (`:151`) | `--motion-base` (200ms) | `--ease-standard` | opacity. `visibility: hidden` (`:155`) без перехода, поэтому уход мгновенный, плавное только появление | выкл. (глоб.) |
| **В5** Инструменты демонстрации во весь экран (`.screen-tools`) | `web/src/ui/stage.css:805`; скрытое состояние `:807` | то же | `--motion-base` (200ms) | `--ease-standard` | opacity; `visibility: hidden` без перехода (`:810`) | выкл. (глоб.) |
| **В6** Название встречи — фон при наведении | `web/src/ui/meeting-header.css:63` | наведение, если можно переименовать | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **В7** Карандаш переименования | `web/src/ui/meeting-header.css:81` | наведение на название | `--motion-fast` (120ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **В8** Точка статуса пульсирует (`meeting-header-pulse`) | `web/src/ui/meeting-header.css:154`, `:161` (кадры `:163`) | `data-tone='progress'` / `'warning'` (подключение, плохая связь) | 1.2s (литерал), бесконечно | `--ease-standard` | opacity (до 0.35), transform: scale(0.7) | выкл. (глоб. + `meeting-header.css:169`) |
| **В9** Шаг между витриной и разделом панели «Сервисы» (`services-step`) | `web/src/room-layout.css:163` (кадры `:165`) | смена раздела: пересборка по `key` (`ui/Services.tsx:267`, `:281`, `:288`) | 190ms | ease, both | opacity, transform: translateY(8px) | выкл. (глоб. + `room-layout.css:171`) |
| **В10** Кольцо говорящего в списке людей (`.voice-avatar`) | `web/src/ui/meeting-panel.css:155`; при загорании перехода нет (`:158`) | `data-voice` (`ui/Sidebar.tsx:560`), источник как у В1 | загорается мгновенно, гаснет за `--motion-slow` (320ms) | `--ease-standard` | box-shadow (толщина и насыщенность кольца) | выкл. (глоб.) |
| **В11** Кнопка «копировать» у сообщения | `web/src/ui/meeting-panel.css:296` | наведение на сообщение (только мышь) | `--motion-fast` (120ms) | `--ease-standard` | opacity | выкл. (глоб.) |
| **В12** Поле ввода сообщения | `web/src/ui/meeting-panel.css:400` | фокус | `--motion-fast` (120ms) | `--ease-standard` | box-shadow | выкл. (глоб.) |

Остальное во встрече берётся из набора:

- вкладки «Чат/Люди» — Н8, Н9;
- меню пульта, раскладки и камеры — Н10;
- ручка ширины панели — Н15, Н16;
- диалог «Встреча открыта в другом окне» — Н11, Н12.

Без анимации:

- плитки перестраиваются в сетку сразу;
- панель встречи открывается сразу — и как полоса, и как лист снизу;
- новые сообщения прокручиваются мгновенно (`ui/Sidebar.tsx:141`);
- меню участника (`.action-menu`) появляется сразу.

### 3.6 Настройки

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **С1** Окно настроек | `web/src/ui/settings/settings.css:31`; появление `:35`; уход `:39` (длительность `:42`); телефон `:821` | открытие/закрытие (Base UI Dialog, `ui/settings/SettingsWindow.tsx:236`); подложка — Н11 | появление `--motion-base` (200ms); уход `--motion-fast` (120ms) | opacity — `--ease-standard`; transform — `--ease-emphasized` | opacity, transform: scale(0.98) translateY(8px), уход — scale(0.99); ≤767px — translateY(24px) | выкл. (глоб.) |
| **С2** Карточка профиля в списке разделов | `web/src/ui/settings/settings.css:92` | наведение | `--motion-fast` (120ms) | `--ease-standard` | background-color | выкл. (глоб.) |
| **С3** Пункты разделов | `web/src/ui/settings/settings.css:189` | наведение/выбор | `--motion-fast` (120ms) | `--ease-standard` | background-color, color | выкл. (глоб.) |
| **С4** Якоря подразделов | `web/src/ui/settings/settings.css:234` | наведение; текущий подраздел (`aria-current`) по прокрутке — слежение через `requestAnimationFrame` (`SettingsWindow.tsx:172`) | `--motion-fast` (120ms) | `--ease-standard` | color | выкл. (глоб.) |
| **С5** Шеврон сворачиваемой группы | `web/src/ui/settings/settings.css:351` | `aria-expanded` — rotate(−90deg) | `--motion-base` (200ms) | `--ease-standard` | transform | выкл. (глоб.) |
| **С6** Подсветка найденной строки (`setting-flash`) | `web/src/ui/settings/settings.css:392` (кадры `:394`) | переход к строке из поиска или подсказки: `data-flash` на 1600 мс (`ui/settings/Row.tsx:61`, литерал) | 1600ms | `--ease-standard` | opacity псевдоэлемента: держится до 40%, затем гаснет | заменено (`settings.css:403`): ровная подсветка без затухания на 1600 мс |
| **С7** Полоса уровня микрофона | `web/src/ui/settings/settings.css:493` | каждое новое значение: `useMicLevel` во встрече (≤30 Гц) или проверка устройства раз в 100 мс (`ui/settings/useDeviceCheck.ts:124`); ширина — инлайн `scaleX` (`Row.tsx:182`) | `--motion-fast` (120ms) | linear | transform: scaleX | выкл. (глоб.) → полоса шагает |
| **С8** Превью темы | `web/src/ui/settings/settings.css:724` | наведение/выбор | `--motion-fast` (120ms) | `--ease-standard` | box-shadow | выкл. (глоб.) |

Переключатели и ползунки — Н5–Н7. Переход к якорю — мгновенный `scrollTop`
(`SettingsWindow.tsx:141`).

### 3.7 Кинозал

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **К1** Спиннер загрузки и буферизации плеера (`watch-spin`) | `web/src/ui/cinema/theater.css:59` (кадры `:61`) | загрузка источника, буфер | 900ms, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.). Местное правило (`theater.css:66`) замедляет до 2.4s, но глобальное `!important` его перекрывает → значок стоит |
| **К2** Спиннер ожидания каталога | `web/src/ui/cinema/cinema.css:292` | ждём ответа площадки | 900ms, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.); местного правила нет |
| **К3** Спиннер «Ещё» в каталоге | `web/src/ui/cinema/cinema.css:525` | подгрузка следующей страницы | 900ms, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.) |
| **К4** Кнопка «Смотреть» на обложке | `web/src/ui/cinema/cinema.css:359` | наведение/фокус плитки | 140ms | ease | opacity | выкл. (глоб.) |
| **К5** Пульт плеера (`.watch-chrome`) | `web/src/ui/cinema/theater.css:84`; показан `:92` | бездействие `IDLE_MS` = 2500 мс (`ui/cinema/theater/WatchTheater.tsx:22`, `:131`) → `data-shown` (`ui/cinema/theater/Chrome.tsx:145`); будят мышь, касание, Tab | 160ms | ease | opacity; курсор прячется сразу (`:112`) | выкл. (глоб.) |
| **К6** Кнопки в середине кадра (`.watch-center`) | `web/src/ui/cinema/theater.css:129` | то же (`Chrome.tsx:179`) | 160ms | ease | opacity | выкл. (глоб.) |
| **К7** Субтитры поднимаются над пультом | `web/src/ui/cinema/theater.css:428` | `data-idle` плеера | 160ms | ease | **bottom**: 5% ↔ max(16%, 132px) | выкл. (глоб.) |
| **К8** Табличка-подсказка (`watch-hint`) | `web/src/ui/cinema/theater.css:531` (кадры `:533`) | действие с клавиатуры или жест; снимается через `HINT_MS` = 1800 мс (`WatchTheater.tsx:32`, `:158`) | 1800ms | ease, forwards | opacity: видна до 75%, затем гаснет | заменено (`theater.css:542` + глоб.): видна без затухания, снимается по `HINT_MS` |

Меню качества и субтитров (`.action-menu`, `ui/cinema/theater/menus/*`) появляются без анимации.

### 3.8 Музыка

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **М1** Спиннеры `.spin` в Яндекс Музыке и загрузке файлов | правило `web/src/styles.css:897`; `web/src/ui/YandexIntegration.tsx:201`, `:234`, `:277`; `web/src/ui/MusicUpload.tsx:66` | поиск, добавление трека, подключение токена, загрузка файлов (`busy`) | 1s, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб.) → значок стоит; в кнопке поиска (`:201`) остаётся только неподвижный `LoaderCircle` без текста |
| **М2** Позиция трека | `web/src/ui/MusicPlayer.tsx:40` (`setInterval`) | пока трек играет: позиция пересчитывается раз в 250 мс (литерал); бегунок — Н5 | шаг 250 мс | — | значение `<input type="range">` | н/п (шаговое обновление) |

### 3.9 Игры

#### Общее: панель «Игры», лица, полёт карт

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Иг1** Раскрытие пункта в панели «Игры» (`games-open`) | `web/src/poker.css:2403` (кадры `:2405`) | раскрыть игру (`ui/GamesGroup.tsx:226`, `:317`) | 0.2s | ease-out | opacity, transform: translateY(−4px) | выкл. (глоб.) |
| **Иг2** Шеврон пункта игры | `web/src/poker.css:2360` | `data-open` (`GamesGroup.tsx:223`) — rotate(180deg) | 0.18s | ease | transform | выкл. (глоб.) |
| **Иг3** Полёт карт: раздача, добор, сброс (`CardMotion`, `game-card-flight`) | `web/src/ui/GamePresentation.tsx:154`; CSS `web/src/game-polish.css:194` (кадры `:203`) | новые `visualEvents` (`deal`/`draw`/`discard`) моложе 2200 мс (`GamePresentation.tsx:98`), до 12 карт на событие. Задержка `min(order × 35, 1100) − прошедшее` + `index × 40` мс (`:134`, `:164`); слой чистится через 2300 мс (`:142`) | 420ms | ease-in-out, both | **left, top**, transform: translate/rotate(−12°→4°), opacity (гаснет после 85%) | JS: не запускается (`GamePresentation.tsx:66`, `:96`) + `display: none` (`game-polish.css:247`) + глоб. |
| **Иг4** Лица в ленте игры: обводка говорящего и размер | `web/src/game-people.css:36` | `data-speaking`; увеличение лица `--face-zoom` (`ui/FaceZoom.tsx:28`) | outline-color 150ms; width/height 160ms | ease | outline-color, **width, height** | выкл. (глоб. + `game-people.css:110`) |
| **Иг5** Кнопка увеличения лица | `web/src/game-people.css:95` | наведение/фокус на лицо | 120ms | ease | opacity | выкл. (глоб.) |

#### Покер

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Пк1** Толчок банка (`poker-pot-beat`) | `web/src/poker.css:354` (кадры `:356`) | прирост банка: пилюля пересобирается по `key={beat}` (`ui/PokerTable.tsx:275`) | 0.42s | cubic-bezier(0.2, 1.5, 0.4, 1) | transform: scale(1.14), box-shadow | выкл. (глоб. + `poker.css:2254`) |
| **Пк2** Место гаснет: пас, вылет | `web/src/poker.css:495` | `data-folded` / `data-busted` | 0.25s | ease (по умолчанию) | opacity, filter: grayscale | выкл. (глоб.) |
| **Пк3** Увеличение лица на месте | `web/src/poker.css:529` | `--face-zoom` | 160ms | ease | scale | выкл. (глоб.) |
| **Пк4** Пульс лица победителя (`poker-winner`) | `web/src/poker.css:566` (кадры `:568`) | `data-winner` | 1.1s × 3 | ease-out | box-shadow | выкл. (глоб. + `:2254`) |
| **Пк5** Лучи за победителем (`poker-spin`) | `web/src/poker.css:588` (кадры `:591`) | победитель раздачи (`PokerTable.tsx:924`) | 9s, бесконечно | linear | transform: rotate(360deg) | выкл. (глоб. + `:2254`) |
| **Пк6** Кольцо хода (`poker-countdown`) | `web/src/poker.css:690–692` (кадры `:694`); длительность и задержка инлайн в `PokerTable.tsx:1060–1063` | ход игрока: длительность `deadline − actionAt`, задержка — минус прошедшее время | всё время хода (с сервера) | linear, forwards | stroke-dashoffset; stroke — от золотого к оранжевому к 90% | **сохраняется** (`game-polish.css:412`, `!important` перебивает глобальное) |
| **Пк7** Ставка появляется (`poker-bet-in`) | `web/src/poker.css:737` (кадры `:739`) | новая ставка у места | 0.24s | cubic-bezier(0.2, 1.4, 0.4, 1) | opacity, transform: scale(0.7) | выкл. (глоб. + `:2254`) |
| **Пк8** Облачко действия (`poker-pop`) | `web/src/poker.css:773` (кадры `:785`) | действие игрока, «Пас», «Ждёт раздачу», «Отошёл» (`PokerTable.tsx:990–994`) | 0.22s | ease-out | opacity, transform: scale(0.8) | выкл. (глоб.; в списке `:2254` нет) |
| **Пк9** Комбинация под местом (`poker-combo-in`) | `web/src/poker.css:799` (кадры `:801`) | вскрытие (`PokerTable.tsx:995`) | 0.4s | ease-out, both | opacity, transform: translateY(6px) | выкл. (глоб. + `:2254`) |
| **Пк10** Выигрыш над местом (`poker-rise`) | `web/src/poker.css:816` (кадры `:818`) | итог раздачи (`PokerTable.tsx:997`) | 1.4s | ease-out, forwards | opacity, transform: translate/scale | выкл. (глоб. + `:2254`) → стоит в базовом положении |
| **Пк11** Табличка «Вылет» | `web/src/poker.css:843` (кадры `poker-combo-in` `:801`) | `seat.busted` (`PokerTable.tsx:999`) | 0.5s | ease-out, both | opacity, transform: translateY(6px) | выкл. (глоб. + `:2254`) |
| **Пк12** Пустое место «Сесть» | `web/src/poker.css:857` | наведение — scale(1.06) | 0.18s | ease (по умолчанию) | background, border-color, transform | выкл. (глоб.) |
| **Пк13** CSS-раздача карт (`poker-deal`) | `web/src/poker.css:887–889` (кадры `:1014`); длительность `DEAL_MS` = 1600 и задержка инлайн (`PokerTable.tsx:1100`; шаг `DEAL_STEP_MS` = 90, `core/poker.ts:25`, `:510`) | монтирование карты | 1600 мс (инлайн) | cubic-bezier(0.18, 0.72, 0.24, 1), both | opacity, transform: translate/rotate(−18°)/scale(0.72) | н/п: **не проигрывается никогда** — `game-polish.css:281` гасит её у всех карт без `data-highlight`; раздачу рисует Иг3 |
| **Пк14** Карта: смена состояния | `web/src/poker.css:890` | снятие `data-dead`, другие смены | filter 0.5s, opacity 0.5s, transform 0.3s | ease (по умолчанию) | filter, opacity, transform | выкл. (глоб.) |
| **Пк15** Карта гаснет на вскрытии (`data-dead`) | `web/src/poker.css:1005` | карта не вошла в комбинацию; сброшенная рубашка (`PokerTable.tsx:1099`) | 0.4s | ease | opacity (до 0.4), transform: scale(0.9); filter встаёт сразу | выкл. (глоб.) |
| **Пк16** Победная карта выезжает (`poker-lift`) | `web/src/poker.css:958` (кадры `:974`) | `data-highlight` на вскрытии | в правиле 0.6s, но инлайн `animation-duration: 1600ms` и `animation-delay` из `PokerTable.tsx:1100` его перекрывают: на деле 1600 мс, сдвиг отсчитан от `streetAt` (`:263`) или раздачи | cubic-bezier(0.22, 1.4, 0.36, 1), both | transform: translateY(−26%) scale(1.06) | выкл. (глоб. + `:2254`) → сразу в конечном положении |
| **Пк17** Золотой кант победной карты (`poker-glow`) | `web/src/poker.css:971` (кадры `:985`) | то же | 0.6s (инлайн на псевдоэлемент не действует) | ease-out, both | opacity (`::before`) | выкл. (глоб.; `:2254` псевдоэлемент не задевает) |
| **Пк18** Фишки летят (`poker-fly`) | `web/src/poker.css:1044` (кадры `:1065`); `PokerTable.tsx:347` | ставка, блайнды, сбор в банк, выплата (`useChipFlights`, `PokerTable.tsx:1769`). Задержки 0 / 180 / `index × 40` / 260 + 120·i мс, между дисками 60–80 мс; очистка через `COLLECT_MS` + 1200 = 1720 мс (`:1837`, `core/poker.ts:28`) | 620ms | cubic-bezier(0.3, 0.7, 0.2, 1), both | **left, top**, opacity | выкл. (глоб. + `:2254`) → диски стоят в точке вылета до очистки, 1,72 с |
| **Пк19** Горка фишки (`poker-fly-arc`) | `web/src/poker.css:1056` (кадры `:1077`) | то же | 620ms | ease-in-out, both | transform: translateY(−14px) scale | выкл. (глоб. + `:2254`) |
| **Пк20** Затемнение стола на вскрытии (`poker-dim-in`) | `web/src/poker.css:1102` (кадры `:1104`) | `phase = showdown` (`PokerTable.tsx:366`) | 0.5s | ease-out, both | opacity | выкл. (глоб.; в `:2254` нет) |
| **Пк21** Вспышка крупного банка (`poker-flash`) | `web/src/poker.css:1124` (кадры `:1130`); для huge — 1.8s (`:1128`) | `data-level` big/huge (`PokerTable.tsx:1707`) | 1.2s / 1.8s | ease-out, forwards | opacity (`::after`) | выкл. (глоб.) → свечение стоит, пока виден итог |
| **Пк22** Лента «Крупный банк» / «Огромный банк» / «Вылет» (`poker-ribbon`) | `web/src/poker.css:1155` (кадры `:1157`) | то же (`PokerTable.tsx:1708`) | 2.4s | ease-out, forwards | opacity, transform: scale(0.6→1.06→1) | выкл. (глоб. + `:2254`) → не гаснет, висит до смены итога |
| **Пк23** Имя победителя (`poker-cheer-name`) | `web/src/poker.css:1189` (кадры `:1191`) | big/huge (`PokerTable.tsx:1717`) | 2.8s | ease-out, forwards | opacity, transform: translate/scale | выкл. (глоб. + `:2254`) → не гаснет, висит до смены итога |
| **Пк24** Дождь фишек (`poker-rain`) | `web/src/poker.css:1236` (кадры `:1238`) | big — 18 фишек, huge — 34; задержка до 900 мс, поворот ±360° (`PokerTable.tsx:1701–1702`) | 1.9s | cubic-bezier(0.4, 0.1, 0.7, 1), forwards | transform: translateY(1100%) rotate, opacity | выкл. (глоб. + `:2254`) → фишки за верхней кромкой, их не видно |
| **Пк25** Кнопки хода | `web/src/poker.css:1330` | наведение — brightness; нажатие — translateY(1px) | transform 0.12s, filter 0.16s | ease (по умолчанию) | transform, filter | выкл. (глоб.) |
| **Пк26** Лист поверх сукна (`poker-sheet-in`; ≤560px — `poker-sheet-up`) | `web/src/poker.css:1588` (кадры `:1593`); `:2234` (кадры `:2236`) | открытие листа (`PokerTable.tsx:1610`); закрывается без анимации | 0.26s | cubic-bezier(0.2, 0.9, 0.2, 1) | opacity, transform: translateX(18px) / translateY(18px) | выкл. (глоб. + `:2254`) |
| **Пк27** Переключатель покера: дорожка | `web/src/poker.css:1876` | `aria-checked` | 0.18s | ease | background, border-color | выкл. (глоб.) |
| **Пк28** Переключатель покера: бегунок | `web/src/poker.css:1889` | то же — translateX(17px) | 0.18s | transform — cubic-bezier(0.3, 1.3, 0.5, 1); background — ease | transform, background | выкл. (глоб.) |

#### Дурак

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Д1** Бросок карты на стол (FLIP, WAAPI) | `web/src/ui/DurakMotion.tsx:259`; клон без CSS-движения `web/src/ui/durak-motion.css:14–15`, `will-change` `:19` | подтверждённый ход `play`/`transfer` моложе 1500 мс, не больше 4 за раз (`DurakMotion.tsx:196`, `:199`). Своя карта летит из точки захвата (не старше 5000 мс), чужая — от места игрока | `min(360, max(280, 260 + расстояние × 0.2))` мс (`:254`); страховка `duration + 100` (`:296`) | cubic-bezier(0.2, 0.65, 0.3, 1), fill both; дуга — промежуточный кадр на 0.58 | transform: translate3d, rotate, scale | JS: не запускается (`DurakMotion.tsx:80`, `:100`, `:176`) |
| **Д2** Веер руки при раздаче (`durak-fan-in`) | `web/src/durak.css:807–808` (кадры `:1218`) | `data-dealing` в течение `DEAL_MS` + 700 = 2100 мс после раздачи (`ui/DurakTable.tsx:115`, `:580`; `core/durak.ts:17`) | 380ms; задержка `i × 70 + 200 − dealt` мс (70 — литерал, равен `DEAL_STEP_MS`, `core/durak.ts:20`) | cubic-bezier(0.2, 0.7, 0.3, 1), both | translate (0 70px), rotate, opacity | выкл. (`no-preference` `durak.css:805` + глоб.) |
| **Д3** Бой уходит к взявшему или в отбой (`durak-sweep`) | `web/src/durak.css:242` (кадры `:1187`) | конец боя `data-end`; цель и сдвиг считаются в `DurakTable.tsx:800–811`; задержка `--sweep-delay` = 450 мс минус прошедшее | 620ms | cubic-bezier(0.45, 0, 0.75, 0.3), both | translate, scale(0.4), opacity | выкл. (`no-preference` `durak.css:240` + глоб.) |
| **Д4** Метка перевода скользит к новому защитнику (`durak-transfer`) | `web/src/durak.css:607` (кадры `:1194`) | перевод (`DurakTable.tsx:494`; `animation-delay: −ago`, `:502`) | 1100ms | cubic-bezier(0.3, 0.7, 0.3, 1), both | **left, top**, opacity, scale | выкл. (`no-preference` `durak.css:605` + глоб.) → метки не видно вовсе: базовое `opacity: 0` (`durak.css:602`) |
| **Д5** Лицо «дурака» качается (`durak-fool`) | `web/src/durak.css:575` (кадры `:1225`) | конец партии, `data-fool` (`DurakTable.tsx:1029`) | 650ms × 2 | ease-in-out | rotate (±9°) | выкл. (`no-preference` `:573` + глоб.) |
| **Д6** Свечение первого вышедшего (`durak-first`) | `web/src/durak.css:578` (кадры `:1243`) | `data-first` (`DurakTable.tsx:1030`) | 1.2s × 2 | ease-out | box-shadow | выкл. (`no-preference` `:573` + глоб.) |
| **Д7** Увеличение лица на месте | `web/src/durak.css:488` | `--face-zoom` | 160ms | ease | scale | выкл. (глоб.) |
| **Д8** Перетаскивание карты | `web/src/ui/DurakTable.tsx:292` (`requestAnimationFrame`); слой `durak.css:893` (`will-change: transform`) | движение указателя; наклон ±12° по сдвигу (`DurakTable.tsx:289`) | каждый кадр | — | transform | н/п (прямое управление) |

Карты к местам при раздаче летят через Иг3. Без движения:

- выбор карты в руке — сдвиг на −12px сразу (`durak.css:764`: `transition: none`);
- лист дурака (`.durak-sheet`, `durak.css:924`);
- реакции-стикеры: 29 статичных webp, анимированных нет; появляются и исчезают без перехода
  (`ui/DurakReactions.tsx:77`, `game-polish.css:127`);
- прокрутка руки кнопками — `scrollBy` без плавности (`DurakTable.tsx:570`, `:620`).

#### Шахматы

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Ш1** Ход фигуры (`chess-travel`) | `web/src/chess.css:179` (кадры `:590`) | свежий ход: ровно +1 полуход, моложе 1800 мс (`ui/ChessTable.tsx:868`); слой снимается через 280 мс (`:884`, литерал) | 280ms | cubic-bezier(0.2, 0.6, 0.3, 1), both | transform: translate(--from-x, --from-y → 0) | JS: не запускается (`ChessTable.tsx:850`, `:864`) + `chess.css:686` + глоб. |
| **Ш2** Превращение: пешка гаснет (`chess-promote-out`) | `web/src/chess.css:189` (кадры `:598`) | ход с превращением | 280ms | linear, both | opacity (с 75%) | JS: не запускается + глоб. |
| **Ш3** Превращение: новая фигура (`chess-promote-in`) | `web/src/chess.css:192` (кадры `:607`) | то же | 280ms | linear, both | opacity (с 75%) | JS: не запускается + глоб. |
| **Ш4** Перетаскивание фигуры | `web/src/ui/ChessTable.tsx:704–708` | движение указателя (`left`/`top` из состояния React) | каждое событие указателя | — | left, top | н/п (прямое управление) |

Запись партии прокручивается к последнему ходу без плавности (`ChessTable.tsx:134`).

#### Gartic

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Г1** Чужие штрихи прорисовываются (`RemoteInk`) | `web/src/ui/GarticCanvas.tsx:130–132` (`requestAnimationFrame`) | 1–4 новых штриха между снимками; если больше — без анимации (`:104`) | 200 мс (литерал, `:119`), штрихи по очереди | линейно по прогрессу | stroke-dashoffset, visibility (SVG) | JS: не запускается (`GarticCanvas.tsx:83`, `:89`) |
| **Г2** Следующая запись в показе альбома (`gartic-reveal`) | `web/src/gartic.css:1223` (кадры `:1357`) | смена записи, пересборка по `key` (`ui/GarticResults.tsx:352`) | 220ms | ease-out | opacity 0.35→1 | выкл. (глоб. + `gartic.css:1747`) |
| **Г3** Стрелка раскрытия результата | `web/src/gartic.css:980` | `aria-expanded` — rotate(180deg) | 150ms | ease | transform | выкл. (глоб. + `gartic.css:1752`) |

### 3.10 Прочее

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **Пр1** Все нативные `<button>` (старое базовое правило) | `web/src/styles.css:46` | наведение, фокус, нажатие на кнопке без своего `transition`: прихожая, кинозал, игры, старые экраны | 150ms | ease (по умолчанию) | background, color, box-shadow | выкл. (глоб.) |
| **Пр2** Подложка старого `Modal` | `web/src/styles.css:672` | открытие `Modal` (`ui/primitives.tsx:127`): реакции дурака, превращение пешки и др. | 150ms | ease (по умолчанию) | opacity. Начального состояния (`data-starting-style`) нет, поэтому подложка появляется сразу; у окна `.modal` перехода нет | выкл. (глоб.) |

Плавной прокрутки в клиенте нет нигде. `scroll-behavior: smooth` не задан.
`scrollIntoView`, `scrollBy` и `scrollTop` срабатывают мгновенно:

- `ChessTable.tsx:134`
- `ui/cinema/catalog/arrow-nav.ts:67`
- `DurakTable.tsx:570`, `:620`
- `Sidebar.tsx:141`
- `ui/GarticTable.tsx:442`
- `SettingsWindow.tsx:141`

View Transitions API, CSS `@starting-style` и библиотек анимации нет.

## 4. Наблюдения

1. **Глобальное `!important` ломает намеренные исключения.** Под `reduce` статичная загрузка
   пустая: `animation: none !important` (`styles.css:1027`) гасит и проявление `fl-in`, а
   `.fl__fade` стоит на `opacity: 0` (`index.html:72`, `loader.css:41`). Видно только фон.
   Намерение обратное: «Проявление остаётся» (`loader.css:194`).
   `web/src/ui/loader/loader.test.ts:72` проверяет только текст CSS. По той же причине:
   - не видна строка «Сеть медленная» с кнопкой «Повторить», хотя кнопка нажимается
     (`loader.css:146–147`);
   - не работает режим `data-reduced='breathe'` (`loader.css:201`);
   - спиннер плеера стоит вместо замедления до 2.4s (`theater.css:66–69`).
2. **Не обработано под `reduce`:** WAAPI-уходы загрузки `boot.ts:27` и
   `FullscreenLoader.tsx:79`. Это только opacity, 120–200 мс.
3. **Исчезновение заложено в самой анимации.** Под `reduce` эти элементы не исчезают, пока в
   снимке есть итог раздачи:
   - `.poker-ribbon` (`poker.css:1155`);
   - `.poker-cheer-name` (`:1189`);
   - вспышка `.poker-cheer::after` (`:1124`).

   Ещё два элемента зависят от анимации иначе:
   - диски `.poker-flight` стоят в точке вылета 1,72 с (`:1044`, `PokerTable.tsx:1837`);
   - метки перевода дурака не видно совсем (`durak.css:602`, `:605`).
4. **Выключение задано в двух местах, а не в одном.** Токены → `0ms` (`tokens.css:327`) и
   глобальное `none` (`styles.css:1023`). Ещё 18 местных блоков, и большинство дублирует
   глобальное. Спецификация E16 обещает «в одном месте (`tokens.css`)»
   (`2026-10-19-design-system.md`, §2). На деле всё решает `styles.css:1023`.
5. **Литералы вместо токенов: 72 строки из 123.** Токены не используют загрузка, кинозал, игры
   и старые правила. Литералы одного смысла:
   - 150ms — `styles.css:46`, `:672`, `gartic.css:980`, `game-people.css:36`;
   - 160ms — `theater.css:84`, `:129`, `:428`, `poker.css:529`, `durak.css:488`, `game-people.css:36`;
   - 0.18s — `poker.css:857`, `:1876`, `:1889`, `:2360`;
   - 140ms — `cinema.css:359`; 190ms — `room-layout.css:163`; 0.2s — `poker.css:2403`.

   Все они укладываются между `--motion-fast` (120) и `--motion-base` (200). Есть смешанные
   правила: литерал 1.2s с токеном кривой (`meeting-header.css:154`), 1600ms с токеном
   (`settings.css:392`), токен длительности с `linear` (`settings.css:493`).
6. **Кривые.** Игры и кинозал берут ключевые слова `ease` / `ease-out` / `ease-in-out` / `linear`.
   Четыре кривые с перелётом (y > 1):
   - `poker.css:354` (0.2, 1.5, 0.4, 1);
   - `:737` (0.2, 1.4, 0.4, 1);
   - `:958` (0.22, 1.4, 0.36, 1);
   - `:1889` (0.3, 1.3, 0.5, 1).

   Токена «пружины» нет. `--ease-exit` объявлен, но не используется: меню, диалог, окно
   настроек, тост и выдвижная панель уходят той же `--ease-emphasized`, что и появляются
   (`kit.css:530`, `:639`, `:728`, `settings.css:31`, `home.css:638`).
7. **Дубли и разнобой:**
   - три спиннера с разной скоростью: `spin` 1s (`styles.css:897`), `ui-spin` 0.8s
     (`kit.css:136`), `watch-spin` 900ms (`theater.css:59`);
   - два переключателя: `.ui-switch` 200ms emphasized (`kit.css:398`) и `.poker-toggle` 0.18s с
     перелётом (`poker.css:1889`);
   - поворот шеврона в четырёх вариантах: 120ms standard (`shell.css:163`), 200ms standard
     (`home.css:270`, `settings.css:351`), 0.18s ease (`poker.css:2360`), 150ms ease
     (`gartic.css:980`);
   - кольцо говорящего: плитка и список гаснут за 320ms (`stage.css:165`, `meeting-panel.css:155`),
     лица в ленте игры — за 150ms ease (`game-people.css:36`), лицо на месте в покере — без
     перехода (`poker.css:553`);
   - меню: `.ui-menu` движется, старое `.action-menu` (меню участника, качества и субтитров,
     `styles.css:806`) — нет;
   - листы: `.poker-sheet` въезжает, `.durak-sheet` — нет; у `Modal` переход объявлен, но не
     срабатывает (`styles.css:672`);
   - в `Switch.tsx:6` написано `--motion-fast`, а в CSS стоит `--motion-base` (`kit.css:398`).
8. **Анимация свойств раскладки и перерисовки.**
   - `left`/`top`: полёт фишек (`poker.css:1065`), полёт карт (`game-polish.css:203`), метка
     перевода (`durak.css:1194`).
   - `bottom`: субтитры (`theater.css:428`).
   - `width`/`height`: лица в ленте (`game-people.css:36`).
   - `width`: подложка вкладок (`kit.css:490`).
   - box-shadow в кадрах и переходах: `stage.css:165`, `meeting-panel.css:155`, `poker.css:356`,
     `:568`, `durak.css:1243`.
   - filter: `poker.css:495`, `:890`, `:1330`.
9. **Мёртвое и витринное.**
   - `poker-deal` (`poker.css:887–889`, `:1014`) погашена правилом `game-polish.css:281`.
   - `.durak .durak-ring-run` / `durak-drain` (`game-polish.css:414–415`): нет ни элемента, ни
     `@keyframes`.
   - `.ui-card--interactive` (`kit.css:862`) в продукте не используется.
   - `FullscreenLoader` (З6–З8) есть только на `/kit`.
10. **Инлайн перекрывает CSS.** `PokerTable.tsx:1100` задаёт `animation-duration: 1600ms` для
    любой анимации `.playing-card`. Подъём победной карты `poker-lift` записан на 0.6s
    (`poker.css:958`), а длится 1600 мс со сдвигом от раздачи. Кант (`::before`, `:971`)
    остаётся на 0.6s, и подъём с кантом расходятся.
11. **Длинные анимации.**
    - Бесконечные: `preview-drift` 14s (`stage.css:307`), `poker-spin` 9s (`poker.css:588`),
      `fl-sway` 6s (`index.html:85`).
    - Разовые дольше секунды: `poker-cheer-name` 2.8s, `poker-ribbon` 2.4s, `poker-rain` 1.9s,
      `watch-hint` 1.8s, `setting-flash` 1.6s, `poker-rise` 1.4s, `durak-transfer` 1.1s.
    - С повторами: `poker-winner` 1.1s × 3 = 3,3 с, `durak-first` 1.2s × 2 = 2,4 с.
    - Самые короткие: 120ms (`--motion-fast`, `game-people.css:95`) и 0.12s (`poker.css:1330`).
12. **Уход пульта во весь экран мгновенный.** Вместе с `opacity` ставится `visibility: hidden`
    без перехода (`call-dock.css:155`, `stage.css:810`), поэтому плавно только появление. В
    плеере анимируется одна opacity (`theater.css:84`), там уход плавный. Таймеры
    бездействия тоже разные: 3000 мс во встрече (`MeetingView.tsx:80`, литерал) и
    `IDLE_MS` = 2500 мс в плеере (`WatchTheater.tsx:22`).

## 5. Сводка

| Область | Строк | Гасит или заменяет под `reduce` | из них своим правилом или JS | Не обработано | Сохраняется | н/п | На токенах (полностью / частично) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Загрузка | 8 | 6 | 5 | 2 | — | — | 0 / 0 |
| Оболочка и главная | 18 | 18 | 0 | — | — | — | 18 / 0 |
| Набор (kit) | 16 | 16 | 0 | — | — | — | 15 / 0 |
| Прихожая | 1 | 1 | 0 | — | — | — | 0 / 0 |
| Встреча | 12 | 12 | 3 | — | — | — | 9 / 1 |
| Настройки | 8 | 8 | 1 | — | — | — | 6 / 2 |
| Кинозал | 8 | 8 | 2 | — | — | — | 0 / 0 |
| Музыка | 2 | 1 | 0 | — | — | 1 | 0 / 0 |
| Игры: общее | 5 | 5 | 2 | — | — | — | 0 / 0 |
| Игры: покер | 28 | 26 | 14 | — | 1 | 1 | 0 / 0 |
| Игры: дурак | 8 | 7 | 6 | — | — | 1 | 0 / 0 |
| Игры: шахматы | 4 | 3 | 3 | — | — | 1 | 0 / 0 |
| Игры: Gartic | 3 | 3 | 3 | — | — | — | 0 / 0 |
| Прочее | 2 | 2 | 0 | — | — | — | 0 / 0 |
| **Всего** | **123** | **116** | **39** | **2** | **1** | **4** | **48 / 3** |

- Всего 123 строки. На игры приходится 48, на оболочку с главной — 18, на набор — 16.
- Под `reduce` гаснет или заменяется на статичное состояние 116 строк. Из них:
  - 77 гасит только глобальное правило;
  - у 31 есть ещё местное CSS-правило;
  - 6 не запускает сам код (Иг3, Д1, Ш1–Ш3, Г1);
  - 2 заменены (С6, К8).
- Не обработано 2 (З5, З8). Сохраняется намеренно 1 (Пк6). Неприменимо 4: прямое управление
  Д8 и Ш4, шаговое обновление М2, никогда не проигрываемая Пк13.
- У 4 строк глобальное `!important` перекрывает местное намерение или прячет нужное: З1, З3,
  З7, К1.
- На токенах полностью 48 строк, частично 3 (В8, С6, С7), на литералах или в JS 72.
- Правило `.spin` (`styles.css:897`) учтено в двух областях: П1 и М1.
- В CSS 20 блоков `@media (prefers-reduced-motion: …)`: глобальный, токенов, 14 местных
  `reduce` и 4 `no-preference`. В JS — 4 проверки.

## 6. Дополнение E15-B (вечер 20.10.2026)

Что добавили эпики после E15-A: выбор площадки (T59), предупреждения антибота (E11-B), фон на телефоне (E12),
язык (E14-A), Mini App Telegram (E09), окна клиента на Electron (E01-B). Сверено по `main` 520d559 и
`ModernStreamingSystem.Windows/desktop/src/shell/*` (ветка E01-B). Префиксы: **И** — интеграции, **Т** — Telegram,
**Э** — окна Electron.

| Что движется | Где (файл:строка) | Повод (триггер) | Длительность | Кривая | Свойства | reduced motion |
| --- | --- | --- | --- | --- | --- | --- |
| **И1** Шаг панели интеграций (`.services-panel`, `services-step`) | `web/src/ui/integrations.css:21` (кадры `:23`) | смена содержимого панели: витрина ↔ группа ↔ выбор площадки (`key` в `Services.tsx:210–258`) | `--motion-base` 200ms | `--ease-emphasized` | opacity 0→1, translateY 8px→0 | выкл. (токены → 0, глоб.) |
| **И2** Плитка и группа под указателем (`.service-group`, `.service-tile`) | `integrations.css:79` | наведение | `--motion-fast` 120ms | `--ease-standard` | background-color, box-shadow, transform | выкл. (глоб.) |
| **И3** Шеврон группы (`.service-group__chevron`) | `integrations.css:161` | наведение на группу | `--motion-fast` | `--ease-standard` | transform translateX 0→2px | выкл. (глоб.) |
| **И4** Вкладка площадки музыки (`.platform-tab`, T59) | `integrations.css:270` | наведение, выбор | `--motion-fast` | `--ease-standard` | background-color, color | выкл. (глоб.) |
| **И5** Место «Перетащите аудиофайлы» (`.music-add[data-over]`) | `integrations.css:516` | файл над панелью | `--motion-fast` | `--ease-standard` | background-color (+ пунктир) | выкл. (глоб.) |
| **И6** Строка очереди (`.music-queue__row`) | `integrations.css:744`; поднятая — без перехода `:753` | наведение; перетаскивание | `--motion-fast` | `--ease-standard` | background-color | выкл. (глоб.) |
| **Т1–Т4** Статичная загрузка Mini App (`fl-in`, `fl-sway`, `fl-breathe`, `fl-bob`) | `web/tg.html:47`, `:59`, `:67`, `:85` (кадры `:92–115`) | открытие Mini App до бандла | 240ms; 6s; 3s; 1.2s бесконечно | как З1–З4 | как З1–З4 | Т2–Т4 выкл. местным правилом `tg.html:123`; Т1 под него не попадает и играет 240 мс — сцена видна. В вебе (З1) глобальное `!important` гасит проявление, и сцена пустая |
| **Э1** Бегущая полоса заставки обновления (`.bar.busy > i`, `slide`) | `desktop/src/shell/splash.html:14` (кадры `:15`) | проверка и установка (В-1, T58) | 1.2s, бесконечно | ease-in-out | left −40%→100% | **не обработано** |
| **Э2** Заполнение полосы при загрузке (`.bar > i`) | `splash.html:13` | прогресс загрузки обновления | 0.2s | ease-out | width | **не обработано** (короткое, допустимо) |
| **Э3** Дыхание знака в окне загрузки (`.mark`, `breathe`) | `desktop/src/shell/loading.html:11` (кадры `:12`) | веб грузится в окне клиента (T55) | 1.6s, бесконечно | ease-in-out | transform scale 1→1.06, opacity 0.9→1 | выкл. (`loading.html:13`) |

Без движения (появляются сразу, проверено по коду): подсказка о фоне `.background-note` (`ui/stage.css:469`), плашка
«Встреча завершится в …» и предупреждение у файла (`ui/abuse/notices.css`), смена языка (E14-A — без перезагрузки и
без перехода), окна «Серверы», «Что показать» и оверлей Electron (наведение без перехода). Окно «Переход по ссылке» —
`Dialog` набора, его появление уже в перечне (Н-строки). «Свернуть в окно» (PiP) — анимация системы.

**Наблюдения E15-B.** Э1 крутится под `reduce` — заставке нужно правило как у Э3 (ветка Windows, E01-B). Т1 под `reduce`
виден, а З1 в вебе — нет: одна и та же сцена ведёт себя по-разному из-за глобального `!important` (`styles.css:1027`);
чинить в вебе, как советует наблюдение к З1.

Итог с дополнением: **136** строк (123 + 13: И1–И6, Т1–Т4, Э1–Э3), не обработано **4** (З5, З8, Э1, Э2).
