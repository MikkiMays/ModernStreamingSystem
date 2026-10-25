# Экраны Cord: карта продукта, описания, рецепты

Каждый экран и состояние Cord — что это, кто и откуда сюда попадает, правила, задачи владельца, компоненты набора,
исходники, как открыть и где он в Figma. Карта продукта E15-B (T57, T29) на 21.10.2026: снято со стенда
https://cord.nikg.tech (`main`), невыкаченное на стенд (E13, E14-B, E01-B2) — dev-сервером ветки с прокси к стенду.
Файл генерируется: `node web/scripts/screens-doc.mjs` из `web/scripts/screens-catalog.mjs` и узлов Figma —
правится каталог, а не этот файл.

> Cord — свой сервер для разговоров: встреча открывается по ссылке или девяти цифрам, без аккаунтов, а внутри — голос, видео, показ экрана, чат и файлы, общая музыка, кинозал и настольные игры за одним столом. Работает в браузере, в приложении для Windows, на телефоне и прямо в Telegram.

## Где что в Figma

План Starter даёт три страницы на файл (решение В-4: при нехватке — новые файлы в черновиках), поэтому карта —
четыре файла; «как есть», флоу и движение — в файле E15-A.

| Файл | Страницы |
| --- | --- |
| [Cord · карта 1 — обложка, дизайн-система, главная](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U) | [Обложка](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=0-1), [Дизайн-система](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=5-2), [Главная](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=5-3) |
| [Cord · карта 2 — встреча, интеграции, настройки](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G) | [Встреча](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=0-1), [Интеграции](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=1-2), [Настройки](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=1-3) |
| [Cord · карта 3 — скачать, клиент Windows, Telegram](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU) | [Скачать и установка](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=0-1), [Клиент Windows](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=1-2), [Telegram](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=1-3) |
| [Cord · карта 4 — телефон, аудит чёткости](https://www.figma.com/design/iCNC53lDOA6gJDSjsl7sh4) | [Телефон](https://www.figma.com/design/iCNC53lDOA6gJDSjsl7sh4/?node-id=0-1), [Аудит чёткости](https://www.figma.com/design/iCNC53lDOA6gJDSjsl7sh4/?node-id=1-2) |
| [Cord (как есть, E15-A)](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA) | Как есть · 2026-10-20, [Флоу](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=3-4), [Движение](https://www.figma.com/design/X7lD00UAOuZfH4hL0S4bxA/?node-id=3-5) |

- **Счёт:** 115 состояний в каталоге, 115 рядов и 516 кадров на страницах карты
  (Главная — 29/130; Встреча — 25/142; Интеграции — 16/94; Настройки — 15/82; Скачать и установка — 6/16; Клиент Windows — 11/22; Telegram — 7/18; Телефон — 6/12); 18 флоу с
  прототипом; 136 строк движения и 8 прототипов Smart Animate.
- **Кадр** — слои (SVG из живой страницы, `web/scripts/dom-svg.mjs`): текст — текстом Inter, цвета привязаны к
  переменным «Цвет · светлая/тёмная», значки — векторами. Ширины 360 / 1024 / 1440 (окна клиента — свои размеры), обе
  темы; оболочка Electron — только тёмная, как в продукте.
- **Ряд** — карточка описания слева и кадры; ссылка «ряд» ниже ведёт на него.
- **Снять заново:** из `web/` — `node --experimental-transform-types scripts/figma-screens.mjs --svg --toggle-theme
  [--only id,…]`; встреча — сценарии `meeting` и `meeting-b` (одна созданная встреча на сценарий: ядро считает
  10 новых встреч в час с адреса). Выгрузка — `figma-plan.mjs` → `figma-svg-upload.mjs` → `figma-layers.js` и
  `figma-place.js` (код для `use_figma`); карточки — `figma-cards.mjs`; аудит — `figma-audit.mjs`.

## Главная

Всё до встречи: загрузка, подключение к серверу, главная с избранным, знакомство и помощь (E13), языки (E14-B), страница владельца «Активность» (E10-B). [Страница в Figma](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=5-3).

### Загрузка и подключение · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56287)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Загрузка до бандла** `loader` | Статичная сцена из index.html, пока не пришёл код приложения. Без неё медленная сеть показывала бы белый экран. Любой, кто открывает Cord в браузере или клиенте; на быстрой сети мелькает на долю секунды. | Цвет фона — как у выбранной темы (читается до React). Уход — проявлением, под reduced motion — сразу. | T55 | — | web/index.html (#cord-boot), ui/loader/boot.ts, ui/loader/BootGate.tsx. Открыть Cord на медленной сети; для снимка бандл не отдаётся. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56288) |
| **Полноэкранная загрузка «Открываем Cord»** `loader-start` | Общая сцена загрузки (FullscreenLoader) — знак Cord и одна строка; та же, что в клиенте Windows. Показывается, пока приложение готовит первый экран; в продукте старт рисует index.html, сцена живёт в витрине. | Через 12 с без ответа — «Сеть медленная» и «Повторить». Сцена не мигает, если всё готово за 300 мс. | T55 | Logo, Button | ui/loader/FullscreenLoader.tsx, ui/loader/scenes.tsx, ui/loader/loader.css. /kit → «Показать старт». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56301) |
| **Загрузка — «Сеть медленная»** `loader-slow` | Та же сцена загрузки, когда ответа нет дольше обычного: честно говорим, что ждём, и даём повторить. Человек на плохой сети или при недоступном сервере. | Порог — 12 с (в витрине 1,5 с). «Повторить» перезапускает загрузку, а не всё приложение. | T55 | Button | ui/loader/FullscreenLoader.tsx. /kit → «Показать старт», ждать. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56314) |
| **Подключение — ищем сервер** `connect-searching` | Экран связи с сервером Cord: запрос возможностей сервера ещё не ответил. Первый запуск или сервер не отвечает на /api/v1/capabilities. | Без ошибок и красного, пока идёт первая попытка; дальше — экран ошибки. | T05 | Logo | ui/Connect.tsx, core/session.ts. Сервер не отвечает на /api/v1/capabilities. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56327) |
| **Подключение — вручную** `connect-manual` | Выключено «Подключаться автоматически при запуске» — Cord ждёт нажатия «Подключиться». Тот, кто сам выключил автоподключение в «Сервере». | Адрес сервера руками здесь не вводится (T05) — только текущий сервер. | T05 | Button | ui/Connect.tsx, core/servers.ts. Выключить автоподключение и открыть Cord заново. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56340) |
| **Подключение — нужен пароль сервера** `connect-password` | Сервер закрыт паролем: поле пароля и «Подключиться». Гости частного сервера (capabilities.passwordRequired). | Пароль держит страница; повторно не спрашивается, пока он верен. 10 неверных попыток в час — отказ (E11-B). | T37 | Field, Input, Button | ui/Connect.tsx. Сервер с паролем. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56353) |
| **Подключение — пароль не подошёл** `connect-wrong-password` | Отказ ядра SERVER_PASSWORD_INVALID: раскрытое «Не подключено» с причиной. Ввёл неверный пароль сервера. | Текст причины — из каталога ошибок (describeFailure), без кодов. | T37 | Field, Button | ui/Connect.tsx, core/session.ts. Ввести неверный пароль → «Подключиться». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56366) |
| **Подключение — сервер не отвечает** `connect-failed` | Сервер ответил ошибкой: «Не подключено» и подробности под раскрытием. Сервер лежит или за прокси 5xx. | Подробности свёрнуты: человеку — что делать, технику — что случилось. | T50 | Button | ui/Connect.tsx, core/session.ts. Сервер отвечает 5xx; раскрыть «Не подключено». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56379) |

