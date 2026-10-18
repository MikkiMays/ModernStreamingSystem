# Полноэкранная загрузка Cord (`FullscreenLoader`): исследование и выбор — спецификация (E16 шаг 4а, T55, П14)

Дата: 19.10.2026. Статус: исследование готово, выбор сделан агентом. В `DECISIONS.md` → «Решено
агентом» пока не внесён (эта сессия правила только этот файл). Текст записи — в конце.

## Контекст

T55: «…там как загрузка покера, но… оно всецело заполоняет пространство… прошарить гиты и
различные решения, выбрать наиболее лучшее для современной системы». Референс —
`backlog/refs/img/IMG_5878-cardbox-loading.png`: Mini App Cardbox в полноэкранном режиме Telegram.
Тёмно-синий фон без рамок. В центре 8–10 карт (игральные, UNO, рубашки) разлетаются в 3D с
поворотами по трём осям, под ними мягкая эллиптическая тень, будто карты парят над столом. Ниже —
марка (знак и слово). Полосы прогресса и слова «загрузка» нет. По П14 это один компонент и один
язык движения для старта веба, окна Electron, Mini App и входа в игру (у каждой игры своя сцена).

Что важно в коде сейчас (проверено):
- `web/index.html` — пустой `#root` без фона; тема ставится в `App.tsx:45–48` из
  `localStorage['cord:theme']` **после** монтирования React. Пока не выполнился JS, пользователь
  с ручной тёмной темой на светлой ОС видит светлый фон. Белая вспышка есть уже сейчас.
- `infra/Caddyfile:25` — CSP `script-src 'self' 'wasm-unsafe-eval'; style-src 'self'
  'unsafe-inline'; connect-src 'self' …; frame-ancestors 'none'`. Встроенный `<style>`
  разрешён, а встроенный `<script>` **нет** (нужен хеш). Загрузка wasm с CDN тоже запрещена.
- Первая загрузка сейчас весит ≈ **309 КБ gzip** JS+CSS (`dist/index.html`: index 103,7 +
  livekit-client 132,9 + primitives 28,3 + useQuery 7,6 + прочее 5,4 + CSS 31,1). Сам HTML —
  1,1 КБ gzip. `public/sw.js` хранит копию `index.html`, поэтому всё, что лежит внутри него,
  показывается и без сети.
- WAAPI в коде уже используется (`ui/DurakMotion.tsx:254`). Хук `useMediaQuery` для
  `prefers-reduced-motion` есть в `ui/primitives.tsx:78`.

## Критерии

1. Вес в бандле (gzip), и главное — **может ли сцена появиться до загрузки JS**. Загрузка,
   которой нужна библиотека, не закрывает ту самую загрузку, ради которой она нужна.
2. 60 fps на слабом телефоне. Анимируются только `transform`/`opacity` на компоновщике, и сцена
   **не замирает, пока основной поток разбирает бандл**.
3. Работает в WebView Telegram (iOS WKWebView, Android System WebView, Desktop), Electron,
   WebView2 и без сети. Совместимо с нашим CSP.
4. `prefers-reduced-motion`, лицензия, насколько удобно писать свои сцены: карты для покера и
   дурака, шахматы, марка Cord.

## Вес: замер

Метод: каждый пакет поставлен из npm (`--ignore-scripts`) и собран rolldown из Vite 8 проекта
(`minify`, ESM, браузерные условия, `react`/`react-dom` вынесены). Сжатие — gzip −9 и brotli 11.
Wasm сжат отдельно. Скрипты замера лежат в `/tmp/loader-bench/scripts/` (временные, вне реп).