### Главная и избранное · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56392)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Главная — пусто** `home` | Вход во встречу: код или ссылка, «Новая встреча»; слева — избранное (пока пустое), настройки и «Скачать Cord». Каждый, кто открыл адрес сервера; первый вход. | Одно главное действие — «Новая встреча». Код — 9 цифр, ссылку можно вставить целиком. Лого — рисунок, не текст (T24). | T24, T40, T47 | Button, Input, Card, Logo | ui/home/HomeShell.tsx, ui/HomeEntry.tsx, ui/home/FavoritesNav.tsx, ui/InstallHint.tsx. Первый вход в браузере. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56393) |
| **Главная — избранное 10 из 10** `home-favorites` | Список сохранённых комнат: закреплённые, группы, без группы; у закрытых — пометка. Тот, кто сохранял встречи звездой в шапке. | Не больше 10 комнат (T06); группы создаются кнопкой «Группа» (T40); ширина панели тянется и запоминается (T46). | T06, T40, T46 | Menu, Badge | ui/home/FavoritesNav.tsx, ui/home/RoomRow.tsx, ui/useFavoriteShelf.ts. Сохранить 10 комнат звездой в шапке встречи. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56406) |
| **Главная — меню под бургером** `home-drawer` | На узком экране избранное и настройки уходят в выдвижное меню. Телефон и окна уже 960 px. | Бургер слева, точка Cord ровно по центру строки (T01). | T01 | IconButton | ui/home/HomeShell.tsx, ui/home/home.css. Ширина < 960 → «Открыть меню». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56415) |
| **Главная — меню комнаты** `home-room-menu` | Действия с комнатой в избранном: закрепить, переименовать у себя, в группу, убрать. ПКМ по комнате, «…» или долгое касание. | Меню — компонент набора, а не браузерное (T42). | T40, T42 | Menu | ui/home/RoomRow.tsx, ui/kit/Menu.tsx. ПКМ по комнате в избранном. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56420) |
| **«Убрать из избранного?»** `home-remove-confirm` | Подтверждение перед тем, как комната пропадёт из списка. Меню комнаты → «Убрать из избранного». | Саму встречу это не закрывает; кнопка «Убрать» — опасная. | T40 | Dialog, Button | ui/home/FavoritesNav.tsx. Меню комнаты → «Убрать из избранного». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56429) |
| **Главная — встреча в соседней вкладке** `home-active-elsewhere` | Плашка «Вы во встрече в другой вкладке» с «Вернуться». У зрителя активна одна встреча (T52): встреча открыта в другой вкладке этого браузера. | «Вернуться» переводит фокус в ту вкладку, а не открывает вторую копию. | T52 | Card, Button | ui/home/ActiveMeetingNotice.tsx, core/active-meeting.ts. Встреча открыта в другой вкладке, открыть главную. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56442) |
| **Главная — избранное не загрузилось** `home-favorites-error` | Ошибка запроса /favorites — место списка занимает понятное сообщение. Сервер ответил ошибкой. | Главная остаётся рабочей: войти и создать встречу можно. | — | Card | ui/home/FavoritesNav.tsx. Сервер отвечает ошибкой на /favorites. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56455) |
| **Ссылка на встречу без входа** `room-not-found` | /room/<id> в вкладке без сохранённого входа: баннер «Сессия не найдена». Открыл ссылку адресной строки, а не приглашение. | Найдено в E15-A: баннер стирается рукопожатием подключения (App.tsx) — человек видит главную без объяснения. | — | — | App.tsx (recent, .global-error). /room/<id> в вкладке без входа. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56464) |
| **«Вы уже во встрече» (409)** `dialog-409` | Тот же профиль уже держит другую встречу: выйти оттуда и войти сюда или остаться. Вход во вторую встречу из другого окна (T52). | Три исхода: «Выйти оттуда и войти сюда», «Вернуться туда», «Отмена». | T52 | Dialog, Button | ui/MeetingElsewhere.tsx, core/identity.ts. Быть во встрече в одном окне и войти во вторую из другого. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56477) |