| Подход (версия)                                   | min, КБ | gzip, КБ | br, КБ | wasm gzip, КБ | + к первой загрузке |
|---------------------------------------------------|--------:|---------:|-------:|--------------:|--------------------:|
| **CSS 3D + @keyframes в `index.html`** (прототип: 8 карт, тень) | 1,9 | **0,9** | — | — | **+0,3 %, рисуется до JS** |
| WAAPI `Element.animate` (платформа)               | 0       | 0        | 0      | —             | 0 |
| Motion 14.3 `motion/mini` `animate`               | 8,0     | 3,2      | 2,9    | —             | +1 % |
| Motion `motion/react-mini` `useAnimate`           | 8,3     | 3,3      | 3,0    | —             | +1 % |
| Motion `motion/react-m` (только `m`)              | 12,4    | 5,1      | 4,7    | —             | +2 % |
| Motion `m` + `LazyMotion` + `domAnimation`        | 88,0    | 31,1     | 28,4   | —             | +10 % |
| Motion `motion/react` `motion.div`                | 131,2   | 42,7     | 38,5   | —             | +14 % |
| GSAP 3.15 core                                    | 70,0    | 27,3     | 24,6   | —             | +9 % |
| lottie-web 5.13 (полный, есть `eval`)             | 307,3   | 77,1     | 64,5   | —             | +25 % |
| lottie-web `lottie_light`                         | 169,8   | 47,3     | 41,1   | —             | +15 % |
| @lottiefiles/dotlottie-web 0.81                   | 61,4    | 13,7     | 12,1   | 496 (1238 raw) | +165 % |
| @rive-app/canvas-lite 2.45                        | 194,0   | 53,3     | 46,2   | 324 (792 raw) | +122 % |
| @rive-app/canvas 2.45                             | 275,9   | 69,2     | 59,5   | 866 (2096 raw) | +303 % |
| three 0.186 (минимальный набор: renderer, сцена, свет) | 527,1 | 129,3 | 106,0 | —           | +42 % |
| @react-three/fiber 9.8 + three                    | 914,7   | 240,0    | 197,4  | —             | +78 % |

Сверка с документацией: Motion сам пишет `motion` ≈ 43 КБ, `m` ≈ 5 КБ, `useAnimate` mini 3,3 КБ,
hybrid 23 КБ — с замером совпадает. dotLottie сообщает «wasm ≈ 500 КБ сжатый» — тоже совпадает.
Распакованный размер в npm: motion 0,8 МБ, lottie-web 25,4 МБ, dotlottie-web 7,4 МБ, three
20,4 МБ, gsap 6,3 МБ. Готовое видео или анимированный AVIF с отрендеренной 3D-сценой — по оценке
сотни КБ на 2–3 с петли, и для `reduced-motion` всё равно нужен постер. Этот путь не замерялся.

## Плавность: предварительный замер

Стенд: Playwright 1.63, Chrome for Testing 153 (headless shell), экран 390×844 при DPR 2, CPU
замедлен ×6 и ×4 через CDP. Одна и та же сцена из 8 карт сделана тремя способами: CSS
`@keyframes`, WAAPI и покадровый JS через `requestAnimationFrame`. Последний — модель того, как
рисуют GSAP, JS-путь Motion, lottie-web, Rive canvas и Three/R3F: каждый кадр считается в
основном потоке. В «нагрузке» основной поток занят шестью задачами по 400 мс подряд — так
выглядит разбор и выполнение бандла. Считались кадры `DrawFrame` из трассировки и самый длинный
разрыв между ними. Окно — 3 с, 3 прогона, в таблице медиана.

| Сцена, CPU ×6       | fps без нагрузки | fps под нагрузкой | макс. разрыв под нагрузкой |
|---------------------|-----------------:|------------------:|---------------------------:|
| CSS `@keyframes`    | 39,6             | **42,9**          | **141 мс**                 |
| WAAPI               | 39,6             | 22,0 (разброс 18–37) | 1658 мс (шумно)         |
| JS `rAF`            | 36,3             | **8,1**           | **436 мс** (≈ длина задачи) |

При ×4 картина та же: CSS 44,7 → 42,9 fps, rAF 38,4 → 10,8 fps с разрывом 447 мс.

**Оговорка.** Сервер был перегружен (load average 17–32 на 4 vCPU), растеризация программная,
поэтому сами числа fps ничего не говорят о телефоне. Надёжен только относительный сигнал:
покадровая JS-анимация **стоит всё время, пока идёт длинная задача**, а CSS-анимация продолжает
идти. Это сходится с web.dev: «CSS-based animations, and Web Animations… are typically handled on
a thread known as the compositor thread… can keep going without being interrupted». Motion
говорит то же: «hardware accelerated will remain smooth, no matter how busy your main JS thread
becomes». Провал WAAPI под нагрузкой противоречит теории и, скорее всего, вызван шумом. Его
перемерить на спокойной машине с GPU и на телефоне. Пока бесконечная петля делается **на CSS**,
а WAAPI остаётся для одноразовых переходов (уход экрана, игровые вставки).

## Совместимость, офлайн, CSP

| Окружение | CSS 3D / WAAPI / `reduced-motion` | Что важно |
|---|---|---|
| Telegram iOS (WKWebView) | да / да (Safari 13.1+) / да | до iOS 15.4 нужен `-webkit-backface-visibility` |
| Telegram Android (System WebView, Chromium) | да / да / да | WebView обновляется через Play |
| Telegram Desktop (системный webview через lib_webview) | да | на Linux подтверждён WebKitGTK; Windows/macOS — WebView2/WKWebView по устройству lib_webview, проверить. Не только Chromium |
| Telegram Web (`web.telegram.org`) | да | Mini App открывается в **iframe**: `frame-ancestors 'none'` и `X-Frame-Options DENY` из Caddyfile его заблокируют. Это задача E09 |
| Electron (Chromium) | да | `BrowserWindow({ backgroundColor })` |
| WebView2 (нынешняя оболочка Windows) | да | `DefaultBackgroundColor`, лучше через `WEBVIEW2_DEFAULT_BACKGROUND_COLOR`: у API известное мерцание |
| Без сети | да: стили внутри `index.html`, который хранит `sw.js` | Rive и dotLottie по умолчанию берут wasm с unpkg/jsdelivr (видно в их `rive.js` и `dist/index.js`). Нужен `setWasmUrl` на свой адрес, а с CDN их и так не пустит `connect-src 'self'` |
| CSP `script-src 'self'` | не мешает CSS | в полном lottie-web есть `eval(` (выражения) — CSP его запретит, годится только `lottie_light` |

## Лицензии и авторинг сцен

| Подход | Лицензия | Своя 3D-сцена (карты, шахматы, марка) |
|---|---|---|
| CSS + WAAPI | платформа | настоящее 3D (`perspective`, `preserve-3d`, `backface-visibility`), как у Cardbox. Сцена — это данные (массив карт) плюс общие кадры. Масти и знак — SVG, чёткие при любом DPR. Читаемый diff в git, графический редактор не нужен |
| Motion | MIT | удобные цепочки и `stagger`, но 3D всё равно на CSS. Это только JS поверх, и только после загрузки бандла |
| GSAP 3.15 | «Standard 'no charge' license» (так в `package.json`). После покупки Webflow (осень 2024) бесплатен с 2025 года, в том числе коммерчески и с плагинами, но это **не OSI**: запрещено применять в инструментах, конкурирующих с визуальным построителем анимаций Webflow. Для открытого проекта это лишняя оговорка | рисует покадрово через свой rAF-тикер — замирает вместе с основным потоком |
| lottie-web, dotLottie | MIT; авторинг — After Effects + Bodymovin или LottieFiles Creator | 3D ограничено: «Z position is respected; layer ordering by Z may not be», X/Y-вращение «Limited», камеры не экспортируются. Сальто карты по-честному не сделать |
| Rive | рантайм MIT. Редактор бесплатен, но **экспорт с 20.10.2025 только на платных планах** (Cadet $9/мес) | отличный редактор и машины состояний, но сцена 2D (переворот приходится имитировать через `scaleX`), бинарный `.riv` в репе |
| Three / R3F | MIT | настоящее 3D со светом, но +129–240 КБ, контекст WebGL в WebView (потеря контекста, компиляция шейдеров на слабом GPU) и rAF в основном потоке |

## Открытые примеры (только приёмы, код не переносим)

1. **Grafana** — `public/views/index.html` (AGPL-3.0, ≈77 тыс. ★). Загрузка на весь экран
   встроена в HTML: логотип подпрыгивает и сжимается на чистом CSS, фон темы задан во встроенном
   `<style>`. У сцены `opacity: 0` и `animation-delay: 0.5s`: если приложение готово раньше, её
   никто не видит. Есть `role="status"` и `aria-label`. Если бандл не стартовал к `window.onload`,
   `__grafana_load_failed()` показывает объяснение вместо вечной анимации.