### Знакомство и помощь · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-265)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Знакомство — «Новая встреча»** `tour-create` | Первый шаг знакомства: подсказка у главной кнопки. Первый вход на этом устройстве (E13, T34). | 3–5 шагов у настоящих кнопок; «Пропустить» в любой момент; пройденное не повторяется, пока человек сам не нажмёт «Пройти знакомство» в «О программе». | T34 | Coachmark, Button | ui/onboarding/Onboarding.tsx, ui/kit/Coachmark.tsx, core/onboarding.ts. Открыть Cord в новом профиле браузера. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-266) |
| **Знакомство — вход по коду** `tour-join` | Второй шаг: куда вставить код или ссылку-приглашение. «Далее» на первом шаге. | Подсказка над полем кода, чтобы не закрыть «Новую встречу». | T34 | Coachmark | ui/onboarding/Onboarding.tsx. Знакомство → «Далее». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-275) |
| **Знакомство — избранное** `tour-favorites` | Третий шаг на компьютере: где соберутся встречи со звёздочкой. «Далее»; только на широком экране. | Подсказка справа от левой панели, над пустым полем. | T34, T40 | Coachmark | ui/onboarding/Onboarding.tsx. Знакомство → «Далее» ×2. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-284) |
| **Знакомство — настройки** `tour-settings` | Четвёртый шаг: камера, звук, тема, язык; знакомство можно пройти снова. «Далее»; только на широком экране. | Окно поверх главной ставит знакомство на паузу. | T34 | Coachmark | ui/onboarding/Onboarding.tsx. Знакомство → «Далее» ×3. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-289) |
| **Знакомство — помощь** `tour-help` | Последний шаг на компьютере: ответы на частые вопросы и связь — кнопка «Помощь». «Далее»; только на широком экране. | «Готово» закрывает знакомство насовсем. | T34, T36 | Coachmark | ui/onboarding/Onboarding.tsx, ui/support/HelpButton.tsx. Знакомство → «Далее» ×4. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-294) |
| **Знакомство — меню (телефон)** `tour-menu` | На телефоне избранное, настройки и помощь спрятаны в меню — шаг один, у бургера. Знакомство на узком экране. | Три шага вместо пяти. | T34 | Coachmark | ui/onboarding/Onboarding.tsx. Знакомство на телефоне → «Далее» ×2. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-299) |
| **Поддержка — вкладки** `help-center` | Одно окно «Поддержка» (R37) с вкладками «Частые вопросы · Проверить · Написать»: ответы по темам, проверка камеры и микрофона, обращение. Гарнитура «Поддержка» в панели главной, в шапке встречи и в меню; раздел «Поддержка» в настройках. | Ответы — языком продукта, без ссылок наружу (T54); разговор окно не прерывает. | T36, T54, R37 | Dialog, Tabs, Button | ui/support/HelpHost.tsx (одно окно на корне, S5), ui/support/HelpButton.tsx, ui/support/HelpCenter.tsx. Главная → «Поддержка». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-304) |
| **«Сообщить о проблеме»** `help-report` | Во вкладке «Написать» — второй вид обращения: что не так — чипами («Звук обрывается», «Показ лагает», «Не слышно музыку», «Не подключается», «Другое»), подробности по желанию и отчёт о звонке. «Поддержка» → «Написать» → «Сообщить о проблеме»; из «Диагностики» во встрече — сразу этот вид. | Во встрече к обращению прикладывается итог звонка (путь, потери, задержка — только числа), переключатель включён и под ним видно, что уйдёт; вне встречи — только окружение. | R79 | Segmented, Switch, Field, Button | ui/support/ReportForm.tsx, ui/support/Chips.tsx, core/support.ts. Встреча → «Диагностика» → «Сообщить о проблеме». | — |
| **/support — написать нам** `support-page` | Страница обращения: тема, что случилось, контакт по желанию; отправка владельцу в Telegram и на «Активность». Помощь → «Написать нам» или прямой адрес /support. | Контакт необязателен; диагностика прикладывается по согласию. | T36 | Field, Select, Textarea, Button | ui/support/SupportPage.tsx, ui/support/SupportForm.tsx. Открыть /support. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-313) |

### Языки · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-322)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Главная по-английски** `home-en` | Интерфейс целиком на английском (E14-B): один из восьми языков. «Оформление» → «Язык интерфейса» или язык браузера. | Применяется сразу, без перезагрузки; полноту переводов проверяет CI. | T03 | весь набор | i18n/locales/en.json, i18n/index.ts, i18n/languages.ts. Выбрать English в «Оформлении». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-323) |
| **Главная по-китайски** `home-zh` | Китайский (упрощённый) — самый плотный по ширине текст; проверка вёрстки на иероглифах. «Язык интерфейса» → 中文（简体）. | Шрифт — системный CJK рядом с Inter. | T03 | весь набор | i18n/locales/zh-Hans.json. Выбрать 中文 в «Оформлении». | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-332) |

### Активность сервера (владелец) · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-341)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **«Активность» — вход владельца** `activity-login` | Страница владельца сервера: встречи сейчас, журнал, блокировки, обращения; сначала — пароль. Владелец сервера по адресу /activity (ADMIN_PASSWORD). | Без пароля в настройках сервера страница выключена и говорит, что сделать. | T32 | Field, Button | ui/activity/Activity.tsx. Открыть /activity. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=19-342) |

### Витрина набора · [раздел](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56490)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Витрина набора /kit** `kit` | Все примитивы набора E16 в обеих темах рядом — для сверки с Figma. Команда; ссылки из продукта нет. | Ширина 360 шире окна на 127 px — витрина, не продукт. | T47 | весь набор | ui/kit/Showcase.tsx, ui/kit/*. /kit. | [ряд](https://www.figma.com/design/tC9u0tOLZ28FwcB8PT5v6U/?node-id=17-56491) |

## Встреча

Прихожая и сама встреча: сцена, пульт, панели, окна, предупреждения, обрывы и конец. [Страница в Figma](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=0-1).

### Прихожая · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-93)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Прихожая — новая встреча** `prejoin-create` | Перед стартом: предпросмотр камеры, имя, название, кто может войти, интеграции для всех. Главная → «Новая встреча». | Подключиться можно и без устройств. Задача доказательства (PoW, E11-B) решается в фоне, пока открыта форма. | T31, T37 | Field, Input, Button, IconButton, Card | ui/Prejoin.tsx, core/proof.ts. Главная → «Новая встреча». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-94) |
| **Прихожая — вход по коду или ссылке** `prejoin-join` | Та же прихожая для гостя: имя и «Войти во встречу». 9 цифр на главной или /join/<код>. | Промахи кодом считаются на адрес (E11-B): после лимита — отказ даже с верным кодом. | T37 | Field, Button | ui/Prejoin.tsx, core/invitation.ts. Ввести код на главной или открыть /join/<код>. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-107) |
| **«Перед разговором» — устройства** `prejoin-settings` | Окно выбора камеры, микрофона, динамика с проверкой уровня. Прихожая → «Настройки предпросмотра». | Список устройств обновляется на лету; стрелка выбора у камеры убрана (T21). | T21, T31 | Dialog, Select, Slider | ui/Prejoin.tsx, ui/DeviceCheck.tsx. Прихожая → «Включить камеру» → «Настройки предпросмотра». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-120) |
| **Прихожая — устройства запрещены** `prejoin-denied` | Браузер запретил камеру и микрофон: объясняем, где разрешить. Запрет в браузере. | Войти можно и так — слушать и смотреть. | — | Card, Button | ui/Prejoin.tsx. Запретить устройства → «Включить камеру». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-133) |
| **Ожидание допуска** `meeting-waiting` | «Организатор скоро впустит вас» — гость ждёт у двери. Встреча «Только с вашего подтверждения» или «щит» сервера при подборе кода (E11-B). | Ждущий не занимает место во встрече и не видит её. | T37 | Card | ui/MeetingView.tsx, ui/MeetingHeader.tsx. Встреча с подтверждением → гость входит по коду. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-146) |