2. **Mattermost** — `webapp/channels/src/components/initial_loading_screen/` (AGPL). Тоже
   полноэкранная загрузка на CSS, и в десктопной оболочке она отключена: там есть своя. Но
   `MINIMUM_LOADING_TIME = 1000` мс — искусственная задержка, а шаблон весит 778 КБ (105 КБ
   gzip) встроенного SVG. Это **антипример** по весу и по П14.
3. **VS Code** — `src/vs/code/electron-browser/workbench/workbench.ts`, `showSplash()` (MIT). До
   загрузки рабочей области рисует «каркас» цветами сохранённой темы, окно Electron тоже
   получает фон темы. Образец «тема до JS».
4. **Tonkeeper TWA** — `apps/twa/index.html`, открытый Mini App. Тёмный фон прямо в
   `<body style="background:#10161F">`, ещё до JS.
5. **Excalidraw** — `LoadingMessage.tsx`, prop `delay`: пока задержка не прошла, рендерит `null`.
   **spin-delay** (MIT) — `delay: 500`, `minDuration: 200`. Берём только задержку показа:
   минимальная длительность противоречит П14.

## Решение

**CSS 3D + `@keyframes`, встроенные в `index.html`, плюс нативный WAAPI для ухода экрана и
одноразовых переходов. Новых зависимостей ноль.** Почему:
- Только этот путь рисует сцену с **первого кадра, до JS**. Остальные подключаются после
  загрузки и разбора бандла, то есть пропускают ту загрузку, ради которой затевались.
- Петля идёт на компоновщике и не замирает, пока бандл разбирается (замер выше). У rAF-подходов
  разрывы по ~0,4 с.
- Вес +0,9–3 КБ gzip против +27…+935 КБ. Работает во всех webview из таблицы и без сети. CSP
  не трогаем, кроме одного хеша (ниже). Лицензий не добавляется.
- 3D у Cardbox — это ровно `perspective` + `preserve-3d`. Lottie и Rive в 3D слабее CSS.
- Если игровым сценам когда-нибудь понадобятся сложные цепочки, допустим `motion/mini`
  (3,2 КБ, тоже WAAPI). Сейчас он не нужен.

## Компонент: API

```ts
// web/src/ui/loader/FullscreenLoader.tsx
export type LoaderScene = 'cord' | 'cards' | 'chess' | ReactElement; // свой узел: только transform/opacity
export interface FullscreenLoaderProps {
  ready: boolean;                 // настоящее готово → уход за 200 мс, затем размонтирование
  label: string;                  // для экранного диктора, на экране не виден: «Открываем Cord», «Раздаём карты»
  scene?: LoaderScene;            // 'cord' по умолчанию
  sceneProps?: { deck?: 'poker' | 'durak' };
  tone?: 'theme' | 'dark';        // фон из токенов темы (старт) или всегда тёмный (вход в игру)
  showAfterMs?: number;           // 150: если готово раньше, сцены не было, был только фон
  reducedMotion?: 'static' | 'breathe'; // static (по умолчанию) — готовый кадр; breathe — только opacity тени
  slowAfterMs?: number;           // 12000: тихая строка «Сеть медленная» и «Повторить», без слова «загрузка»
  onRetry?: () => void;
  onExited?: () => void;
  brand?: boolean;                // марка под сценой (SVG-рисунок из T24, не текст), true
}
export function dismissBoot(): Promise<void>; // гасит статичный #cord-boot из index.html
```

Разметка одна: `.fl` (`position: fixed; inset: 0`, фон `--loader-bg`, `contain: strict`, отступы
по `--tg-safe-area-inset-*` + `--tg-content-safe-area-inset-*`) → `.fl__fade` (прозрачность) →
`.fl__stage` (`perspective`) → `.fl__scene` (`preserve-3d`) с тенью, ниже марка. Сцена помечена
`aria-hidden`, текст для диктора — в `.sr-only` внутри `role="status"`. Пока экран висит, у
`#root` стоят `aria-busy` и `inert`. Один источник для старта и для React: плагин Vite в
`transformIndexHtml` встраивает `loader.css` и разметку сцены, полученную через
`renderToStaticMarkup` того же JSX.