### Сцена · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-159)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Встреча — один** `meeting-solo` | Только что созданная встреча: своя плитка, шапка с кодом и временем, пульт снизу. Создатель после «Начать встречу». | Пульт — три группы (T22); «В эфире» в шапке нет (T25); время встречи рядом с кодом (T35). | T22, T25, T35 | IconButton, Button, Badge | ui/MeetingView.tsx, ui/Stage.tsx, ui/CallDock.tsx, ui/MeetingHeader.tsx. «Начать встречу». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-160) |
| **Сетка, четверо** `meeting-grid` | Плитки участников сеткой; говорящий — зелёная рамка по громкости. Во встрече больше одного человека. | Рамка говорящего — четыре ступени громкости, отклик ≤ 100 мс (T23); до 20 участников (T06). | T06, T23 | — | ui/Stage.tsx, ui/grid.ts, ui/stage.css. Пригласить троих. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-173) |
| **Раскладка «Говорящий»** `meeting-speaker` | Крупно — тот, кто говорит; остальные — лентой. «Расположение участников» → «Говорящий» (телефон — в «ещё»). | Смена говорящего не дёргает раскладку чаще раза в секунду. | — | Menu | ui/LayoutMenu.tsx, ui/Stage.tsx. «Расположение участников» → «Говорящий». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-186) |
| **Показ экрана — «Смотреть стрим»** `meeting-screen-tile` | Участник показывает экран; у остальных на плитке — кнопка «Смотреть стрим». Любой участник нажал «Показать экран». | Поток не грузится, пока его не попросили смотреть: сначала качество, потом картинка (T48). | T10, T44, T48 | Button | ui/Stage.tsx, media/session.ts. Участник жмёт «Показать экран». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-199) |
| **Показ экрана на сцене** `meeting-screen` | Экран участника крупно, камеры — лентой. Зритель нажал «Смотреть стрим». | До 1080p60 (T44); в клиенте Windows источник выбирается своим окном (T10). | T10, T44 | IconButton | ui/Stage.tsx, ui/stage.css. Зритель жмёт «Смотреть стрим». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-212) |

### Панели и меню · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-225)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Панель «Чат и файлы»** `meeting-chat` | Сообщения и файлы встречи; хранятся, пока встреча идёт. «Чат» в пульте (телефон — «ещё» → «Чат и файлы»). | Кнопка «Отправить» на уровне строки ввода (T02); 20 сообщений в минуту, повтор — раз в 30 с (E11-B). | T02, T37 | Tabs, IconButton | ui/Sidebar.tsx, ui/chat.ts, ui/meeting-panel.css. «Чат» в пульте. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-226) |
| **Панель «Участники»** `meeting-people` | Кто во встрече, у кого выключен микрофон, кто ждёт допуска. «Участники» в пульте. | Действия с участником — меню по строке. | — | Tabs, Input, Menu | ui/Sidebar.tsx. «Участники». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-239) |
| **Меню участника** `meeting-participant-menu` | Громкость у себя, закрепить, выключить микрофон (создатель), удалить из встречи. ПКМ по плитке; телефон — «Участники» → «Действия: <имя>». | Громкость меняется только у себя. | T42 | Menu, Slider | ui/ParticipantMenu.tsx. ПКМ по плитке. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-252) |
| **Меню «Настройки и действия»** `meeting-more` | «…» в центре пульта: настройки, раскладка, диагностика, завершить для всех; на телефоне — ещё панели и «Свернуть в окно». Любой участник. | «Завершить для всех» — только создателю и опасным цветом. | T16, T22 | Menu | ui/CallDock.tsx. «…» в центре пульта. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-265) |
| **«Пригласить во встречу»** `meeting-invite` | Код, ссылка, QR — чтобы позвать людей. Код в шапке или «Пригласить участников». | Ссылки на гит нет (T56); одна ссылка бота на комнату (E11-B). | T56 | Dialog, Button, Input | ui/Invite.tsx. Код в шапке. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-278) |
| **«Диагностика»** `meeting-diagnostics` | Путь до медиасервера, задержка, что уходит в сеть с камеры и экрана. «ещё» → «Диагностика». | Слова человека («хороший», «ограничивает канал»), цифры — рядом. | T09, T50 | Dialog, Badge | ui/Diagnostics.tsx, ui/DeviceCheck.tsx. «ещё» → «Диагностика». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-291) |
| **«Настройки встречи» (создатель)** `meeting-room-settings` | Название, кто может войти, кто управляет интеграциями. Создатель: «ещё» → «Настройки встречи» или карандаш у названия. | Изменения видят все сразу; убирать музыку может каждый, если включено (T14). | T14 | Dialog, Switch, Field | ui/MeetingSettings.tsx. «ещё» → «Настройки встречи». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-304) |

### Предупреждения, обрывы, конец · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-313)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **«Встреча завершится в …»** `meeting-ceiling` | Плашка в шапке за 15 минут до потолка длительности встречи (24 ч). Все участники долгой встречи; ядро присылает endsAt (A2 модели угроз). | Время — по часам устройства с поправкой на часы сервера. Кадра нет: endsAt приходит от ядра только за 15 минут до 24-часового потолка, подставить его в снимок встречи не удалось. | T37 | — | ui/abuse/Notices.tsx (MeetingEnds), ui/abuse/notices.css. Встреча за 15 мин до stream.meeting.max-duration; для снимка endsAt вписан в ответ. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-314) |
| **Чат — файл может запустить программу** `chat-executable` | Предупреждение у вложения, которое ядро пометило executable. Кто-то прислал .exe, .bat и подобное (stream.chat.executable-attachments: warn). | Файл не прячется — человек решает сам; при block ядро не принимает его вовсе. | T37 | — | ui/abuse/Notices.tsx (ExecutableNote), ui/Sidebar.tsx. Отправить в чат файл .exe. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-315) |
| **Чат — «Переход по ссылке»** `chat-link-dialog` | Окно перед переходом: показывает настоящий домен (IDN — как xn--) и спрашивает «Открыть?». Нажал ссылку в сообщении. | Домен — крупно; «Отмена» — по умолчанию. | T37 | Dialog, Button | ui/abuse/ChatText.tsx. Отправить ссылку в чат и нажать её. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-328) |
| **Избранное заполнено — звезда** `dialog-favorites-full` | Звезда в шапке на пределе 10 комнат недоступна. У человека уже 10 комнат в избранном. | Найдено в E15-A: подсказка — атрибут title, на касании её нет (T29). | T06, T29 | IconButton | ui/MeetingHeader.tsx. 10 комнат в избранном → новая встреча. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-341) |
| **Избранное заполнено — отказ ядра** `dialog-favorites-refused` | Список устарел, звезда нажата — ядро отвечает FAVORITES_FULL, текст у шапки. Две вкладки добавили комнаты одновременно. | Текст — из каталога ошибок. | T06 | — | ui/MeetingHeader.tsx, server/…/room/FavoriteService.java. 9 из 10 в списке, а в ядре уже 10. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-354) |
| **Обрыв управления** `meeting-control-lost` | Пропал канал событий: встреча на экране, но действия ждут связи. Сеть моргнула, прокси оборвал /api/v1/events. | Медиа продолжает идти; переподключение само, без перезагрузки (T50). | T50 | Badge | ui/MeetingView.tsx, core/meeting.ts. Оборвать /api/v1/events. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-367) |
| **Обрыв медиа, обратный отсчёт** `meeting-recovering` | «Связь восстанавливается…» с отсчётом до следующей попытки. Пропал медиаканал /rtc. | Найдено в E15-A: на 360 статус наезжает на звезду и ссылку (T29). | T50, T29 | — | ui/MeetingView.tsx, ui/MeetingHeader.tsx. Оборвать /rtc. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-380) |
| **Встреча завершена** `meeting-ended` | Финальный экран: встреча закрыта создателем или по потолку. Все участники после «Завершить для всех». | Чат и файлы больше недоступны; вернуться на главную — одной кнопкой. | — | Button | ui/MeetingView.tsx. «ещё» → «Завершить для всех». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=6-393) |

## Интеграции

Что можно делать вместе: музыка (плеер с площадками вкладками, R44), кинозал (выбор площадки, T59) и игры. Всё живёт в панели «Интеграции» и на сцене. [Страница в Figma](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=1-2).

### Панель и выбор площадки · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-155)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Панель «Интеграции»** `meeting-integrations` | Группы: Кинозал, Музыка, Игры, Telegram (внизу, T30), «Скоро» для будущих. «Интеграции» в пульте. | Управлять может создатель или все — по настройке встречи. | T08, T12, T13, T30 | Card, Badge | ui/Services.tsx, ui/ServiceRoster.tsx. «Интеграции». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-156) |
| **Кинозал — выбор площадки** `cinema-picker` | Тот же экран выбора для кинозала; плитка открывает каталог на сцене. «Интеграции» → «Кинозал». | Недоступная площадка серая с причиной; «Сейчас смотрим: … / Закрыть для всех». | T59, T17 | Card, Button | ui/PlatformPicker.tsx, ui/cinema/CinemaGroup.tsx. «Интеграции» → «Кинозал». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-182) |

### Музыка · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-195)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Музыка — ещё не во встрече** `music-intro` | Одно действие: «Добавить во встречу» — какие площадки есть, что очередь одна на всю встречу и что музыка займёт одно место. «Интеграции» → «Музыка» или виджет над звонком (R31), пока музыки во встрече нет. | Экрана выбора площадки нет (R44): после «Добавить» сразу плеер на последней площадке; очередь, собранная раньше, сохраняется и показана числом. | T18, R44, R31 | Button | ui/music/MusicWidget.tsx, ui/music/useMusic.ts. «Интеграции» → «Музыка» во встрече без музыки. | — |
| **Музыка — плеер (YouTube)** `music-youtube` | Плеер целиком: площадки вкладками, поле этой площадки, «Сейчас играет», «Далее в очереди», «Убрать музыку из встречи». «Интеграции» → «Музыка» или виджет над звонком, когда музыка во встрече; вкладка YouTube. | Поиск и ссылка — только своей площадки; вкладка помнит выбор, а её смена не трогает плеер, очередь и бота. | T18, T59, T14, R44 | Tabs, Input, Button | ui/music/MusicWidget.tsx, ui/PlatformPicker.tsx (PlatformTabs), ui/MusicPlayer.tsx, ui/integrations.css. «Музыка» → «Добавить во встречу» → вкладка YouTube. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-196) |
| **Музыка — свои файлы** `music-files` | Вместо поля — «Перетащите аудиофайлы сюда…» и «Загрузить файлы». Вкладка «Свои файлы». | До 50 МиБ и 60 минут на трек. | T18 | Button | ui/MusicUpload.tsx. Вкладка «Свои файлы». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-209) |
| **Музыка — Яндекс Музыка** `music-yandex` | Строка аккаунта комнаты над полем; поле появляется, когда аккаунт подключён. Вкладка «Яндекс Музыка». | Аккаунт подключается в «Настройки» → «Аккаунты» (T33). | T18, T33 | Button | ui/YandexIntegration.tsx. Вкладка «Яндекс Музыка». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-222) |