Когда «готово»:
- **Старт:** главный бандл выполнен, ответ на первый запрос экрана пришёл или упал, React
  закоммитил первый кадр (`useLayoutEffect` → `requestAnimationFrame`) → `dismissBoot()`.
- **Игра:** `import()` чанка разрешён и пришёл первый снимок стола. Не строить загрузку на
  fallback Suspense: в react-dom 19.2.8 `FALLBACK_THROTTLE_MS = 300`, то есть React может
  придержать показ содержимого до 300 мс после показа fallback.
- **Telegram:** `WebApp.ready()` вызывается сразу. Наш экран уже нарисован HTML-ом, поэтому
  заглушка Telegram сменяется им без шва. `setBackgroundColor`/`setHeaderColor`/
  `setBottomBarColor` получают тот же `--loader-bg`, полноэкранный режим — `requestFullscreen()`
  (Bot API 8.0).
- **Electron:** `new BrowserWindow({ backgroundColor: LOADER_BG, show: false })` +
  `ready-to-show`. Первый кадр страницы — это уже наш экран, так что окно не бывает пустым.
  **WebView2:** `WEBVIEW2_DEFAULT_BACKGROUND_COLOR=FF<hex>` до создания контрола.

Время: 0 мс — фон (первый кадр). 150 мс — сцена и марка проявляются за 240 мс (CSS `animation-delay`,
как у Grafana; предел «мгновенно» — 0,1 с по Nielsen). По `ready` экран сразу пропускает клики
(`pointer-events: none`) и гаснет: 200 мс, или 120 мс, если сцена ещё не проявилась. Прозрачность
убывает с текущего значения, поэтому мигания нет и минимальная длительность не нужна. Потом узел
**удаляется** из DOM, чтобы бесконечные анимации не крутились скрыто и не тратили батарею.
Если бандл упал (`vite:preloadError`, `error`) или прошло 12 с — тихий текст и «Повторить».

```ts
export async function dismissBoot() {
  const el = document.getElementById('cord-boot');
  if (!el) return;
  el.style.pointerEvents = 'none';
  document.getElementById('root')?.removeAttribute('inert');
  const shown = getComputedStyle(el.querySelector('.fl__fade')!).opacity !== '0';
  await el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: shown ? 200 : 120, easing: 'ease-in', fill: 'forwards' }).finished;
  el.remove();
}
```

## Без белой вспышки

1. `<html style="background:#0e1117">` (атрибут `style` разрешён `style-src 'unsafe-inline'`) и
   `<meta name="color-scheme" content="dark light">`. Во встроенном `<style>` — `--loader-bg`
   для обеих тем через `prefers-color-scheme`. Тема «как в системе» решается без JS.
2. Ручная тема (`cord:theme` = light/dark) — три строки встроенного скрипта в `<head>`. В CSP
   добавляется `'sha256-…'` этого скрипта, а тест vitest сверяет хеш из `index.html` со строкой
   в `infra/Caddyfile`. Внешний `/boot.js` отвергнут: блокирующий запрос в сеть на каждом старте.
3. `--loader-bg`: в тёмной теме — фон Cardbox-уровня (тёмно-синий из токенов E16), в светлой —
   светлый фон токенов. Иначе у человека со светлой темой будет **тёмная** вспышка на быстром
   старте. Вход в игру всегда `tone="dark"`.
4. Тот же цвет получают Electron, WebView2 и шапка Telegram.

## Сцены и правила движения

Правила: анимируются только `transform` и `opacity`. Нельзя анимировать `box-shadow`, `filter`,
`blur`, `stroke-dashoffset`, `top`/`left`/`width`, `background-position`. Тень — элемент с
`radial-gradient`, который масштабируется. Не больше 12 анимированных узлов, карта не больше
72×100 CSS px (при DPR 3 ≈ 250 КБ текстуры на штуку, ≈ 3 МБ на всё). `opacity`, `filter`,
`overflow`, `clip-path` и `mask` на элементе с `preserve-3d` сплющивают 3D (CSS Transforms 2,
grouping properties), поэтому прозрачность только у `.fl__fade`, у карт её нет. `var()` внутри
`@keyframes` проверить в WKWebView iOS 15–16. Запасной путь — литеральные кадры по классу (у марки
их три) или WAAPI-кадры из JS (у карт).