### Кинозал · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-235)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Кинозал — каталог** `cinema-catalog` | Каталог площадки на сцене с поиском. Выбор площадки → YouTube. | Ролики идут через прокси встречи, ссылки живут час (E11-B). | T17, T19, T20 | Input | ui/cinema/CinemaGroup.tsx, ui/cinema/catalog/*. Кинозал → YouTube → поиск. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-236) |
| **Кинозал — карточка ролика** `cinema-detail` | Описание, длительность и «Смотреть вместе». «Подробнее: <название>». | Листать стрелками, пауза — пробелом (T20). | T20 | Button | ui/cinema/catalog/*. «Подробнее». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-249) |
| **Кинозал — плеер у всех** `cinema-player` | Плеер «Смотреть вместе» — синхронно у всех участников. «Смотреть вместе». | Курсор и лента плеера прячутся при просмотре (T19). | T19, T20 | IconButton, Slider | ui/cinema/theater/*, ui/cinema/theater.css. «Смотреть вместе». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-262) |

### Игры · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-275)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Группа «Игры»** `games-panel` | Покер, дурак, шахматы, Gartic; «Любая игра» — скоро. «Интеграции» → «Игры». | Стол открывает тот, кому разрешены интеграции. | T08, T45 | Card, Badge | ui/GamesGroup.tsx. «Интеграции» → «Игры». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-276) |
| **Загрузка игры «Раздаём карты»** `loader-cards` | Сцена загрузки стола: карты раздаются, пока готовится игра. Открытие карточного стола. | Сцена занимает только место стола, а не весь экран (T55). | T55 | — | ui/loader/FullscreenLoader.tsx, ui/loader/scenes.tsx. /kit → «Показать карты». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-289) |
| **Покер — раздача** `game-poker` | Стол с местами, фишками, общими картами и ставками. «Покер» → «Открыть стол» → «Сесть» → «Раздать». | При наведении на чужую камеру она крупнее (T11); звуки и анимации раздачи (T45). | T11, T45 | Button, Slider | ui/PokerTable.tsx, poker.css. «Покер» → «Открыть стол». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-302) |
| **Дурак — раздача** `game-durak` | Стол дурака: руки, колода и козырь, стол боя. «Дурак» → «Открыть стол». | Видно, сколько карт у каждого и где колода (T07); подкидывать нельзя, когда у защиты нет карт (T51). | T07, T45, T51 | Button | ui/DurakTable.tsx, ui/DurakMotion.tsx, durak.css. «Дурак» → «Открыть стол». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-315) |
| **Шахматы — партия** `game-chess` | Доска, часы, ходы. «Шахматы» → «Открыть доску» → цвет → «Начать партию». | Доска поворачивается к игроку чёрных. | T45 | Button | ui/ChessTable.tsx, chess.css. «Шахматы» → «Открыть доску». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-328) |
| **Gartic — первый ход** `game-gartic` | Один рисует, остальные угадывают. «Gartic» → «Открыть» → «Присоединиться» → «Начать игру». | Догадки — в поле «Что нарисовано?». | T13, T45 | Input | ui/GarticTable.tsx, ui/GarticCanvas.tsx, gartic.css. «Gartic» → «Начать игру». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-341) |
| **«История игр»** `games-history` | Итоги прошлых партий во встрече. Группа «Игры» → «История игр». | Живёт, пока идёт встреча. | — | Dialog | ui/GamesGroup.tsx, ui/PokerResult.tsx. Группа «Игры» → «История игр». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=8-354) |

## Настройки

Одно окно настроек: восемь разделов слева (на телефоне — список), поиск, то же окно поверх встречи. [Страница в Figma](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=1-3).

### Разделы · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-142)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Настройки — список (телефон)** `settings-list` | На телефоне разделы — списком, раздел открывается на весь экран. Телефон: меню → «Настройки». | Окно одного размера для всех разделов (T26). | T26 | — | ui/settings/SettingsWindow.tsx, ui/settings/sections.ts. Телефон: меню → «Настройки». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-143) |
| **Профиль** `settings-01` | Имя, картинка в кружке. «Настройки» → «Профиль». | Имя без невидимых символов (E11-B). | T26, T29 | Field, Button | ui/settings/ProfileSection.tsx. «Настройки» → «Профиль». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-148) |
| **Оформление** `settings-02` | Тема (светлая, тёмная, как в системе), язык интерфейса, плотность. «Настройки» → «Оформление». | Тема — здесь, а не в шапке (T41); язык — «Как в браузере» и восемь языков (E14-A). | T41, T03 | Tabs, Select | ui/settings/AppearanceSection.tsx. «Настройки» → «Оформление». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-161) |
| **Оформление — English** `settings-language` | Выбран английский: строка «Язык интерфейса» и её подпись переведены, остальное — по-русски до E14-B. «Оформление» → «Язык интерфейса». | Применяется сразу, без перезагрузки; русский не мигает при старте. | T03 | Select | ui/settings/AppearanceSection.tsx, i18n/languages.ts, i18n/index.ts. «Оформление» → «Язык интерфейса» → English. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-174) |
| **Горячие клавиши** `settings-03` | Сочетания для микрофона, камеры, показа; в клиенте Windows — глобальные. «Настройки» → «Горячие клавиши». | Конфликт сочетаний показывается сразу (T27). | T27 | Button, Badge | ui/settings/HotkeysSection.tsx. «Настройки» → «Горячие клавиши». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-175) |
| **Голос и видео** `settings-04` | Устройства, проверка, шумоподавление, качество. «Настройки» → «Голос и видео». | Стиль как у FACEIT (T31); качество не выше 1080p60 (T44). | T31, T44 | Select, Slider, Switch | ui/settings/VoiceSection.tsx, ui/DeviceCheck.tsx. «Настройки» → «Голос и видео». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-188) |
| **Голос и видео — конец** `settings-04b` | Нижняя часть раздела: показ экрана и потолок качества сервера. Прокрутить «Голос и видео». | Подсказка потолка — из настроек сервера. | T44 | Select | ui/settings/VoiceSection.tsx, ui/settings/media-fields.tsx. Прокрутить раздел. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-201) |
| **Звуки** `settings-05` | Звуки входа, выхода, сообщений; громкость. «Настройки» → «Звуки». | Звуки входа не играют на фоне без причины (T38). | T38 | Switch, Slider | ui/settings/SoundsSection.tsx. «Настройки» → «Звуки». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-214) |
| **Звуки — конец** `settings-05b` | Нижняя часть раздела «Звуки». Прокрутить «Звуки». | — | T38 | Switch | ui/settings/SoundsSection.tsx. Прокрутить раздел. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-227) |
| **Аккаунты** `settings-06` | Подключённые аккаунты: Яндекс Музыка. «Настройки» → «Аккаунты». | «Подключить» / «Подключено» (T33). | T33 | Card, Button | ui/settings/AccountsSection.tsx, ui/YandexIntegration.tsx. «Настройки» → «Аккаунты». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-236) |
| **Сервер** `settings-07` | Текущий сервер, автоподключение, пинг. «Настройки» → «Сервер». | Ручного добавления серверов нет (T05); выбор — в клиенте окном «Серверы». | T05 | Switch, Button | ui/settings/ServerSection.tsx. «Настройки» → «Сервер». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-249) |
| **О программе** `settings-08` | Версия, лицензии, без ссылок наружу. «Настройки» → «О программе» или внизу главной. | Ссылки на гит нет (T56). | T56 | Card | ui/settings/AboutSection.tsx. «Настройки» → «О программе». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-262) |
| **Поиск по настройкам** `settings-search` | Строки всех разделов по слову. «Найти настройку». | Находит и по-английски («language»). | T26 | Input | ui/settings/sections.ts. «Найти настройку» → «звук». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-275) |

### Поверх встречи и окна · [раздел](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-288)

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Настройки поверх встречи** `meeting-settings` | То же окно настроек, не выходя из встречи. Встреча: «ещё» → «Настройки». | Встреча за окном продолжается. | T26 | Dialog | ui/settings/SettingsWindow.tsx, ui/CallDock.tsx. «ещё» → «Настройки». | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-289) |
| **«Что будет в кружке»** `avatar-cropper` | Обрезка картинки профиля под круг. «Профиль» → выбрать картинку. | Предпросмотр — как увидят другие. | — | Dialog, Slider, Button | ui/AvatarCropper.tsx. «Профиль» → картинка. | [ряд](https://www.figma.com/design/0twoxdjTpxbDluBJfVxK6G/?node-id=3-302) |

## Скачать и установка

Как Cord попадает на компьютер: страница «Скачать», и при каждом запуске — плашка проверки обновления (В-1, T58). [Страница в Figma](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=0-1).

### Скачать

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Скачать Cord** `download` | Страница клиента Windows: кнопка, размер, что скажет SmartScreen и как пройти, куда подключаться. /download или «Скачать Cord» в панели. | Описание без ссылок наружу (T54); адрес сервера — копируется кнопкой. | T15, T43, T54 | Button, Card | ui/Download.tsx, core/download.ts. /download. | — |
| **Скачать Cord — сборки нет** `download-unavailable` | Манифеста сборки нет — честно говорим, что скачать пока нечего. Сервер без выкладки клиента. | Без битой кнопки. | T43 | Card | ui/Download.tsx. Нет downloads/windows/download.json. | — |

### Плашка обновления при запуске

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Плашка — проверка обновления** `electron-splash-checking` | Маленькое окно 300×360 при каждом запуске: знак Cord и «Проверяем обновления…». Каждый запуск клиента (В-1: как в Discord). | Проверка не дольше 5 с; новее нет — сразу приложение. | T58 | — | desktop/src/shell/splash.html, splash.js, main/windows/splash.ts, update/splash-flow.ts. Запустить Cord. | — |
| **Плашка — загрузка обновления** `electron-splash-downloading` | «Загружаем обновление… 42%» и полоса прогресса. На сервере есть версия новее. | Скачивается с самого сервера Cord; подпись Ed25519 и sha256 сверяются до установки. | T58 | — | desktop/src/shell/splash.js, update/updater.ts, update/manifest.ts. Выложить новую версию и запустить. | — |
| **Плашка — установка** `electron-splash-installing` | «Устанавливаем…» — бегущая полоса, затем перезапуск. Обновление скачано. | Без вопросов установщика (тихо). | T58 | — | desktop/src/shell/splash.js, update/updater.ts. После загрузки. | — |
| **Плашка — сбой** `electron-splash-failed` | Причина одной строкой, «Повторить» и «Открыть Cord». Сервер не ответил, подпись не сошлась, минута тишины. | Открыть старую версию можно всегда — человек не заперт. | T58 | — | desktop/src/shell/splash.js, update/splash-flow.ts. Обрыв сети во время загрузки. | — |

## Клиент Windows

Приложение на Electron (E01-B): окна оболочки всегда тёмные и рисуются до веба; внутри окна — тот же веб Cord через мост v2. [Страница в Figma](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=1-2).

### Окна оболочки

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Окно — загрузка интерфейса** `electron-loading` | Знак Cord «дышит», пока с сервера грузится веб. После плашки обновления. | Тёмное всегда: тема человека ещё не прочитана. | T55 | — | desktop/src/shell/loading.html, main/windows/main.ts. Запуск клиента. | — |
| **Окно — нет связи с сервером** `electron-offline` | «Cord не смог открыть <сервер>» и «Повторить». Сервер недоступен при запуске. | Повтор — сам, когда вернулась сеть (событие online). | T50 | — | desktop/src/shell/offline.html, offline.js. Запустить без сети. | — |
| **Серверы** `electron-servers` | Флаг страны в круге, имя, пинг; выбранный — полоской слева. Меню клиента → «Серверы». | Только каталог Cord, без ручного адреса (T05); смена закрывает текущую встречу. | T05 | — | desktop/src/shell/servers.html, servers.js, main/catalog.ts. Меню → «Серверы». | — |
| **Оверлей поверх игры** `electron-overlay` | Полупрозрачный список участников в углу экрана; говорящие — ступенями громкости. Во встрече, когда открыта игра (флаг overlay). | Без инъекций в игру; не чаще 10 раз в секунду. | T23 | — | desktop/src/shell/overlay.html, overlay.js, main/windows/overlay.ts. Встреча + полноэкранная игра. | — |

### Веб внутри клиента

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Главная в клиенте на Electron** `electron-home` | Веб Cord целиком в окне клиента (мост v2); заголовок окна — свой, кнопки окна рисует Windows. Запуск клиента после обновления. | ПКМ — меню Cord, а не браузера (T42); панель избранного — веба. | T28, T39, T42, T53 | весь набор | ui/Home.tsx, ui/home/HomeShell.tsx, core/desktop.ts. Открыть Cord в клиенте. | — |
| **Настройки — «Windows» (клиент)** `settings-desktop` | Раздел только в приложении: трей, кнопки на миниатюре, значок, мигание, сон, оверлей и его сочетание, автозапуск. Клиент на Electron: «Настройки» → «Windows» (E01-B2). | Строки — по флагам оболочки; значения живут в оболочке (app.settings), сочетание оверлея — в профиле. | T27, T23, T15 | Switch, Button | ui/settings/DesktopSection.tsx, ui/settings/sections.ts, core/desktop.ts. Клиент → «Настройки» → «Windows». | — |
| **Настройки — «Оверлей» (клиент)** `settings-overlay` | Раздел только в приложении (R62, R63, R104): «Оверлей в играх» — переключатель, клавиши показа и разблокировки; «Игры» — запущенная сейчас и запомненные, у каждой свой переключатель и «Забыть»; «Говорящие» — живой образец виджета, положение, размер, имена, прозрачность. Клиент Windows: «Настройки» → «Оверлей». | Каждая строка — только при своём флаге оболочки; игры Cord запоминает сам, когда их запускают во время встречи. | R62, R63, R104 | Switch, Segmented, Slider, Menu, Button | ui/settings/OverlaySection.tsx, core/desktop-games.ts, core/desktop-settings.ts. Клиент → «Настройки» → «Оверлей». | — |
| **Показ экрана — окно показа (клиент)** `capture-picker` | В клиенте Windows — единственное окно показа, веб (своё окно выбора источника оболочка не рисует с 1.0.6, R60): вкладки «Приложения · Весь экран · Устройства», плитки с миниатюрами; внизу «Звук компьютера» и сводка, «Чёткость / Плавность», шестерёнка (качество 720 / 1080 / 1440 и 30 / 60, превью зрителям, режим звука) и одна кнопка «Показать»; выбор уходит оболочке, и только потом getDisplayMedia. «Показать экран» в пульте внутри клиента (E01-B2, флаг capture). | Только известные id источников и картинки data:image; «Устройства» — камеры, кроме своей (карта захвата — со своим звуком); выбор помнится (preferences.screen); без выбора — отмена без ошибки. | T10, R60, R80, R95 | Dialog, Tabs, Segmented, Popover, Switch, Button | ui/CapturePicker.tsx, core/desktop-capture.ts, media/capture.ts, ui/CallDock.tsx. Клиент → встреча → «Показать экран». | — |
| **Главная в клиенте WinUI (прежний)** `desktop-home` | Веб внутри прежнего клиента WinUI: боковую панель рисует клиент. Старый клиент (WebView2), до E01-B. | Уходит вместе с клиентом WinUI (В-2). | T39 | — | ui/DesktopHome.tsx, desktop-home.css. Клиент WinUI. | — |
| **Настройки избранной комнаты (WinUI)** `desktop-favorite-settings` | Окно настроек комнаты из панели прежнего клиента. Клиент WinUI → настройки комнаты. | Уходит вместе с клиентом WinUI. | — | Dialog | ui/FavoriteSettings.tsx. Клиент WinUI. | — |

## Telegram

Mini App (E09): кнопка в беседе открывает встречу на весь экран Telegram; создатель встречи привязывает беседы в «Интеграциях». [Страница в Figma](https://www.figma.com/design/Lrzdrqv6gQsDafGfiQnDqU/?node-id=1-3).

### Mini App

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Mini App вне Telegram** `tg-outside` | /tg в обычном браузере: «Откройте из Telegram». Кто открыл ссылку Mini App не в Telegram. | Без формы входа: войти можно обычной ссылкой на встречу. | T04 | Logo, Card | web/tg.html, telegram/TelegramApp.tsx (Outside). Открыть /tg в браузере. | — |
| **Mini App — загрузка** `tg-loading` | Статичная загрузка tg.html в цветах Telegram, пока идут связь, вход и проверка микрофона. Нажал «Открыть встречу» в беседе. | Цвета шапки и фона — до ready(), заставка Telegram сменяется без шва. | T04, T55 | — | web/tg.html, telegram/sdk.ts, telegram/theme.ts. Кнопка в беседе; для снимка бандл не отдаётся. | — |
| **Mini App — отказ** `tg-failed` | Экран ошибки с текстом кода: «Повторить» / «Закрыть». Не участник беседы, привязка отозвана, встреча закрыта (TELEGRAM_*). | На ALREADY_IN_MEETING — «Выйти оттуда и войти сюда». | T04, T52 | Button | telegram/TelegramApp.tsx (failed), services/cord_services/webapp.py. Открыть кнопку чужой беседы. | — |
| **Mini App — нет микрофона** `tg-media` | Микрофон запрещён или его нет: объясняем и даём войти слушателем. Запрет микрофона в Telegram или на телефоне. | Войти можно без микрофона. | T04 | Button | telegram/TelegramApp.tsx (media), telegram/media-probe.ts. Запретить микрофон Telegram. | — |
| **Mini App — встреча, подсказка о фоне** `tg-meeting-note` | Встреча в Telegram и подсказка: разговор держится, пока Telegram открыт. Первый вход из Telegram на этом устройстве. | Ссылку можно скопировать и открыть встречу в браузере для разговора в фоне. | T04, T16 | Button | ui/BackgroundNote.tsx, telegram/telegram.css. Кнопка в беседе. | — |
| **Mini App — встреча** `tg-meeting` | Та же встреча, что в браузере, на весь экран Telegram; «Назад» Telegram закрывает панели. Нажал «Открыть встречу» в беседе. | Отступы — безопасные зоны Telegram; имя — из Telegram, без поля «Ваше имя». | T04 | весь набор | telegram/TelegramApp.tsx, telegram/telegram.css, ui/MeetingView.tsx. Кнопка в беседе. | — |

### Привязка беседы

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Интеграции → Telegram** `integrations-telegram` | Создатель привязывает беседу: команда, «Добавить бота в группу», список бесед с отвязкой. Создатель встречи: «Интеграции» → Telegram (внизу). | Подключить может только создатель (T30); остальным — «Подключит создатель встречи». | T04, T30 | Card, Button | ui/TelegramGroup.tsx, ui/Services.tsx. «Интеграции» → Telegram. | — |

## Телефон

Разговор на телефоне (E12): честные подсказки о фоне для каждой платформы, «Свернуть в окно», Cord на экране «Домой». Телефонная ширина 360 есть у каждого экрана на других страницах. [Страница в Figma](https://www.figma.com/design/iCNC53lDOA6gJDSjsl7sh4/?node-id=0-1).

### Разговор в фоне

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **Android — разговор в фоне** `background-android` | Один раз на устройстве: можно свернуть браузер — пока в шторке «использует микрофон», разговор идёт. Вошёл во встречу с Android. | Через 3 с после подключения; ошибка медиа важнее подсказки. | T16 | IconButton | ui/BackgroundNote.tsx, media/background.ts, media/platform.ts. Встреча с Android. | — |
| **iPhone, Safari — разговор в фоне** `background-ios` | Свернуть Safari можно, пока горит оранжевая точка; камера в фоне выключается; «Свернуть в окно» — в меню. Вошёл с iPhone в Safari. | Честно о том, что прервёт разговор (звонок, закрытие Safari). | T16 | IconButton | ui/BackgroundNote.tsx, media/background.ts. Встреча с iPhone. | — |
| **iPhone, «Домой» — фона нет** `background-ios-home` | С экрана «Домой» iPhone глушит микрофон при уходе: подсказка и «Скопировать ссылку» для Safari. Cord, установленный на экран «Домой». | Ссылка копируется, а не открывается — откроется в том же окне. | T16 | Button | ui/BackgroundNote.tsx, media/platform.ts. Cord с экрана «Домой» на iPhone. | — |
| **Телефон — без микрофона** `background-no-mic` | Без доступа к микрофону телефон может прервать разговор в фоне: разрешите микрофон, выключенный он ничего не передаёт. Телефон с запрещённым микрофоном. | Выключенный кнопкой микрофон держит разговор в фоне (holdMicrophone). | T16 | IconButton | ui/BackgroundNote.tsx, media/background.ts. Запретить микрофон и войти. | — |
| **Телефон — «Свернуть в окно»** `meeting-more-phone` | Меню пульта на телефоне: панели, раскладка и «Свернуть в окно» — собеседник поверх других приложений. «…» в пульте на телефоне. | Картинка в картинке — свой видеоряд, смена говорящего не чаще раза в 3 с. | T16 | Menu | ui/CallDock.tsx, media/pip.ts, media/system-controls.ts. «…» в пульте. | — |

### Главная на телефоне

| Состояние | Что это · кто и откуда | Правила и состояния | Задачи | Набор | Исходники · как открыть | Figma |
| --- | --- | --- | --- | --- | --- | --- |
| **iPhone — «Cord на экране „Домой“»** `install-hint-ios` | Подсказка установки на главной iPhone с предупреждением про фон. Главная в Safari на iPhone. | В приложении Cord и в Telegram не показывается. | T16 | Card | ui/InstallHint.tsx. Главная на iPhone. | — |

## Чего здесь нет и почему

- **Музыка — плеер, найденное и «Сейчас играет»**: вкладки площадок, поиск и плеер появляются, когда музыку добавили
  во встречу (R44: экрана выбора площадки больше нет). Кадры музыки в Figma сняты ещё до R44 и без бота — он держит
  комнату на стенде открытой; рецепт `figma-screens.mjs` теперь добавляет музыку и в конце убирает её.
- **Новые состояния без кадров**: «Музыка — ещё не во встрече», «Сообщить о проблеме», «Оверлей» в настройках клиента —
  в каталоге и с рецептом, ряды в Figma появятся при следующей съёмке.
- **«Встреча завершится в …»** (E11-B): `endsAt` ядро присылает только за 15 минут до 24-часового потолка; подставить
  его в снимок встречи не удалось — ряд с описанием без кадров.
- **Окно показа в клиенте Windows** (`capture-picker`, R60): ему нужна встреча в клиенте — ряд с описанием; своего
  окна «Что показать» у оболочки нет с 1.0.6, его ряды в Figma (`electron-picker-*`) устарели и убираются там.
- **Игровые листы и окна** (настройки стола, счёт, итог партии, превращение пешки, реакции), установщик Windows и
  уведомление Android-приложения — не сняты (нет повторяемого рецепта / не веб).