**Сцена Cord по умолчанию — «пульс марки».** Пластина знака (скруглённый квадрат цвета акцента)
висит в перспективе и медленно покачивается. Над ней на `translateZ(28px)` — три полосы знака,
они качаются со сдвигом фазы, как голос. Под всем дышит тень. Пять слоёв.

```css
.fl__fade{opacity:0;animation:fl-in 240ms ease-out 150ms forwards}
.fl__stage{perspective:800px;width:min(64vw,280px);aspect-ratio:4/3;position:relative}
.fl__scene{position:absolute;inset:0;transform-style:preserve-3d;animation:fl-sway 6s ease-in-out infinite alternate}
.fl__shadow{position:absolute;inset:auto 18% -4%;height:9%;border-radius:50%;
  background:radial-gradient(closest-side,rgb(0 0 0/.55),transparent);animation:fl-breathe 3s ease-in-out infinite alternate}
.fl-cord__plate{position:absolute;inset:22% 30%;border-radius:28%;background:var(--accent)}
.fl-cord__bar{position:absolute;bottom:34%;left:var(--x);width:8%;height:var(--h);border-radius:99px;background:#fff;
  transform:translateZ(28px);animation:fl-bob 1.2s cubic-bezier(.45,0,.55,1) infinite alternate;animation-delay:calc(var(--i)*-.4s)}
@keyframes fl-in{to{opacity:1}}
@keyframes fl-sway{from{transform:rotateX(14deg) rotateY(-24deg)}to{transform:rotateX(6deg) rotateY(24deg)}}
@keyframes fl-breathe{from{transform:scaleX(.86);opacity:.7}to{transform:scaleX(1);opacity:1}}
@keyframes fl-bob{from{transform:translateZ(28px) translateY(10%)}to{transform:translateZ(28px) translateY(-16%)}}
@media (prefers-reduced-motion:reduce){.fl__scene,.fl__scene *,.fl__shadow{animation:none!important}} /* проявление opacity остаётся */
```

**Сцена `cards` (покер и дурак, E08).** Семь карт с рубашкой Cord подбрасываются по очереди: со
стола (почти плашмя, `rotateX(78deg)`) вверх с полным оборотом, потом обратно. Фазы сдвинуты на
T/7, поэтому в воздухе всегда несколько карт, как у Cardbox. Лицо и рубашка — два слоя с
`backface-visibility: hidden`. Колода — `sceneProps.deck`: дурак берёт 6♠ 9♥ Q♣ K♦ A♠, покер —
A♠ J♠ Q♥ K♣ 10♦. Лицевую сторону E08 выносит из `DurakTable.tsx:760` (`Card`) в общий
`PlayingCard`. Неподвижная поза (без анимации) — веер, это и есть кадр для `reduced-motion`.

```css
.fl-card{position:absolute;left:50%;top:58%;width:var(--cw,64px);aspect-ratio:5/7;margin-left:calc(var(--cw,64px)/-2);
  transform-style:preserve-3d;will-change:transform;
  transform:translate3d(var(--fx),0,0) rotateZ(var(--fr));  /* веер: статичный кадр */
  animation:fl-fly var(--T,2.8s) cubic-bezier(.33,0,.67,1) infinite;animation-delay:calc(var(--i)*var(--T,2.8s)/-7)}
.fl-card__face,.fl-card__back{position:absolute;inset:0;border-radius:8%;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.fl-card__back{transform:rotateY(180deg);background:var(--card-back)} /* узор из знака Cord */
@keyframes fl-fly{
  0%  {transform:translate3d(var(--x0),0,0) rotateX(78deg) rotateY(0deg) rotateZ(var(--r0))}
  50% {transform:translate3d(var(--x1),var(--y1),90px) rotateX(12deg) rotateY(180deg) rotateZ(var(--r1))}
  100%{transform:translate3d(var(--x0),0,0) rotateX(78deg) rotateY(360deg) rotateZ(var(--r0))}}
```

У всех кадров один и тот же список функций, поэтому интерполяция идёт поэлементно, а
`rotateY(360deg)` совпадает с `0deg`: петля без скачка. **`chess`:** на плитке доски 3×3 (`rotateX(60deg)`)
конь и ферзь прыгают по дуге. Фигура — два SVG-силуэта крест-накрест, чтобы было объёмно и дёшево.

## Проверка (для «Готово» шага 4а)

- Перенести `/tmp/loader-bench/scripts/fps2.mjs` в `web/scripts/` и замерить на спокойной машине
  с GPU. Цель: ≥ 55 fps в покое и разрыв ≤ 50 мс при длинных задачах (CPU ×4/×6). На живом
  Android среднего класса — удалённая трассировка через `chrome://inspect`. Повторить WAAPI.
- Вес до и после: `index.html` +≤ 3 КБ gzip, JS-зависимостей +0, чанк `FullscreenLoader`
  ≤ 2 КБ gzip.
- Витрина: обе темы, `reduced-motion`, имитация Telegram с безопасными зонами, быстрый старт
  (< 150 мс — сцены нет) и медленный (12 с — «Повторить»). Axe. Кадры в `backlog/screens/E16/`.

## Запись для DECISIONS.md → «Решено агентом» (вносит сессия шага 4а)

> **Загрузка (П14, T55): CSS 3D + @keyframes внутри `index.html`, уход — нативный WAAPI, без
> зависимостей.** Только так сцена рисуется до JS и не замирает, пока разбирается бандл. Вес
> +0,9–3 КБ против +27…+935 КБ у GSAP, Lottie, Rive и Three. Офлайн и CSP не страдают, лицензий
> не прибавляется. Lottie и Rive слабее в 3D, у Rive платный экспорт, GSAP — не OSI. Замеры —
> `docs/superpowers/specs/2026-10-19-fullscreen-loader.md`.

## Источники

- Замеры веса: npm registry (`https://registry.npmjs.org/<пакет>/latest`), сборка rolldown из
  `web/node_modules`. Текущий бандл — `web/dist/index.html`. CSP — `infra/Caddyfile:25`.
- Motion, вес: https://motion.dev/docs/react-reduce-bundle-size. Аппаратное ускорение:
  https://motion.dev/docs/performance
- web.dev, компоновщик и слои: https://web.dev/articles/animations-overview
- GSAP: https://gsap.com/standard-license/ ; https://webflow.com/blog/gsap-becomes-free
- Rive, цены и MIT-рантайм: https://rive.app/blog/rive-s-new-9-mo-plan
- dotLottie, wasm ≈ 500 КБ: https://lottiefiles.com/blog/working-with-lottie-animations/hardware-accelerated-lottie-on-the-web-dotlottie-web-now-ships-webgl-webgpu ;
  https://github.com/LottieFiles/dotlottie-web
- Lottie и 3D: https://docs.lottiefiles.com/en/integrations/after-effects/09_lottie-compatibility
- Telegram Mini Apps (`ready`, цвета, safe area, fullscreen): https://core.telegram.org/bots/webapps
- Electron, «Showing the window gracefully»: https://www.electronjs.org/docs/latest/api/browser-window
- WebView2 `DefaultBackgroundColor`: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2
- CSS Transforms 2, grouping properties: https://www.w3.org/TR/css-transforms-2/#grouping-property-values
- Nielsen, пределы времени отклика: https://www.nngroup.com/articles/response-times-3-important-limits/
- Примеры: https://github.com/grafana/grafana/blob/main/public/views/index.html ;
  https://github.com/mattermost/mattermost/tree/master/webapp/channels/src/components/initial_loading_screen ;
  https://github.com/microsoft/vscode/blob/main/src/vs/code/electron-browser/workbench/workbench.ts ;
  https://github.com/tonkeeper/tonkeeper-web/blob/main/apps/twa/index.html ;
  https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/components/LoadingMessage.tsx ;
  https://github.com/smeijer/spin-delay
- React: `web/node_modules/react-dom/cjs/react-dom-client.development.js` — `FALLBACK_THROTTLE_MS = 300`.
